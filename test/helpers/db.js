'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Base de datos real para las pruebas:
 *  - Con DATABASE_URL_TEST (CI) usa ese Postgres y recrea el esquema.
 *  - Sin ella, usa PGlite (Postgres dentro de Node) si está instalado: npm install --no-save @electric-sql/pglite
 *  - Si no hay ninguna, devuelve null y las pruebas se omiten.
 */
async function openTestDb() {
  const migrationsDir = path.join(__dirname, '..', '..', 'src', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const url = process.env.DATABASE_URL_TEST;

  if (url) {
    const { createPool, migrate } = require('../../src/db');
    const pool = createPool(url);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    return { db: pool, close: () => pool.end(), engine: 'postgres' };
  }

  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch {
    return null;
  }
  const lite = new PGlite();
  for (const f of files) await lite.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  const run = async (sql, params) => {
    const r = await lite.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const db = {
    query: run,
    connect: async () => ({ query: run, release() {} }),
  };
  return { db, close: () => lite.close(), engine: 'pglite' };
}

module.exports = { openTestDb };
