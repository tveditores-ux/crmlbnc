'use strict';
const { tx } = require('./db');

/**
 * Borrar toda la lista de personas.
 * Las personas con acceso al panel (access_level distinto de 'ninguno': administradores y coordinadores que entran con
 * Google) SE CONSERVAN: viven en la misma tabla y borrarlas dejaría a esas personas sin entrar.
 * El borrado arrastra lo que depende de cada persona según las claves foráneas (se consulta el catálogo, así incluye
 * las tablas que se agreguen después): lo que está en cascada se borra; lo demás solo pierde el vínculo.
 */
const KEEP = "access_level <> 'ninguno'";
const DELETE_WHERE = "access_level = 'ninguno'";

const LABELS = {
  person_ministries: 'pertenencias a ministerios',
  event_participants: 'participaciones en eventos (con sus confirmaciones)',
  notifications: 'mensajes enviados de recordatorios',
  consolidation: 'registros de consolidación (con su seguimiento y llamadas)',
  people_photos: 'fotos de personas',
  member_submissions: 'respuestas del enlace "Mis datos"',
  ministries: 'ministerios que quedan sin coordinador',
  agent_messages: 'conversaciones del asistente de WhatsApp (se conservan, sin nombre)',
  nueva_vida: 'registros de Nueva Vida (se conservan, sin el vínculo a la ficha)',
};
const RULES = { c: 'cascade', n: 'null', d: 'null' };
const ident = /^[a-z_][a-z0-9_]*$/;

/** Qué se llevaría el borrado, sin borrar nada. */
async function wipeImpact(db) {
  const n = async (sql) => (await db.query(sql)).rows[0].n;
  const total = await n('SELECT count(*)::int AS n FROM people');
  const keep = await n(`SELECT count(*)::int AS n FROM people WHERE ${KEEP}`);
  const keepNames = (await db.query(`SELECT full_name FROM people WHERE ${KEEP} ORDER BY full_name LIMIT 20`)).rows.map((r) => r.full_name);
  const fks = (
    await db.query(
      `SELECT c.conrelid::regclass::text AS tabla, a.attname AS columna, c.confdeltype AS regla
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'people'::regclass
        ORDER BY 1, 2`
    )
  ).rows;
  const effects = [];
  for (const f of fks) {
    if (!ident.test(f.tabla.replace(/^"|"$/g, '')) || !ident.test(f.columna)) continue; // nombres que no son normales no se tocan a ciegas
    const rows = await n(`SELECT count(*)::int AS n FROM ${f.tabla} WHERE ${f.columna} IN (SELECT id FROM people WHERE ${DELETE_WHERE})`);
    const rule = RULES[f.regla] || 'blocks'; // 'a'/'r': la base impediría el borrado
    effects.push({ table: f.tabla, column: f.columna, label: LABELS[f.tabla] || f.tabla, rule, rows });
  }
  return { total, keep, keepNames, toDelete: total - keep, effects };
}

/** Borra todas las personas sin acceso al panel, en una transacción. Devuelve lo que se llevó. */
async function wipePeople(pool) {
  return tx(pool, async (db) => {
    const impact = await wipeImpact(db);
    if (impact.effects.some((e) => e.rule === 'blocks' && e.rows > 0)) {
      throw new Error('Una tabla impide el borrado: hay datos que dependen de las personas y no se pueden soltar.');
    }
    await db.query(`DELETE FROM people WHERE ${DELETE_WHERE}`);
    return impact;
  });
}

module.exports = { wipeImpact, wipePeople };
