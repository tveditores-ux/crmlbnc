// PostToolUse: corre las pruebas cuando se edita código en src/ o test/.
const { spawnSync } = require('child_process');
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let p = '';
  try { p = String(JSON.parse(raw).tool_input?.file_path || ''); } catch {}
  if (!/[\/](src|test)[\/].+\.js$/.test(p)) return;
  const r = spawnSync('npm', ['test', '--silent'], { encoding: 'utf8', shell: true });
  if (r.status !== 0) {
    console.error('Las pruebas fallaron:\n' + (r.stdout + r.stderr).slice(-2500));
    process.exit(2);
  }
});
