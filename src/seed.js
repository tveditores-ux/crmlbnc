'use strict';
/**
 * Datos de ejemplo para probar el panel en local o en un entorno de prueba.
 * Uso: npm run seed   (solo actúa si la base de datos no tiene personas)
 */
const { loadConfig } = require('./config');
const { createPool, migrate } = require('./db');
const repo = require('./repo');

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  await migrate(db);
  const { rows } = await db.query('SELECT count(*)::int AS c FROM people');
  if (rows[0].c > 0) {
    console.log('La base ya tiene personas; no se cargó nada.');
    return db.end();
  }
  const diaconos = await repo.ensureMinistry(db, 'Diáconos');
  const medios = await repo.ensureMinistry(db, 'Medios');
  const people = [
    ['María Ejemplo', '0414-0000001', null, [diaconos], true],
    ['José Ejemplo', '0424-0000002', null, [diaconos, medios], true],
    ['Ana Ejemplo', null, 'ana@ejemplo.com', [medios], true],
    ['Luis Sin Permiso', '0412-0000004', null, [medios], false],
  ];
  for (const [full_name, phone, email, mins, opt_in] of people) {
    const { value } = repo.validatePerson({ full_name, phone, email, opt_in }, config.defaultCountryCode);
    const id = await repo.savePerson(db, null, value);
    await repo.setPersonMinistries(db, id, mins);
  }
  const day = 86400000;
  await repo.saveEvent(db, null, { title: 'Reunión de diáconos', starts_at: new Date(Date.now() + 6 * day), location: 'Templo principal', description: '' }, [diaconos]);
  await repo.saveEvent(db, null, { title: 'Ensayo de medios', starts_at: new Date(Date.now() + 25 * day), location: 'Consola', description: '' }, [medios]);
  console.log('Datos de ejemplo cargados.');
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
