/* 服务器配置每日自动备份 */
const { Client } = require('ssh2');
const fs = require('fs');
const CFG = { host: '43.163.230.72', port: 22, username: 'root', password: fs.readFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/.srvcred', 'utf8').trim() };
const conn = new Client();
function run(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', c => resolve({ out, errOut }));
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => errOut += d);
    });
  });
}
const cron = `#!/bin/bash
mkdir -p /opt/backups
tar -czf /opt/backups/exam-$(date +%Y%m%d).tar.gz -C /opt/exam-tracker data
ls -1t /opt/backups/exam-*.tar.gz | tail -n +15 | xargs -r rm -f
`;
conn.on('ready', async () => {
  try {
    await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s))).then(s => new Promise((res, rej) => s.writeFile('/opt/exam-tracker/backup.sh', cron, e => e ? rej(e) : res())));
    let r = await run('chmod +x /opt/exam-tracker/backup.sh && (crontab -l 2>/dev/null | grep -v exam-tracker/backup.sh; echo "0 2 * * * /opt/exam-tracker/backup.sh") | crontab - && /opt/exam-tracker/backup.sh && ls -lh /opt/backups/ && crontab -l');
    console.log(r.out || r.errOut);
  } catch (e) { console.log('ERR', e.message); }
  conn.end();
}).on('error', e => console.log('SSH ERR:', e.message)).connect(CFG);
