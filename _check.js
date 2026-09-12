/* 提取 index.html 内联脚本做语法检查 + OCR 文件名通道测试 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const out = [];
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { out.push('未找到内联脚本'); }
else {
  fs.writeFileSync(path.join(__dirname, '.check_tmp.js'), m[1], 'utf8');
  out.push('script 提取: ' + m[1].length + ' 字符');
}
function req(p, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: '127.0.0.1', port: 3891, path: p, method, headers: Object.assign(
      { 'Content-Type': 'application/json' }, token ? { 'x-auth': token } : {},
      data ? { 'Content-Length': Buffer.byteLength(data) } : {}), timeout: 60000 }, x => {
      const s = []; x.on('data', c => s.push(c)); x.on('end', () => resolve({ code: x.statusCode, buf: Buffer.concat(s) }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
(async () => {
  try {
    const tok = JSON.parse((await req('/api/login', 'POST', { username: 'admin', password: 'admin123' })).buf).token;
    out.push('登录 OK');
    /* 文件名通道：确认 .test_data/photos 有照片（无则跳过） */
    const pd = path.join(__dirname, '.test_data', 'photos');
    const files = fs.existsSync(pd) ? fs.readdirSync(pd).filter(f => /^ph_/.test(f)) : [];
    if (files.length) {
      const r = await req('/api/ocr', 'POST', { name: files[0] }, tok);
      const j = JSON.parse(r.buf);
      out.push(`OCR({name:${files[0]}}): HTTP ${r.code} → ${(j.text || j.error || '').slice(0, 80)}`);
    } else {
      out.push('.test_data/photos 无照片，跳过 name 通道测试（线上再验）');
    }
  } catch (e) { out.push('测试异常: ' + e.message); }
  out.push('=== CHECK DONE ===');
  fs.writeFileSync(path.join(__dirname, '_ocr_out.txt'), out.join('\n'), 'utf8');
})();
