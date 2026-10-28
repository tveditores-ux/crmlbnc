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
    // Cada prueba usa su propio esquema, para que varios archivos puedan correr a la vez sin pisarse
    // (integration.test.js recrea "public"; esto no lo toca).
    const { Pool } = require('pg');
    const { createPool, migrate } = require('../../src/db');
    const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const sep = url.includes('?') ? '&' : '?';
    const pool = createPool(`${url}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
    await migrate(pool);
    return {
      db: pool,
      engine: 'postgres',
      close: async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
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
