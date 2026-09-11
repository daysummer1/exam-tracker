/* 本地接口自测：changepw + setrole */
const BASE = 'http://127.0.0.1:3891';
async function post(url, body, tok) {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-auth': tok } : {}) },
    body: JSON.stringify(body)
  });
  return { code: r.status, data: await r.json().catch(() => ({})) };
}
(async () => {
  const out = [];
  const log = (...a) => { out.push(a.join(' ')); };
  // 1. admin 登录
  let r = await post('/api/login', { username: 'admin', password: 'admin123' });
  log('1) admin 登录:', r.code, r.data.user && r.data.user.role);
  const tok = r.data.token;
  // 2. 修改密码（原密码正确）
  r = await post('/api/users', { action: 'changepw', oldPassword: 'admin123', newPassword: 'admin999' }, tok);
  log('2) changepw 正确原密码:', r.code, r.data.error || 'OK');
  // 3. 旧密码应失效
  r = await post('/api/login', { username: 'admin', password: 'admin123' });
  log('3) 旧密码登录应 401:', r.code);
  // 4. 新密码登录
  r = await post('/api/login', { username: 'admin', password: 'admin999' });
  log('4) 新密码登录:', r.code, r.data.user && r.data.user.role);
  const tok2 = r.data.token;
  // 5. 错误原密码应拒绝
  r = await post('/api/users', { action: 'changepw', oldPassword: 'nope', newPassword: 'aaaa1' }, tok2);
  log('5) 错误原密码:', r.code, r.data.error);
  // 6. 新密码过短应拒绝
  r = await post('/api/users', { action: 'changepw', oldPassword: 'admin999', newPassword: 'abc' }, tok2);
  log('6) 过短新密码:', r.code, r.data.error);
  // 7. 自己降级自己应拒绝
  r = await post('/api/users', { action: 'setrole', username: 'admin', role: 'member' }, tok2);
  log('7) 自己降级自己:', r.code, r.data.error || 'UNEXPECTED-OK');
  // 8. 添加测试用户并提升为管理员
  r = await post('/api/users', { action: 'add', username: 'tuser', name: '测试用户', password: 't123', role: 'member' }, tok2);
  log('8) 添加测试用户:', r.code, r.data.error || 'OK');
  r = await post('/api/users', { action: 'setrole', username: 'tuser', role: 'admin' }, tok2);
  const tu = (r.data.users || []).find(u => u.username === 'tuser');
  log('9) tuser 提升为 admin:', r.code, tu && tu.role);
  r = await post('/api/users', { action: 'setrole', username: 'tuser', role: 'member' }, tok2);
  const tu2 = (r.data.users || []).find(u => u.username === 'tuser');
  log('10) tuser 降回 member:', r.code, tu2 && tu2.role);
  // 11. 成员 token 调 setrole 应 403
  const mt = await post('/api/login', { username: 'tuser', password: 't123' });
  r = await post('/api/users', { action: 'setrole', username: 'tuser', role: 'admin' }, mt.data.token);
  log('11) 成员调 setrole 应 403:', r.code, r.data.error);
  // 12. 成员改自己密码 OK
  r = await post('/api/users', { action: 'changepw', oldPassword: 't123', newPassword: 't456' }, mt.data.token);
  log('12) 成员改自己密码:', r.code, r.data.error || 'OK');
  // 恢复 admin 密码
  r = await post('/api/users', { action: 'changepw', oldPassword: 'admin999', newPassword: 'admin123' }, tok2);
  log('13) 恢复 admin 密码:', r.code, r.data.error || 'OK');
  log('ALL DONE');
  require('fs').writeFileSync(require('path').join(__dirname, '_test_out.txt'), out.join('\n'), 'utf8');
})().catch(e => { require('fs').writeFileSync(require('path').join(__dirname, '_test_out.txt'), 'FATAL ' + (e && e.stack || e), 'utf8'); process.exit(1); });
