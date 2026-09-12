/* 学库宝 /search 实测：验证订阅 + 观察响应结构（结果落盘） */
const https = require('https');
const fs = require('fs');
const path = require('path');
const KEY = fs.readFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/.xkbkey', 'utf8').trim();
const out = [];
const log = (...a) => out.push(a.join(' '));
function post(apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = https.request({ hostname: 'api.xuekubao.com', path: '/api/v1' + apiPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000 }, x => {
      const s = []; x.on('data', c => s.push(c)); x.on('end', () => resolve({ code: x.statusCode, buf: Buffer.concat(s).toString('utf8') }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + apiPath)); });
    r.write(data); r.end();
  });
}
(async () => {
  /* 1. 基础数据（验证订阅是否生效） */
  let r = await post('/subjectEditionApi', {});
  log('1) subjectEditionApi: HTTP', r.code, r.buf.slice(0, 150));
  /* 2. 搜题实测：典型初一数学题 */
  r = await post('/search', { keyword: '解方程 3x+5=20', gradeId: '200', subjectId: '2' });
  log('2) search(初一数学): HTTP', r.code);
  let j = null; try { j = JSON.parse(r.buf); } catch (e) {}
  if (j) {
    log('   errorCode:', j.errorCode, ' dataCount:', j.dataCount, ' data类型:', typeof j.data, Array.isArray(j.data)?'数组':'');
    const dstr = JSON.stringify(j.data);
    log('   data前1200字符:', (dstr||'null').slice(0, 1200));
  } else log('   原始:', r.buf.slice(0, 300));
  /* 3. 中文长关键词（模拟 OCR 文本片段） */
  r = await post('/search', { keyword: '随着科技的不断发展，新能源汽车凭借其在节能减排领域的优势', gradeId: '160', subjectId: '2' });
  j = null; try { j = JSON.parse(r.buf); } catch (e) {}
  log('3) search(长文本): HTTP', r.code, ' 条数:', j ? (j.data||[]).length : r.buf.slice(0,120));
  if (j && (j.data||[]).length) log('   #1 title:', String(j.data[0].title||'').slice(0, 200));
  /* 4. 是否有 img 标签探测（再搜一道带图题） */
  r = await post('/search', { keyword: '如图 在平面直角坐标系中 抛物线', gradeId: '300', subjectId: '2' });
  j = null; try { j = JSON.parse(r.buf); } catch (e) {}
  log('4) search(带图题): HTTP', r.code, ' 条数:', j ? (j.data||[]).length : r.buf.slice(0,120));
  if (j && (j.data||[]).length) {
    const hasImg = (j.data||[]).some(q => /<img/i.test(String(q.title||'')));
    log('   title 含 <img>:', hasImg);
    if (hasImg) log('   示例:', String(j.data.find(q=>/<img/i.test(q.title)).title).slice(0, 500));
  }
  log('=== SEARCH TEST DONE ===');
  fs.writeFileSync(path.join(__dirname, '_xkb_out.txt'), out.join('\n'), 'utf8');
})().catch(e => { out.push('FATAL ' + e.message); fs.writeFileSync(path.join(__dirname, '_xkb_out.txt'), out.join('\n'), 'utf8'); process.exit(1); });
