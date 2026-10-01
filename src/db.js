'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function createPool(databaseUrl) {
  const useSsl = /^(1|true|si)$/i.test(process.env.DATABASE_SSL || '');
  return new Pool({
    connectionString: databaseUrl,
    max: 5,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
}

const MIGRATION_LOCK = 724001;

async function migrate(pool) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[db] migración aplicada: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, tx };
