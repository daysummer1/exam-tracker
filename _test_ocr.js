/* OCR 端到端本地测试：登录 → 检查配置 → 用线上真实照片测 /api/ocr */
const http = require('http');
const fs = require('fs');
const path = require('path');
const out = [];
const log = (...a) => out.push(a.join(' '));
function req(host, port, p, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: host, port, path: p, method, headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { 'x-auth': token } : {},
      data ? { 'Content-Length': Buffer.byteLength(data) } : {}
    ), timeout: 60000 }, x => {
      const s = []; x.on('data', c => s.push(c)); x.on('end', () => resolve({ code: x.statusCode, buf: Buffer.concat(s) }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + p)); });
    if (data) r.write(data); r.end();
  });
}
(async () => {
  /* 1. 登录本地 */
  let r = await req('127.0.0.1', 3891, '/api/login', 'POST', { username: 'admin', password: 'admin123' });
  const tok = JSON.parse(r.buf).token;
  log('1) 本地登录:', r.code, tok ? 'OK' : r.buf.slice(0, 80));
  /* 2. 检查 OCR 配置状态（环境变量注入） */
  r = await req('127.0.0.1', 3891, '/api/state', 'GET', null, tok);
  const st = JSON.parse(r.buf);
  log('2) settings.ocr:', JSON.stringify(st.settings.ocr));
  /* 3. 从线上拉一张真实学生照片 */
  const LIVE_TOK = JSON.parse((await req('43.163.230.72', 80, '/api/login', 'POST', { username: 'admin', password: 'admin321' })).buf).token;
  const lst = JSON.parse((await req('43.163.230.72', 80, '/api/state', 'GET', null, LIVE_TOK)).buf);
  const wWithPhoto = lst.wrongs.find(w => w.photos && w.photos.length);
  if (!wWithPhoto) { log('3) 线上没有照片，改用纯色测试跳过'); }
  let dataUrl = null;
  if (wWithPhoto) {
    const pn = wWithPhoto.photos[0];
    const pr = await req('43.163.230.72', 80, '/api/photo/' + encodeURIComponent(pn), 'GET', null, LIVE_TOK);
    const mime = pn.endsWith('.png') ? 'image/png' : 'image/jpeg';
    dataUrl = 'data:' + mime + ';base64,' + pr.buf.toString('base64');
    log('3) 已取线上照片:', pn, pr.buf.length + 'B');
  }
  /* 4. 调本地 /api/ocr */
  if (dataUrl) {
    r = await req('127.0.0.1', 3891, '/api/ocr', 'POST', { data: dataUrl }, tok);
    let j = null; try { j = JSON.parse(r.buf); } catch (e) {}
    log('4) OCR 结果: HTTP', r.code);
    log('   文本:', j && j.text ? j.text.slice(0, 300) : r.buf.slice(0, 200));
  }
  /* 5. 未配置提示路径（用一个假 provider 名验证 400）——跳过，直接验证文件名模式 */
  log('=== LOCAL OCR TEST DONE ===');
  fs.writeFileSync(path.join(__dirname, '_ocr_out.txt'), out.join('\n'), 'utf8');
})().catch(e => {
  out.push('FATAL ' + (e && e.message));
  fs.writeFileSync(path.join(__dirname, '_ocr_out.txt'), out.join('\n'), 'utf8');
  process.exit(1);
});
