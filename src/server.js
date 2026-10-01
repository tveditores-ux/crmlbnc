'use strict';
const { loadConfig, configProblems } = require('./config');
const { createPool, migrate } = require('./db');
const { createChannels } = require('./channels');
const { createApp } = require('./app');
const { startScheduler } = require('./reminders');

async function main() {
  const config = loadConfig();
  const problems = configProblems(config);
  if (problems.length) {
    console.error('Configuración incompleta:\n - ' + problems.join('\n - '));
    process.exit(1);
  }

  const db = createPool(config.databaseUrl);
  await migrate(db);

  const channels = createChannels(config);
  const ctx = { db, config, channels };
  const app = createApp(ctx);

  const server = app.listen(config.port, () => {
    console.log(`[web] escuchando en el puerto ${config.port} · ${config.publicUrl}`);
    console.log(`[web] modo ${config.dryRun ? 'PRUEBA (DRY_RUN)' : 'REAL'} · WhatsApp ${channels.whatsapp.available ? 'sí' : 'no'} · correo ${channels.email.available ? 'sí' : 'no'}`);
  });

  const stop = config.schedulerEnabled ? startScheduler(ctx) : () => {};

  const shutdown = () => {
    console.log('[web] cerrando…');
    stop();
    server.close(() => db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
