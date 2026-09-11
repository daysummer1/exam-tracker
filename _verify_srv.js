/* 对新服务器 http://43.163.230.72 做真实验证 */
const http = require('http');
function call(p, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: '43.163.230.72', port: 80, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-auth': token } : {}) }, x => {
      let s = []; x.on('data', c => s.push(c)); x.on('end', () => resolve({ code: x.statusCode, buf: Buffer.concat(s) }));
    });
    r.on('error', reject); r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
(async () => {
  let r = await call('/', 'GET');
  const html = r.buf.toString('utf8');
  console.log('首页: HTTP', r.code, '| 大小', r.buf.length, 'B | 是我们的应用:', html.includes('成绩') || html.includes('exam'));
  r = await call('/api/login', 'POST', { username: 'admin', password: 'admin321' });
  const ta = JSON.parse(r.buf).token;
  console.log('admin/admin321 登录:', ta ? '✅' : '❌ ' + r.buf.slice(0, 80));
  const st = JSON.parse((await call('/api/state', 'GET', null, ta)).buf);
  console.log('数据核验: 用户', st.users.length, '| 成绩', st.exams.length, '| 错题', st.wrongs.length, '| 追踪', st.tracks.length);
  console.log('名册:', st.users.map(u => u.username + '(' + (u.name || '') + ',' + (u.grade || '') + ')').join(' '));
  const w = st.wrongs.find(w => w.photos && w.photos.length);
  if (w) {
    const pn = w.photos[0];
    r = await call('/api/photo/' + encodeURIComponent(pn), 'GET', null, ta);
    console.log('照片', pn + ':', 'HTTP', r.code, ',', r.buf.length, 'B,', r.buf.slice(0, 3).toString('hex') === 'ffd8ff' ? '合法JPEG' : '异常');
  }
  for (const u of ['lhy', 'blx', 'lyc', 'syx', 'dzz']) {
    r = await call('/api/login', 'POST', { username: u, password: u + '123' });
    console.log('成员', u + ' 登录:', JSON.parse(r.buf).token ? '✅' : '❌ ' + r.buf.slice(0, 60));
  }
  /* 成员数据可见性验证（lhy 应能看到全部 4 条成绩，但他人姓名脱敏） */
  r = await call('/api/login', 'POST', { username: 'lhy', password: 'lhy123' });
  const tm = JSON.parse(r.buf).token;
  if (tm) {
    const ms = JSON.parse((await call('/api/state', 'GET', null, tm)).buf);
    console.log('lhy 视角: 成绩', ms.exams.length, '条(应=4) | 名册', ms.users.length, '人 | 他人姓名已脱敏:', ms.users.filter(u => u.username !== 'lhy' && u.username !== 'admin').every(u => u.name === u.username));
  }
  console.log('=== 新服务器验证完成 ===');
})().catch(e => console.log('验证失败:', e.message));
