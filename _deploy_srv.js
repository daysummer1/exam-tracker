/* 一键部署到腾讯云轻量服务器：上传代码 + systemd 自启 + 云端数据迁移 + 全链路验证 */
const { Client } = require('ssh2');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/exam-tracker';
const SRV = { host: '43.163.230.72', port: 22, username: 'root', password: fs.readFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/.srvcred', 'utf8').trim() };
const CLOUD = { host: 'b6003ab1e7bc490ca57fcbce7424f83b.app.workbuddy.link', user: 'admin', pw: fs.readFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/.cloudcred', 'utf8').trim() };
const NODE_BIN = '/usr/local/lighthouse/softwares/nodejs/node/bin/node';
const APP_DIR = '/opt/exam-tracker';
const DATA_DIR = APP_DIR + '/data';
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

const conn = new Client();
let sftp;
function run(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', code => resolve({ code, out, errOut }));
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => errOut += d);
      stream.on('error', reject);
    });
    if (timeout) setTimeout(() => reject(new Error('cmd timeout: ' + cmd)), timeout);
  });
}
function up(local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, err => err ? reject(err) : resolve());
  });
}
function upData(buf, remote) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remote, buf, err => err ? reject(err) : resolve());
  });
}
function cloudCall(p, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: CLOUD.host, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-auth': token } : {}) }, x => {
      let s = []; x.on('data', c => s.push(c)); x.on('end', () => resolve({ code: x.statusCode, buf: Buffer.concat(s) }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const log = (...a) => console.log(...a);
  /* ---------- 1. 连接 ---------- */
  await new Promise((res, rej) => { conn.on('ready', res).on('error', rej).connect(SRV); });
  log('✅ SSH 已连接');
  sftp = await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));

  /* ---------- 2. 建目录 + 上传代码 ---------- */
  await run(`mkdir -p ${DATA_DIR}/photos`);
  await up(path.join(REPO, 'server.js'), APP_DIR + '/server.js');
  await up(path.join(REPO, 'index.html'), APP_DIR + '/index.html');
  await up(path.join(REPO, 'package.json'), APP_DIR + '/package.json');
  log('✅ 代码已上传到 ' + APP_DIR);

  /* ---------- 3. 写 systemd 服务 ---------- */
  const unit = `[Unit]
Description=每周考试成绩追踪
After=network.target

[Service]
WorkingDirectory=${APP_DIR}
Environment=PORT=80
Environment=DATA_DIR=${DATA_DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
  await upData(Buffer.from(unit), '/etc/systemd/system/myapp.service');
  let r = await run('systemctl daemon-reload && systemctl enable myapp >/dev/null 2>&1; systemctl restart myapp && sleep 1.5 && systemctl is-active myapp');
  log(r.out.trim() === 'active' ? '✅ 服务已启动并设为开机自启' : '⚠️ 服务状态: ' + r.out.trim() + ' ' + r.errOut.trim());

  /* ---------- 4. 云端数据迁移 ---------- */
  log('--- 开始迁移云端数据 ---');
  let lr = await cloudCall('/api/login', 'POST', { username: CLOUD.user, password: CLOUD.pw });
  const token = JSON.parse(lr.buf).token;
  if (!token) throw new Error('云端登录失败: ' + lr.buf.slice(0, 100));
  const st = JSON.parse((await cloudCall('/api/state', 'GET', null, token)).buf);
  log(`云端数据：用户 ${st.users.length} | 成绩 ${st.exams.length} | 错题 ${st.wrongs.length} | 追踪 ${st.tracks.length}`);

  /* 收集照片 */
  const photoNames = new Set();
  st.wrongs.forEach(w => (w.photos || []).forEach(p => typeof p === 'string' && /^ph_[a-f0-9]+\./.test(p) && photoNames.add(p)));
  const photos = [];
  for (const name of photoNames) {
    const pr = await cloudCall('/api/photo/' + encodeURIComponent(name), 'GET', null, token);
    if (pr.code === 200) photos.push({ name, buf: pr.buf });
    log(`  照片 ${name}: HTTP ${pr.code}, ${pr.buf.length} 字节`);
  }

  /* 构造 data.json：admin 保持 admin321；成员密码=用户名+123（原密码无法跨端迁移） */
  const members = st.users.filter(u => u.username !== 'admin').map(u => {
    const pw = u.username + '123';
    const salt = crypto.randomBytes(8).toString('hex');
    return { username: u.username, name: u.name, role: u.role || 'member', school: u.school || '', grade: u.grade || '', gradeYear: +u.gradeYear || 2026, salt, pwhash: sha(salt + pw) };
  });
  const asalt = crypto.randomBytes(8).toString('hex');
  const admin = { username: 'admin', name: '管理员', role: 'admin', school: '', grade: '', gradeYear: 0, salt: asalt, pwhash: sha(asalt + CLOUD.pw) };
  const dataJson = {
    users: [admin, ...members],
    exams: st.exams, wrongs: st.wrongs, tracks: st.tracks,
    full: st.full || { chinese: 100, math: 100, english: 100 },
    settings: st.settings || { allowSignup: true },
    registrations: []
  };
  log(`构造迁移密码：成员密码 = 用户名+123（共 ${members.length} 人）`);

  /* ---------- 5. 停服务 → 写数据 → 起服务 ---------- */
  await run('systemctl stop myapp');
  await upData(Buffer.from(JSON.stringify(dataJson)), DATA_DIR + '/data.json');
  await run(`chmod 600 ${DATA_DIR}/data.json`);
  for (const p of photos) await upData(p.buf, DATA_DIR + '/photos/' + p.name);
  await run('systemctl start myapp && sleep 1.5 && systemctl is-active myapp').then(r => log(r.out.trim() === 'active' ? '✅ 数据写入后服务已重启' : '⚠️ ' + r.out.trim()));

  /* ---------- 6. 新服务器全链路验证 ---------- */
  r = await run(`curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1/`);
  log('本机 80 端口: HTTP ' + r.out.trim());
  lr = await cloudCall('/api/login', 'POST', { username: 'admin', password: CLOUD.pw }).catch(e => ({ buf: Buffer.from('ERR ' + e.message), code: 0 }));
  const nt = JSON.parse(lr.buf).token;
  log('新服务器 admin 登录(经公网): ' + (nt ? '✅ 成功' : '❌ ' + lr.buf.slice(0, 120)));
  if (nt) {
    const ns = JSON.parse((await cloudCall('/api/state', 'GET', null, nt)).buf);
    log(`新服务器数据核验：用户 ${ns.users.length} | 成绩 ${ns.exams.length} | 错题 ${ns.wrongs.length} | 追踪 ${ns.tracks.length}`);
    if (ns.wrongs.find(w => w.photos && w.photos.length)) {
      const pn = ns.wrongs.find(w => w.photos && w.photos.length).photos[0];
      const pr = await cloudCall('/api/photo/' + encodeURIComponent(pn), 'GET', null, nt);
      log(`照片 ${pn}: HTTP ${pr.code}, ${pr.buf.length} 字节 ${pr.buf.slice(0, 3).toString('hex') === 'ffd8ff' ? '(合法JPEG)' : ''}`);
    }
    const m0 = members[0];
    if (m0) {
      lr = await cloudCall('/api/login', 'POST', { username: m0.username, password: m0.username + '123' });
      log(`成员 ${m0.username} 登录: ` + (JSON.parse(lr.buf).token ? '✅' : '❌ ' + lr.buf.slice(0, 80)));
    }
  }
  log('=== 部署完成 ===');
  log('成员初始密码清单（用户名 → 密码）:');
  members.forEach(m => log('  ' + m.username + ' → ' + m.username + '123'));
  conn.end();
})().catch(e => { console.error('部署失败:', e.message); try { conn.end(); } catch (x) {} process.exit(1); });
