/* 轻量更新：仅上传 server.js + index.html 并重启服务（不动数据），随后提升 lhy 为管理员并验证 */
const { Client } = require('ssh2');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = 'C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/exam-tracker';
const SRV = { host: '43.163.230.72', port: 22, username: 'root', password: fs.readFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/.srvcred', 'utf8').trim() };
const LIVE = { host: '43.163.230.72', user: 'admin', pw: 'admin321' };
const APP_DIR = '/opt/exam-tracker';

const out = [];
const log = (...a) => { out.push(a.join(' ')); console.log(...a); };
function call(p, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: LIVE.host, port: 80, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-auth': token } : {}) }, x => {
      let s = []; x.on('data', c => s.push(c)); x.on('end', () => { const buf = Buffer.concat(s); let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ code: x.statusCode, buf, j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const conn = new Client();
let sftp;
function run(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let o = '', e = '';
      stream.on('close', code => resolve({ code, out: o, errOut: e }));
      stream.on('data', d => o += d);
      stream.stderr.on('data', d => e += d);
    });
    if (timeout) setTimeout(() => reject(new Error('timeout: ' + cmd)), timeout);
  });
}
function up(local, remote) { return new Promise((res, rej) => sftp.fastPut(local, remote, err => err ? rej(err) : res())); }

(async () => {
  await new Promise((res, rej) => { conn.on('ready', res).on('error', rej).connect(SRV); });
  log('1) SSH 已连接');
  sftp = await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));

  /* 更新前先备份线上数据快照 */
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await run(`cp ${APP_DIR}/data/data.json ${APP_DIR}/data/data.preupdate-${stamp}.json`);
  log('2) 已备份线上数据: data.preupdate-' + stamp + '.json');

  await up(path.join(REPO, 'server.js'), APP_DIR + '/server.js');
  await up(path.join(REPO, 'index.html'), APP_DIR + '/index.html');
  log('3) server.js / index.html 已上传');

  let r = await run('systemctl restart myapp && sleep 1.5 && systemctl is-active myapp');
  log('4) 服务重启:', r.out.trim() === 'active' ? '✅ active' : '⚠️ ' + r.out.trim() + ' ' + r.errOut.trim());

  /* 验证数据仍在 */
  const lr = await call('/api/login', 'POST', { username: LIVE.user, password: LIVE.pw });
  const tok = lr.j && lr.j.token;
  log('5) admin 登录:', tok ? '✅' : '❌ ' + lr.buf.slice(0, 120));
  if (!tok) throw new Error('登录失败');
  const st = await call('/api/state', 'GET', null, tok);
  log(`6) 数据核验: 用户 ${st.j.users.length} | 成绩 ${st.j.exams.length} | 错题 ${st.j.wrongs.length} | 追踪 ${st.j.tracks.length}`);

  /* 提升 lhy 为管理员 */
  const lhy = st.j.users.find(u => u.username === 'lhy');
  if (!lhy) throw new Error('用户 lhy 不存在');
  const sr = await call('/api/users', 'POST', { action: 'setrole', username: 'lhy', role: 'admin' }, tok);
  const lhyAfter = sr.j && sr.j.users && sr.j.users.find(u => u.username === 'lhy');
  log('7) lhy 提升为管理员:', lhyAfter && lhyAfter.role === 'admin' ? '✅ role=admin' : '❌ ' + sr.buf.slice(0, 120));

  /* lhy 登录复核 */
  const lhyLogin = await call('/api/login', 'POST', { username: 'lhy', password: 'lhy123' });
  log('8) lhy 登录(lhy123):', lhyLogin.j && lhyLogin.j.token ? '✅ role=' + lhyLogin.j.user.role : '(旧密码可能已被用户自行修改: ' + lhyLogin.buf.slice(0, 80) + ')');

  /* 配置线上 OCR（智谱 GLM-4V-Flash，密钥只存服务器 data.json） */
  const ocrKey = fs.readFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/.zhipukey', 'utf8').trim();
  const oc = await call('/api/op', 'POST', { op: 'ocrconfig', provider: 'zhipu', zhipuKey: ocrKey }, tok);
  log('9) OCR 配置:', oc.j && oc.j.settings && oc.j.settings.ocr && oc.j.settings.ocr.configured ? '✅ 已启用智谱通道' : '❌ ' + oc.buf.slice(0, 120));

  /* 线上 OCR 实测（用线上真实照片） */
  const wP = st.j.wrongs.find(w => w.photos && w.photos.length);
  if (wP) {
    const pr = await call('/api/photo/' + encodeURIComponent(wP.photos[0]), 'GET', null, tok);
    const dataUrl = 'data:image/jpeg;base64,' + pr.buf.toString('base64');
    const or = await call('/api/ocr', 'POST', { data: dataUrl }, tok);
    log('10) 线上 OCR 实测: HTTP', or.code, or.j && or.j.text ? '→ ' + or.j.text.slice(0, 80).replace(/\n/g, ' ') : or.buf.slice(0, 120));
  }

  log('=== 更新完成 ===');
  require('fs').writeFileSync(path.join(REPO, '_upd_out.txt'), out.join('\n'), 'utf8');
  conn.end();
})().catch(e => {
  out.push('失败: ' + (e && e.message));
  require('fs').writeFileSync(path.join(REPO, '_upd_out.txt'), out.join('\n'), 'utf8');
  console.error('失败:', e.message); try { conn.end(); } catch (x) {} process.exit(1);
});
