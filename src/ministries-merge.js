'use strict';
const { tx } = require('./db');

class MergeError extends Error {}

/** Nombre para comparar: sin tildes, sin mayúsculas, sin signos y con los espacios juntos. "Anfitriónes " = "anfitriones". */
function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Ministerios con su cantidad de personas y eventos, para elegir cuál conservar. */
async function listWithCounts(db) {
  return (
    await db.query(
      `SELECT m.id, m.name, m.created_at,
              (SELECT count(*)::int FROM person_ministries pm WHERE pm.ministry_id = m.id) AS members,
              (SELECT count(*)::int FROM event_ministries em WHERE em.ministry_id = m.id) AS events
         FROM ministries m ORDER BY m.created_at, m.id`
    )
  ).rows;
}

/** Grupos de ministerios que parecen el mismo (mismo nombre normalizado). Cada grupo: [{ id, name, members, events }, ...]. */
function duplicateGroups(ministries) {
  const by = new Map();
  for (const m of ministries) {
    const k = normName(m.name);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(m);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

/**
 * Une un ministerio en otro, en una transacción: las personas y los eventos del que se elimina pasan al que se conserva
 * (sin repetir), y si el conservado no tenía coordinador, hereda el del otro. Nadie se borra.
 */
async function mergeMinistries(pool, keepId, otherId) {
  const keep = Number(keepId);
  const other = Number(otherId);
  if (!Number.isInteger(keep) || !Number.isInteger(other) || keep < 1 || other < 1) throw new MergeError('Elige dos ministerios válidos.');
  if (keep === other) throw new MergeError('Elige dos ministerios distintos.');
  return tx(pool, async (db) => {
    const rows = (await db.query('SELECT * FROM ministries WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[keep, other]])).rows;
    if (rows.length !== 2) throw new MergeError('Uno de los dos ministerios ya no existe.');
    const k = rows.find((r) => r.id === keep);
    const o = rows.find((r) => r.id === other);
    const members = (
      await db.query('INSERT INTO person_ministries (person_id, ministry_id) SELECT person_id, $1 FROM person_ministries WHERE ministry_id = $2 ON CONFLICT DO NOTHING', [keep, other])
    ).rowCount;
    const events = (
      await db.query('INSERT INTO event_ministries (event_id, ministry_id) SELECT event_id, $1 FROM event_ministries WHERE ministry_id = $2 ON CONFLICT DO NOTHING', [keep, other])
    ).rowCount;
    if (!k.coordinator_id && o.coordinator_id) await db.query('UPDATE ministries SET coordinator_id = $2 WHERE id = $1', [keep, o.coordinator_id]);
    await db.query('DELETE FROM ministries WHERE id = $1', [other]); // sus vínculos se van por ON DELETE CASCADE; ya se copiaron
    return { keepName: k.name, removedName: o.name, members, events, coordinatorInherited: !k.coordinator_id && Boolean(o.coordinator_id) };
  });
}

module.exports = { normName, listWithCounts, duplicateGroups, mergeMinistries, MergeError };
