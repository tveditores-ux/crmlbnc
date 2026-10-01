// PreToolUse: bloquea editar .env y package-lock.json.
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let p = '';
  try { p = String(JSON.parse(raw).tool_input?.file_path || ''); } catch {}
  const f = p.replace(/\/g, '/').split('/').pop();
  if (f === 'package-lock.json' || (f.startsWith('.env') && f !== '.env.example')) {
    console.error(`Bloqueado: ${f} no se edita desde Claude (secretos o archivo generado por npm).`);
    process.exit(2);
  }
});
