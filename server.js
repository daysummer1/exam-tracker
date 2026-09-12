/**
 * 每周考试成绩追踪 — 多用户同步服务器（零依赖，纯 Node.js）
 *
 * 权限模型：
 * - 用户登录（用户名+密码，sha256(salt+password) 存储），签发 HMAC token
 * - 普通成员：只能增/改/删自己的数据（服务端强制校验）；所有人的数据可见
 * - 管理员：可编辑所有人的数据、修改满分设置、管理用户（添加/删除/重置密码）、审批自主注册申请
 * - 自主注册：访客可提交注册申请（用户名按姓名拼音首字母生成），须管理员审批通过后才能登录
 * - 默认管理员：admin / admin123（请登录后尽快在用户管理中重置密码）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DIR = __dirname;
/* 数据目录：优先使用外部目录（环境变量 DATA_DIR），重新发布/更新代码时不会覆盖用户数据 */
const DATA_DIR = process.env.DATA_DIR || DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
/* 照片独立目录：错题照片不再以 base64 内嵌在 data.json 里，单独存成图片文件 */
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); } catch (e) {}
const PHOTO_NAME_RE = /^ph_[a-f0-9]+\.(jpg|jpeg|png|webp)$/;

/* 首次切换到外部数据目录时，迁移本地已有数据 */
if (DATA_DIR !== DIR && !fs.existsSync(DATA_FILE) && fs.existsSync(path.join(DIR, 'data.json'))) {
  try { fs.copyFileSync(path.join(DIR, 'data.json'), DATA_FILE); console.log('📦 已迁移历史数据到', DATA_FILE); } catch (e) {}
}
if (DATA_DIR !== DIR && !fs.existsSync(CONFIG_FILE) && fs.existsSync(path.join(DIR, 'config.json'))) {
  try { fs.copyFileSync(path.join(DIR, 'config.json'), CONFIG_FILE); } catch (e) {}
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = n => crypto.randomBytes(n).toString('hex');

/* ---------- 配置（HMAC 密钥） ---------- */
let config;
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {}
if (!config || !config.secret) {
  config = { secret: rand(16) };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/* ---------- 数据库 ---------- */
/* 结构: { users:[{username,name,role,salt,pwhash}], exams:[], wrongs:[], tracks:[], full:{...} } */
let db = null;
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // 兼容旧版单用户结构 {version, data:{exams...}}
  const src = d && d.data ? d.data : d;
  if (src && (Array.isArray(src.exams) || Array.isArray(src.users))) db = src;
} catch (e) {}

function initDb() {
  if (!db || !Array.isArray(db.users) || !db.users.length) {
    const salt = rand(8);
    db = {
      users: [{ username: 'admin', name: '管理员', role: 'admin', salt, pwhash: sha(salt + 'admin123') }],
      exams: [], wrongs: [], tracks: [],
      full: { chinese: 100, math: 100, english: 100 }
    };
  }
  ['exams', 'wrongs', 'tracks'].forEach(k => {
    if (!Array.isArray(db[k])) db[k] = [];
    db[k].forEach(r => { if (!r.owner) r.owner = 'admin'; });
  });
  if (!db.full || typeof db.full !== 'object') db.full = { chinese: 100, math: 100, english: 100 };
  ['chinese', 'math', 'english'].forEach(k => { if (!db.full[k]) db.full[k] = 100; });
  /* 站点设置：是否允许自主注册（默认开启）与待审批的注册申请 */
  if (!db.settings || typeof db.settings !== 'object') db.settings = { allowSignup: true };
  if (typeof db.settings.allowSignup !== 'boolean') db.settings.allowSignup = true;
  if (!Array.isArray(db.registrations)) db.registrations = [];
  /* 学校 / 年级：老数据补齐字段（学生默认六年级，管理员不设年级） */
  db.users.forEach(u => {
    if (typeof u.school !== 'string') u.school = '';
    if (u.grade === undefined) {
      if (u.role === 'admin') { u.grade = ''; u.gradeYear = 0; }
      else { u.grade = DEFAULT_GRADE; u.gradeYear = acadYearStart(); }
    }
    if (gradeIndex(u.grade) >= 0 && !u.gradeYear) u.gradeYear = acadYearStart();
  });
}
/* 持久化 + 滚动备份（保留最近 5 份），误操作可回滚 */
function persist() {
  try {
    for (let i = 4; i >= 1; i--) {
      const s = path.join(DATA_DIR, `data.backup.${i}.json`);
      const t = path.join(DATA_DIR, `data.backup.${i + 1}.json`);
      if (fs.existsSync(s)) fs.copyFileSync(s, t);
    }
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, path.join(DATA_DIR, 'data.backup.1.json'));
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error('persist fail', e); }
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

/* ---------- 照片文件存储 ---------- */
/* 错题照片独立存储在 PHOTOS_DIR，data.json 中只保存文件名（ph_xxx.jpg） */
const PHOTO_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
/* 把一段 dataURL 保存为照片文件，返回文件名；失败返回空串 */
function storePhotoData(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return '';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 4 * 1024 * 1024) return '';
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  let name = 'ph_' + rand(8) + '.' + ext, tries = 0;
  while (fs.existsSync(path.join(PHOTOS_DIR, name)) && tries++ < 5) name = 'ph_' + rand(8) + '.' + ext;
  try { fs.writeFileSync(path.join(PHOTOS_DIR, name), buf); return name; } catch (e) { return ''; }
}
/* 把记录里的照片统一规范成文件名（兼容 base64 老数据与 file: 前缀） */
function normalizeWrongPhotos(rec) {
  if (!Array.isArray(rec.photos)) { rec.photos = []; return; }
  rec.photos = rec.photos.map(p => {
    if (typeof p !== 'string') return '';
    if (p.startsWith('file:')) p = p.slice(5);
    if (p.startsWith('data:image/')) return storePhotoData(p);   // 老客户端/迁移数据兜底
    return PHOTO_NAME_RE.test(p) ? p : '';
  }).filter(Boolean).slice(0, 20);   /* 服务端同样限制每题最多 20 张 */
}
/* 启动迁移：把历史数据中内嵌的 base64 照片搬到 photos/ 目录 */
function migratePhotosToFiles() {
  let moved = 0;
  (db.wrongs || []).forEach(w => {
    if (!Array.isArray(w.photos)) { w.photos = []; return; }
    w.photos = w.photos.map(p => {
      if (typeof p !== 'string') return '';
      if (!p.startsWith('data:image/')) return PHOTO_NAME_RE.test(p) ? p : '';
      const n = storePhotoData(p);
      if (n) moved++;
      return n;
    }).filter(Boolean);
  });
  if (moved) { persist(); console.log('🖼️ 已迁移 ' + moved + ' 张内嵌照片到 ' + PHOTOS_DIR); }
}
/* 清理孤儿照片：未被任何错题引用、且已上传超过 24 小时（给"上传后未保存"留缓冲） */
function gcPhotos() {
  try {
    const ref = new Set();
    (db.wrongs || []).forEach(w => (w.photos || []).forEach(p => {
      if (typeof p === 'string' && !p.startsWith('data:')) ref.add(p.replace(/^file:/, ''));
    }));
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let n = 0;
    fs.readdirSync(PHOTOS_DIR).forEach(f => {
      if (!PHOTO_NAME_RE.test(f) || ref.has(f)) return;
      const fp = path.join(PHOTOS_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); n++; } } catch (e) {}
    });
    if (n) console.log('🧹 已清理 ' + n + ' 张未被引用的照片');
  } catch (e) {}
}
let gcTimer = 0;
function gcPhotosSoon() { const now = Date.now(); if (now - gcTimer < 5 * 60 * 1000) return; gcTimer = now; gcPhotos(); }

/* ---------- 用户与认证 ---------- */
/* ---------- 学校 / 年级 ---------- */
/* 学级序列：小学 1-6 年级 → 初中 3 年 → 高中 3 年 */
const GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三'];
const DEFAULT_GRADE = '六年级';          // 新用户默认年级（另一个常用年级为「初一」）
/* 学年起点：每年 9 月 1 日。例：2026-09 ~ 2027-08 属于 2026 学年 */
function acadYearStart(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}
function gradeIndex(g) { return GRADES.indexOf(String(g || '')); }
/* 升 n 级（到顶后保持高三） */
function advanceGrade(grade, n) {
  const i = gradeIndex(grade);
  if (i < 0) return '';
  return GRADES[Math.min(i + Math.max(0, n | 0), GRADES.length - 1)];
}
/* 实际年级 = 录入时年级 + 已经过的学年数（跨学年自动升级） */
function effectiveGrade(u) {
  if (gradeIndex(u.grade) < 0) return '';
  const y0 = +u.gradeYear || acadYearStart();
  return advanceGrade(u.grade, acadYearStart() - y0);
}
/* 学年自动升级：把过期的年级落库（每次请求前调用，确保数据一致） */
function promoteUsers() {
  const ay = acadYearStart();
  let changed = false;
  (db.users || []).forEach(u => {
    if (gradeIndex(u.grade) < 0) return;                 // 未设置年级：不处理
    const eff = effectiveGrade(u);
    if (eff !== u.grade) { u.grade = eff; u.gradeYear = ay; changed = true; }
    else if (!u.gradeYear) { u.gradeYear = ay; changed = true; }   // 老数据补齐基准学年
  });
  if (changed) persist();
  return changed;
}

function makeUser(username, name, password, role, extra) {
  const salt = rand(8);
  const u = { username, name, role, school: '', grade: '', gradeYear: 0, salt, pwhash: sha(salt + password) };
  const e = extra || {};
  if (typeof e.school === 'string') u.school = e.school.trim().slice(0, 30);
  /* 管理员（家长/老师）默认不设年级；学生默认六年级 */
  const g = gradeIndex(e.grade) >= 0 ? e.grade : (role === 'admin' ? '' : DEFAULT_GRADE);
  u.grade = g; u.gradeYear = g ? acadYearStart() : 0;
  return u;
}
function findUser(username) { return db.users.find(u => u.username === username); }

/* 初始化数据库 + 启动时按学年自动升级（跨 9/1 后重启即生效） */
initDb();
promoteUsers();
migratePhotosToFiles();   /* 老数据中内嵌的照片迁移为独立文件 */
gcPhotos();               /* 清理历史孤儿照片 */
setInterval(gcPhotos, 6 * 3600 * 1000);

function safeUser(u) {
  const ay = acadYearStart();
  const y0 = +u.gradeYear || ay;
  const g = effectiveGrade(u);
  return {
    username: u.username, name: u.name, role: u.role,
    school: u.school || '', grade: g,
    gradeYear: y0,
    /* 下一次学年自动升级的时间与该次升到的年级（用于界面提示） */
    nextGradeDate: (y0 + 1) + '-09-01',
    nextGrade: gradeIndex(u.grade) >= 0 ? advanceGrade(u.grade, (ay - y0) + 1) : ''
  };
}
function sign(username) { return 't1.' + Buffer.from(username).toString('base64url') + '.' + crypto.createHmac('sha256', config.secret).update(username).digest('hex'); }
function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return '';
  const m = String(h).split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function auth(req) {
  /* 优先 x-auth 请求头；<img> 等标签无法带自定义头，允许同名 Cookie（登录时由前端写入） */
  const t = (typeof req.headers['x-auth'] === 'string' && req.headers['x-auth']) || getCookie(req, 'x_auth');
  if (!t) return null;
  const parts = t.split('.');
  if (parts.length !== 3 || parts[0] !== 't1') return null;
  let username;
  try { username = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch (e) { return null; }
  const expect = crypto.createHmac('sha256', config.secret).update(username).digest('hex');
  if (parts[2] !== expect) return null;
  const u = findUser(username);
  return u ? { ...u } : null;
}

/* ---------- 权限 ---------- */
function canEdit(user, owner) { return user.role === 'admin' || user.username === owner; }

/* ---------- 工具 ---------- */
const KINDS = ['exams', 'wrongs', 'tracks'];
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', size = 0;
    req.on('data', c => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function visibleState(user) {
  /* 始终读取数据库中的最新用户对象（auth 返回的是快照，资料/年级可能刚被修改或升级） */
  const fresh = findUser(user.username) || user;
  const isAdmin = fresh.role === 'admin';
  /* 权限：所有人可查看全部记录与学情（写入仍受 owner 限制，服务端强制） */
  const out = { ok: true, user: safeUser(fresh),
    exams: db.exams, wrongs: db.wrongs, tracks: db.tracks,
    full: db.full, settings: { allowSignup: db.settings.allowSignup !== false, ocr: ocrStatus() } };
  /* 用户名册：管理员全量真实姓名；成员全员可见，但他人姓名以用户名（首字母）显示，学校/年级保留（供对比与年级分析） */
  out.users = db.users.map(u => {
    const su = safeUser(u);
    if (!isAdmin && u.username !== fresh.username) su.name = su.username;
    return su;
  });
  if (isAdmin) {
    // 待审批注册申请（不含密码哈希等敏感字段）
    out.registrations = (db.registrations || []).map(r => ({
      id: r.id, username: r.username, name: r.name, createdAt: r.createdAt,
      school: r.school || '', grade: r.grade || ''
    }));
  }
  return out;
}

/* ---------- 静态文件 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- OCR（题目照片文字识别）：智谱 GLM-4V-Flash / 腾讯云手写体 OCR ---------- */
const OCR_PROMPT = '这是学生错题的照片。请把照片中的题目文字完整转写出来，要求：\n1. 按原题顺序转写，保留题号、小问编号和选项标号（A. B. C. D.）；\n2. 数学式子用易读写法：平方写 ^2，分数写 a/b，根号写 √，角度用 ∠，全等/相似用文字表述；\n3. 忽略照片中所有手写字迹（学生的作答、订正、批注、划线痕迹），只转写印刷的题目内容；\n4. 若题中含几何图形、函数图象、统计图表等插图，在对应位置用一行【图：××图】简要标注（如【图：三角形ABC，D为BC中点】），不必详述图形；\n5. 只输出题目内容本身，不要任何解释、点评或前后缀；\n6. 若照片模糊或不是题目，只输出：【无法识别】。';

function ocrCfg() {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  const o = db.settings.ocr || {};
  return {
    provider: process.env.OCR_PROVIDER || o.provider || '',
    zhipuKey: process.env.ZHIPU_API_KEY || o.zhipuKey || '',
    tcSecretId: process.env.TENCENT_SECRET_ID || o.tcSecretId || '',
    tcSecretKey: process.env.TENCENT_SECRET_KEY || o.tcSecretKey || '',
    xkbKey: process.env.XKB_API_KEY || db.settings.xkbKey || ''
  };
}
function ocrConfigured() {
  const c = ocrCfg();
  return (c.provider === 'zhipu' && !!c.zhipuKey) || (c.provider === 'tencent' && !!c.tcSecretId && !!c.tcSecretKey);
}
function ocrStatus() {
  const c = ocrCfg();
  return { provider: c.provider, configured: ocrConfigured(), xkbConfigured: !!c.xkbKey };
}

function httpPostJson(host, p, headers, bodyObj, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = https.request({ hostname: host, path: p, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers), timeout }, x => {
      const s = []; x.on('data', c => s.push(c)); x.on('end', () => resolve({ code: x.statusCode, buf: Buffer.concat(s) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('OCR 请求超时')); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function ocrZhipu(mime, b64) {
  const c = ocrCfg();
  const r = await httpPostJson('open.bigmodel.cn', '/api/paas/v4/chat/completions',
    { Authorization: 'Bearer ' + c.zhipuKey },
    {
      model: 'glm-4v-flash',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
        { type: 'text', text: OCR_PROMPT }
      ] }],
      temperature: 0.1, max_tokens: 1024
    });
  let j = null; try { j = JSON.parse(r.buf); } catch (e) {}
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) {
    const msg = j && j.error && j.error.message;
    throw new Error('智谱接口异常: HTTP ' + r.code + (msg ? ' ' + msg : ' ' + r.buf.slice(0, 120)));
  }
  return String(txt).trim();
}

const POLISH_PROMPT = '下面是从错题照片 OCR 转写的题目文字。请把它整理成规范的标准题面：\n1. 修正错别字和 OCR 识别错误（如数字被写成汉字、断句错误、漏字），依据上下文补全明显缺失的字词，但不得改变题意、不得添加题目中不存在的条件或数据；\n2. 数学式子用规范写法：平方写 ^2，分数写 a/b，根号写 √，角度用 ∠；\n3. 保留题号、小问编号和选项标号（A. B. C. D.）；\n4. 题目中的空括号（ ）、横线____等填空处必须保持空白原样，绝对不要推理或填写答案进去；\n5. 【图：××图】标注原样保留，位置不变；\n6. 适当分段排版；\n7. 只输出整理后的题面本身，不要任何解释、点评或前后缀。';

async function polishText(raw) {
  const c = ocrCfg();
  if (c.provider !== 'zhipu' || !c.zhipuKey) throw new Error('文字重排需要智谱通道');
  const r = await httpPostJson('open.bigmodel.cn', '/api/paas/v4/chat/completions',
    { Authorization: 'Bearer ' + c.zhipuKey },
    {
      model: 'glm-4-flash',
      messages: [
        { role: 'system', content: POLISH_PROMPT },
        { role: 'user', content: raw }
      ],
      temperature: 0.1, max_tokens: 1024
    });
  let j = null; try { j = JSON.parse(r.buf); } catch (e) {}
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) {
    const msg = j && j.error && j.error.message;
    throw new Error('重排接口异常: HTTP ' + r.code + (msg ? ' ' + msg : ' ' + r.buf.slice(0, 120)));
  }
  return String(txt).trim();
}

/* ---------- 学库宝题库搜题 ---------- */
const GRADE_ID = { '一年级':'110','二年级':'120','三年级':'130','四年级':'140','五年级':'150','六年级':'160','七年级':'200','八年级':'300','九年级':'400','初一':'200','初二':'300','初三':'400','高一':'500','高二':'600','高三':'700' };
const SUBJECT_ID = { chinese:'1', math:'2', english:'3' };
function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim(); }
function xkbScore(kw, cand) {
  const t = kw.replace(/[\s，。、：；！？（）()【】\[\].,;:!?'"“”‘’\-\\]/g, '');
  if (t.length < 4) return 0;
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  let hit = 0;
  for (const g of set) if (cand.includes(g)) hit++;
  return hit / Math.sqrt(set.size);
}
async function xkbSearch(text, grade, subject) {
  const c = ocrCfg();
  if (!c.xkbKey) throw new Error('题库搜题未配置 Key');
  const gradeId = GRADE_ID[grade];
  if (!gradeId) return { found: false, reason: '年级「' + grade + '」暂不支持搜题' };
  const cleanKw = String(text || '').replace(/【图：[^】]*】/g, ' ').replace(/\s+/g, ' ').trim();
  const bodyObj = { keyword: cleanKw.slice(0, 80), gradeId };
  const sid = SUBJECT_ID[subject];
  if (sid) bodyObj.subjectId = sid;
  const r = await httpPostJson('api.xuekubao.com', '/api/v1/search', { 'X-API-Key': c.xkbKey }, bodyObj, 30000);
  let outer = null; try { outer = JSON.parse(r.buf); } catch (e) {}
  if (!outer || outer.errorCode !== '0') throw new Error('搜题接口异常 HTTP ' + r.code + ' ' + (outer && outer.message || r.buf.slice(0, 80)));
  let list = outer.data;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  if (!Array.isArray(list) || !list.length) return { found: false, reason: '题库未找到匹配题目' };
  let best = null, bestScore = 0;
  for (const q of list.slice(0, 30)) {
    const cand = stripHtml([q.title, q.option_a, q.option_b, q.option_c, q.option_d].join(' '));
    const s = xkbScore(text, cand);
    if (s > bestScore) { bestScore = s; best = q; }
  }
  if (!best || bestScore < 0.6) return { found: false, reason: '匹配度不足（最高 ' + bestScore.toFixed(2) + '）' };
  const html = String(best.title || '');
  const imgs = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi; let m;
  while ((m = re.exec(html))) imgs.push(m[1]);
  return {
    found: true,
    html,
    options: { a: best.option_a || '', b: best.option_b || '', c: best.option_c || '', d: best.option_d || '', e: best.option_e || '' },
    source: best.source || '', gradeName: best.gradeName || '', subjectName: best.subjectName || '',
    qtype: best.qtpye || '', md52: best.md52 || '', imgs, score: +bestScore.toFixed(2)
  };
}

/* 腾讯云 TC3-HMAC-SHA256 签名（零依赖实现） */
async function ocrTencent(b64) {
  const c = ocrCfg();
  const service = 'ocr', host = 'ocr.tencentcloudapi.com';
  const action = 'GeneralHandwritingOCR', version = '2018-11-19';
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({ ImageBase64: b64 });
  const hashedBody = crypto.createHash('sha256').update(payload).digest('hex');
  const canonical = 'POST\n/\n\ncontent-type:application/json\nhost:' + host + '\n\ncontent-type;host\n' + hashedBody;
  const str2sign = 'TC3-HMAC-SHA256\n' + ts + '\n' + date + '/' + service + '/tc3_request\n' + crypto.createHash('sha256').update(canonical).digest('hex');
  const kDate = crypto.createHmac('sha256', 'TC3' + c.tcSecretKey).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const sig = crypto.createHmac('sha256', kSigning).update(str2sign).digest('hex');
  const r = await httpPostJson(host, '/', {
    Authorization: 'TC3-HMAC-SHA256 Credential=' + c.tcSecretId + '/' + date + '/' + service + '/tc3_request, SignedHeaders=content-type;host, Signature=' + sig,
    'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': String(ts), Host: host
  }, JSON.parse(payload));
  let j = null; try { j = JSON.parse(r.buf); } catch (e) {}
  if (j && j.Response && j.Response.Error) throw new Error('腾讯云OCR: ' + j.Response.Error.Message + '（' + j.Response.Error.Code + '）');
  const items = j && j.Response && j.Response.TextDetections;
  if (!items) throw new Error('腾讯云OCR返回异常: HTTP ' + r.code);
  return items.map(t => t.DetectedText).join('\n').trim();
}

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    /* 登录（无需认证） */
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const uname = String(body.username || '').trim();
      const u = findUser(uname);
      if (!u) {
        // 未通过审批的注册申请给出明确提示
        const pending = (db.registrations || []).find(r => r.username === uname);
        if (pending) return json(res, 403, { error: '注册申请正在等待管理员审批，通过后即可登录' });
        return json(res, 401, { error: '用户名或密码错误' });
      }
      if (u.pwhash !== sha(u.salt + String(body.password || ''))) return json(res, 401, { error: '用户名或密码错误' });
      return json(res, 200, { ok: true, token: sign(u.username), user: safeUser(u) });
    }

    /* 站点公开设置（无需认证）：登录页据此决定是否展示注册入口 */
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, { ok: true, allowSignup: db.settings.allowSignup !== false });
    }

    /* 自主注册（无需认证）：提交申请，等管理员审批 */
    if (url.pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      if (db.settings.allowSignup === false) return json(res, 403, { error: '当前未开放自主注册，请联系管理员开通账号' });
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      let username = String(body.username || '').trim().toLowerCase();
      if (!name) return json(res, 400, { error: '请填写姓名' });
      if (name.length > 20) return json(res, 400, { error: '姓名过长（最多 20 字）' });
      if (!/^[a-z0-9_]{2,20}$/.test(username)) username = '';   // 非法则退回自动生成
      if (!username) username = 'u' + crypto.randomBytes(3).toString('hex');
      if (password.length < 4) return json(res, 400, { error: '密码至少 4 位' });
      const school = String(body.school || '').trim().slice(0, 30);
      const grade = gradeIndex(body.grade) >= 0 ? String(body.grade) : DEFAULT_GRADE;
      if (findUser(username)) return json(res, 400, { error: '用户名「' + username + '」已被占用，请换一个' });
      const dup = (db.registrations || []).find(r => r.username === username);
      if (dup) return json(res, 409, { error: '用户名「' + username + '」已有待审批的申请，请更换或等待审批' });
      const reg = Object.assign(
        { id: 'reg' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), createdAt: Date.now() },
        makeUser(username, name, password, 'member', { school, grade })
      );
      db.registrations.push(reg);
      persist();
      return json(res, 200, { ok: true, pending: true, username, name, school, grade });
    }

    /* 以下均需登录 */
    const user = auth(req);
    if (url.pathname.startsWith('/api/')) {
      if (!user) return json(res, 401, { error: '未登录或登录已失效，请重新登录' });

      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, visibleState(user));

      /* 上传错题照片：body { data: dataURL }，落盘为独立文件，返回文件名 */
      if (url.pathname === '/api/photo' && req.method === 'POST') {
        const body = await readBody(req);
        const name = storePhotoData(body.data);
        if (!name) return json(res, 400, { error: '照片数据无效或超过 4MB' });
        return json(res, 200, { ok: true, name });
      }

      /* 读取照片文件（需登录；文件名全局唯一可永久缓存）。
         校验：照片必须被至少一条错题引用（所有人可查看全部错题，故不再限本人），防止窥看孤儿文件 */
      const pm = url.pathname.match(/^\/api\/photo\/([a-z0-9_]+\.(?:jpg|jpeg|png|webp))$/);
      if (pm && req.method === 'GET') {
        const fp = path.join(PHOTOS_DIR, pm[1]);
        if (!fp.startsWith(PHOTOS_DIR) || !PHOTO_NAME_RE.test(pm[1]) || !fs.existsSync(fp)) {
          return json(res, 404, { error: '照片不存在' });
        }
        if (!db.wrongs.some(w => Array.isArray(w.photos) && w.photos.includes(pm[1]))) {
          return json(res, 404, { error: '照片不存在' });
        }
        const buf = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': PHOTO_MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
        return res.end(buf);
      }

      /* 题目照片 OCR：任何登录用户可用；输入 dataURL 或已存照片文件名 */
      /* 题库搜题代理（key 只存服务端） */
      if (url.pathname === '/api/ocr/search' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text || text === '【无法识别】') return json(res, 400, { error: '没有可搜题的文字' });
        try {
          const r = await xkbSearch(text, String(body.grade || ''), String(body.subject || ''));
          return json(res, 200, r);
        } catch (e) {
          return json(res, 502, { error: '搜题失败：' + (e.message || e) });
        }
      }

      /* 题库配图代理（转给浏览器，带登录鉴权） */
      if (url.pathname === '/api/xkbimg' && req.method === 'GET') {
        const target = url.searchParams.get('url') || '';
        if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: '无效图片地址' });
        try {
          const rr = await fetch(target, { signal: AbortSignal.timeout(20000) });
          if (!rr.ok) return json(res, 502, { error: '图片拉取失败 HTTP ' + rr.status });
          const ct = rr.headers.get('content-type') || 'image/jpeg';
          if (!/^image\//i.test(ct)) return json(res, 400, { error: '非图片内容' });
          const ab = await rr.arrayBuffer();
          if (ab.byteLength > 4 * 1024 * 1024) return json(res, 413, { error: '图片过大' });
          res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'private, max-age=86400' });
          return res.end(Buffer.from(ab));
        } catch (e) {
          return json(res, 502, { error: '图片拉取失败：' + (e.message || e) });
        }
      }

      if (url.pathname === '/api/ocr' && req.method === 'POST') {
        if (!ocrConfigured()) return json(res, 400, { error: 'OCR 未启用：请管理员在「数据管理 → OCR 设置」中配置识别通道' });
        const body = await readBody(req);
        /* AI 文字重排：把 OCR 原始文字整理成规范题面 */
        if (body.polish) {
          const raw = String(body.text || '').trim();
          if (!raw || raw === '【无法识别】') return json(res, 400, { error: '没有可重排的文字' });
          try {
            const text = await polishText(raw);
            return json(res, 200, { ok: true, text });
          } catch (e) {
            return json(res, 502, { error: 'AI 重排失败：' + (e.message || e) });
          }
        }
        let mime = 'image/jpeg', b64 = '';
        if (typeof body.data === 'string' && body.data.startsWith('data:image/')) {
          const m = body.data.match(/^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/);
          if (!m) return json(res, 400, { error: '图片数据无效' });
          mime = m[1]; b64 = m[2];
        } else if (typeof body.name === 'string' && PHOTO_NAME_RE.test(body.name)) {
          const fp = path.join(PHOTOS_DIR, body.name);
          if (!fs.existsSync(fp)) return json(res, 404, { error: '照片文件不存在' });
          b64 = fs.readFileSync(fp).toString('base64');
          mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(fp).toLowerCase()] || 'image/jpeg';
        } else return json(res, 400, { error: '缺少图片数据' });
        try {
          const c = ocrCfg();
          const text = (c.provider === 'tencent') ? await ocrTencent(b64) : await ocrZhipu(mime, b64);
          return json(res, 200, { ok: true, text: text || '【无法识别】' });
        } catch (e) {
          return json(res, 502, { error: 'OCR 调用失败：' + (e.message || e) });
        }
      }

      if (url.pathname === '/api/op' && req.method === 'POST') {        const body = await readBody(req);
        if (body.op === 'settings') {
          if (user.role !== 'admin') return json(res, 403, { error: '只有管理员可以修改满分设置' });
          const f = body.full || {};
          ['chinese', 'math', 'english'].forEach(k => { if (f[k] && +f[k] > 0) db.full[k] = +f[k]; });
          persist();
          return json(res, 200, visibleState(user));
        }
        if (body.op === 'signup') {
          if (user.role !== 'admin') return json(res, 403, { error: '只有管理员可以修改注册设置' });
          db.settings.allowSignup = !!body.allow;
          persist();
          return json(res, 200, visibleState(user));
        }
        if (body.op === 'ocrconfig') {
          if (user.role !== 'admin') return json(res, 403, { error: '只有管理员可以配置 OCR' });
          const o = db.settings.ocr = db.settings.ocr || {};
          o.provider = ['zhipu', 'tencent', ''].includes(body.provider) ? body.provider : '';
          if (body.zhipuKey !== undefined) o.zhipuKey = String(body.zhipuKey).trim();
          if (body.tcSecretId !== undefined) o.tcSecretId = String(body.tcSecretId).trim();
          if (body.tcSecretKey !== undefined) o.tcSecretKey = String(body.tcSecretKey).trim();
          if (body.xkbKey !== undefined) db.settings.xkbKey = String(body.xkbKey).trim();
          persist();
          return json(res, 200, visibleState(user));
        }
        const kind = body.kind;
        if (!KINDS.includes(kind)) return json(res, 400, { error: '无效的数据类型' });
        if (body.op === 'upsert') {
          const rec = body.record;
          if (!rec || typeof rec !== 'object' || !rec.id) return json(res, 400, { error: '缺少记录或 id' });
          const idx = db[kind].findIndex(x => x.id === rec.id);
          if (idx >= 0) {
            // 编辑已有记录：成员只能改自己的
            if (!canEdit(user, db[kind][idx].owner)) return json(res, 403, { error: '无权限修改他人的记录' });
            rec.owner = db[kind][idx].owner;
            rec.createdAt = db[kind][idx].createdAt;
          } else {
            // 新建：成员强制归属自己；管理员可指定归属
            rec.owner = user.role === 'admin' ? (rec.owner || user.username) : user.username;
            rec.createdAt = rec.createdAt || Date.now();
          }
          rec.updatedAt = Date.now();
          if (kind === 'wrongs') normalizeWrongPhotos(rec);   /* 照片统一存为文件，data.json 只留文件名 */
          if (idx >= 0) db[kind][idx] = rec; else db[kind].unshift(rec);
          persist();
          if (kind === 'wrongs') gcPhotosSoon();
          return json(res, 200, visibleState(user));
        }
        if (body.op === 'delete') {
          const idx = db[kind].findIndex(x => x.id === body.id);
          if (idx < 0) return json(res, 404, { error: '记录不存在' });
          if (!canEdit(user, db[kind][idx].owner)) return json(res, 403, { error: '无权限删除他人的记录' });
          db[kind].splice(idx, 1);
          persist();
          if (kind === 'wrongs') gcPhotosSoon();
          return json(res, 200, visibleState(user));
        }
        return json(res, 400, { error: '无效操作' });
      }

      /* 用户管理（仅管理员；成员仅可修改自己的学校/年级） */
      if (url.pathname === '/api/users' && req.method === 'POST') {
        const body = await readBody(req);
        /* 修改自己的密码：任何已登录用户均可，需验证原密码 */
        if (body.action === 'changepw') {
          const u = findUser(user.username);
          if (!u) return json(res, 401, { error: '登录状态异常，请重新登录' });
          const oldPw = String(body.oldPassword || '');
          const newPw = String(body.newPassword || '');
          if (u.pwhash !== sha(u.salt + oldPw)) return json(res, 400, { error: '原密码不正确' });
          if (newPw.length < 4) return json(res, 400, { error: '新密码至少 4 位' });
          u.salt = rand(8); u.pwhash = sha(u.salt + newPw);
          persist();
          return json(res, 200, visibleState(user));
        }
        /* 管理员调整用户角色（提升为管理员 / 降为成员） */
        if (body.action === 'setrole') {
          if (user.role !== 'admin') return json(res, 403, { error: '只有管理员可以调整角色' });
          const u = findUser(String(body.username || ''));
          if (!u) return json(res, 404, { error: '用户不存在' });
          const role = body.role === 'admin' ? 'admin' : 'member';
          if (u.username === user.username && role !== 'admin') return json(res, 400, { error: '不能降级自己的管理员身份' });
          u.role = role;
          if (role === 'admin') { u.grade = ''; u.gradeYear = 0; }
          persist();
          return json(res, 200, visibleState(user));
        }
        const selfProfile = body.action === 'profile' && String(body.username || user.username) === user.username;
        if (user.role !== 'admin' && !selfProfile) return json(res, 403, { error: '只有管理员可以管理用户' });
        if (body.action === 'add') {
          const username = String(body.username || '').trim();
          const name = String(body.name || '').trim();
          const password = String(body.password || '');
          const role = body.role === 'admin' ? 'admin' : 'member';
          if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return json(res, 400, { error: '用户名需为 2-20 位字母/数字/下划线' });
          if (!name) return json(res, 400, { error: '请填写姓名' });
          if (password.length < 4) return json(res, 400, { error: '密码至少 4 位' });
          if (findUser(username)) return json(res, 400, { error: '用户名已存在' });
          db.users.push(makeUser(username, name, password, role, { school: body.school, grade: body.grade }));
          persist();
          return json(res, 200, visibleState(user));
        }
        /* 修改学校 / 年级：管理员可改所有人，成员只能改自己 */
        if (body.action === 'profile') {
          const target = String(body.username || user.username);
          if (target !== user.username && user.role !== 'admin') return json(res, 403, { error: '只能修改自己的资料' });
          const u = findUser(target);
          if (!u) return json(res, 404, { error: '用户不存在' });
          if (typeof body.school === 'string') u.school = body.school.trim().slice(0, 30);
          if (body.grade !== undefined) {
            const g = String(body.grade || '').trim();
            if (g && gradeIndex(g) < 0) return json(res, 400, { error: '年级无效' });
            if (g !== u.grade) { u.grade = g; u.gradeYear = g ? acadYearStart() : 0; }
            else if (g && !u.gradeYear) u.gradeYear = acadYearStart();
          }
          persist();
          return json(res, 200, visibleState(user));
        }
        if (body.action === 'remove') {
          const username = String(body.username || '');
          if (username === user.username) return json(res, 400, { error: '不能删除自己' });
          const idx = db.users.findIndex(u => u.username === username);
          if (idx < 0) return json(res, 404, { error: '用户不存在' });
          db.users.splice(idx, 1);
          persist();
          return json(res, 200, visibleState(user));
        }
        if (body.action === 'resetpw') {
          const u = findUser(String(body.username || ''));
          const password = String(body.password || '');
          if (!u) return json(res, 404, { error: '用户不存在' });
          if (password.length < 4) return json(res, 400, { error: '密码至少 4 位' });
          u.salt = rand(8); u.pwhash = sha(u.salt + password);
          persist();
          return json(res, 200, visibleState(user));
        }
        if (body.action === 'rename') {
          const u = findUser(String(body.username || ''));
          const name = String(body.name || '').trim();
          if (!u) return json(res, 404, { error: '用户不存在' });
          if (!name) return json(res, 400, { error: '姓名不能为空' });
          u.name = name;
          persist();
          return json(res, 200, visibleState(user));
        }
        /* 审批自主注册申请 */
        if (body.action === 'approve' || body.action === 'reject') {
          const idx = (db.registrations || []).findIndex(r => r.id === body.id);
          if (idx < 0) return json(res, 404, { error: '该注册申请不存在或已被处理' });
          const reg = db.registrations[idx];
          if (body.action === 'approve') {
            if (findUser(reg.username)) { db.registrations.splice(idx, 1); persist(); return json(res, 409, { error: '用户名已被占用，申请已自动清除' }); }
            db.users.push({
              username: reg.username, name: reg.name, role: 'member', salt: reg.salt, pwhash: reg.pwhash,
              school: reg.school || '',
              grade: gradeIndex(reg.grade) >= 0 ? reg.grade : DEFAULT_GRADE,
              gradeYear: reg.gradeYear || acadYearStart()
            });
            db.registrations.splice(idx, 1);
            persist();
            const st = visibleState(user);
            st.approved = { username: reg.username, name: reg.name };
            return json(res, 200, st);
          }
          db.registrations.splice(idx, 1);
          persist();
          return json(res, 200, visibleState(user));
        }
        return json(res, 400, { error: '无效操作' });
      }
      return json(res, 404, { error: 'not found' });
    }

    serveStatic(req, res);
  } catch (e) {
    json(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`✅ 服务已启动: http://localhost:${PORT}`);
  console.log(`👤 默认管理员: admin / admin123`);
});
