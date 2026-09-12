const { execSync } = require('child_process');
const NODE = 'C:/Users/tony/.workbuddy/binaries/node/versions/24.14.0/node.exe';
let out = '';
try {
  out = execSync(`"${NODE}" --check "C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/exam-tracker/.check_tmp.js" 2>&1`, { encoding: 'utf8', timeout: 30000 });
  out = 'SYNTAX OK\n' + out;
} catch (e) { out = 'SYNTAX ERROR:\n' + ((e.stdout || '') + (e.stderr || '') + ' ' + e.message).slice(0, 1200); }
require('fs').writeFileSync('C:/Users/tony/WorkBuddy/2026-09-09-20-20-52/exam-tracker/_syntax_out.txt', out, 'utf8');
