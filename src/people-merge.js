'use strict';
const { tx } = require('./db');
const { displayPhone } = require('./phone');

/** Error con un mensaje que se puede mostrar tal cual a quien usa el panel. */
class MergeError extends Error {}

/** Clave para detectar nombres repetidos: sin tildes, sin emojis ni signos, en minúsculas y con espacios simples. */
function nameKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PHONE_LIKE = /^[+\d\s().-]+$/;
const splitRoles = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Une dos listas de roles separadas por comas sin repetir ninguno (sin distinguir mayúsculas ni tildes). */
function mergeRoles(a, b) {
  const out = [];
  const seen = new Set();
  for (const r of [...splitRoles(a), ...splitRoles(b)]) {
    const k = nameKey(r);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out.join(', ');
}

/** Si ambas tienen notas distintas se conservan las dos. */
function mergeNotes(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!y || x.includes(y)) return x;
  if (!x) return y;
  return `${x}\n---\n${y}`;
}

const rank = (p) => [new Date(p.created_at).getTime(), p.id];
/** La ficha más antigua se conserva; con la misma fecha, la de id menor. */
function pickKeep(a, b) {
  const [ta, ia] = rank(a);
  const [tb, ib] = rank(b);
  return ta < tb || (ta === tb && ia < ib) ? [a, b] : [b, a];
}

/** Valores que quedan en la ficha conservada. Función pura: se puede probar sin base de datos. */
function mergedFields(keep, other, { inheritOptIn = false } = {}) {
  const takeGoogle = !keep.google_email && Boolean(other.google_email);
  let membership = keep.membership || other.membership || '';
  if (keep.membership && other.membership && keep.membership !== other.membership) membership = 'miembro'; // un miembro también es un amigo
  // Si las dos tenían un dato distinto en un campo único, el de la ficha sobrante no se pierde: queda en las notas.
  const lost = [];
  if (keep.phone && other.phone && keep.phone !== other.phone) lost.push(`Teléfono de la ficha unida: ${displayPhone(other.phone)}`);
  if (keep.email && other.email && keep.email.toLowerCase() !== other.email.toLowerCase()) lost.push(`Correo de la ficha unida: ${other.email}`);
  if (keep.google_email && other.google_email && keep.google_email.toLowerCase() !== other.google_email.toLowerCase()) lost.push(`Correo de Google de la ficha unida: ${other.google_email}`);
  return {
    full_name: PHONE_LIKE.test(keep.full_name) && other.full_name && !PHONE_LIKE.test(other.full_name) ? other.full_name : keep.full_name,
    phone: keep.phone || other.phone || null,
    email: keep.email || other.email || null,
    google_email: keep.google_email || other.google_email || null,
    access_level: takeGoogle ? other.access_level : keep.access_level,
    role: mergeRoles(keep.role, other.role),
    notes: mergeNotes(mergeNotes(keep.notes, other.notes), lost.join('. ')),
    whatsapp_name: keep.whatsapp_name || other.whatsapp_name || '',
    membership,
    in_official_group: Boolean(keep.in_official_group || other.in_official_group),
    active: Boolean(keep.active || other.active),
    // El consentimiento NO se hereda solo: dos fichas con el mismo nombre pueden ser dos personas distintas.
    opt_in: Boolean(keep.opt_in || (inheritOptIn && other.opt_in)),
  };
}

const STAGE_COLS = [
  ['call_date', 'call_by'], ['meeting_date', 'meeting_by'], ['pp_start_date', 'pp_start_by'], ['pp_end_date', 'pp_end_by'],
  ['baptism_date', 'baptism_by'], ['group_date', 'group_by'], ['riel_date', 'riel_by'],
];
const PERSON_REFS = ['assigned_to', 'call_by', 'meeting_by', 'pp_start_by', 'pp_end_by', 'baptism_by', 'group_by', 'riel_by'];

/**
 * Une dos fichas en una sola transacción. Se conserva la más antigua y se elimina la otra.
 * Devuelve un resumen de lo que se movió. Si algo falla, no se cambia nada.
 */
async function mergePeople(pool, idA, idB, { inheritOptIn = false } = {}) {
  const a = Number(idA);
  const b = Number(idB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) throw new MergeError('Elige dos personas válidas.');
  if (a === b) throw new MergeError('Elige dos personas distintas.');

  return tx(pool, async (db) => {
    const rows = (await db.query('SELECT * FROM people WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[a, b]])).rows;
    if (rows.length !== 2) throw new MergeError('Una de las dos personas ya no existe.');
    const [keep, other] = pickKeep(rows[0], rows[1]);
    const m = mergedFields(keep, other, { inheritOptIn });
    const summary = {
      keepId: keep.id, keepName: m.full_name, removedId: other.id, removedName: other.full_name,
      ministries: 0, events: 0, conversations: 0, consolidation: 'ninguna', nuevaVida: 0,
      optInNotInherited: Boolean(other.opt_in && !m.opt_in),
    };

    // 1) Teléfono, correo y correo de Google son únicos: se liberan en la ficha sobrante antes de copiarlos.
    await db.query('UPDATE people SET phone = NULL, email = NULL, google_email = NULL WHERE id = $1', [other.id]);
    await db.query(
      `UPDATE people SET full_name=$2, phone=$3, email=$4, google_email=$5, access_level=$6, role=$7, notes=$8,
              whatsapp_name=$9, membership=$10, in_official_group=$11, active=$12, opt_in=$13, updated_at=now() WHERE id=$1`,
      [keep.id, m.full_name, m.phone, m.email, m.google_email, m.access_level, m.role, m.notes, m.whatsapp_name, m.membership, m.in_official_group, m.active, m.opt_in]
    );

    // 2) Ministerios: se unen; si la otra era coordinadora, ahora lo es la conservada.
    summary.ministries = (
      await db.query(
        `INSERT INTO person_ministries (person_id, ministry_id)
         SELECT $1, ministry_id FROM person_ministries WHERE person_id = $2 ON CONFLICT DO NOTHING`,
        [keep.id, other.id]
      )
    ).rowCount;
    await db.query('UPDATE ministries SET coordinator_id = $1 WHERE coordinator_id = $2', [keep.id, other.id]);

    // 3) Eventos. Donde participaban las dos, se conserva la respuesta más informativa y se pasan los mensajes.
    const both = (
      await db.query(
        `SELECT k.id AS kid, o.id AS oid, k.status AS ks, o.status AS os, o.responded_at, o.response_channel
           FROM event_participants k JOIN event_participants o ON o.event_id = k.event_id
          WHERE k.person_id = $1 AND o.person_id = $2`,
        [keep.id, other.id]
      )
    ).rows;
    for (const e of both) {
      if (e.ks === 'pendiente' && e.os !== 'pendiente') {
        await db.query('UPDATE event_participants SET status=$2, responded_at=$3, response_channel=$4 WHERE id=$1', [e.kid, e.os, e.responded_at, e.response_channel]);
      }
      await db.query(
        `UPDATE notifications n SET participant_id = $1
          WHERE n.participant_id = $2
            AND (n.kind = 'manual' OR NOT EXISTS (SELECT 1 FROM notifications x WHERE x.participant_id = $1 AND x.kind = n.kind AND x.channel = n.channel))`,
        [e.kid, e.oid]
      );
      await db.query('DELETE FROM event_participants WHERE id = $1', [e.oid]);
    }
    const moved = await db.query(
      `UPDATE event_participants SET person_id = $1
        WHERE person_id = $2 AND event_id NOT IN (SELECT event_id FROM event_participants WHERE person_id = $1)`,
      [keep.id, other.id]
    );
    summary.events = both.length + moved.rowCount;

    // 4) Conversaciones con el asistente.
    summary.conversations = (await db.query('UPDATE agent_messages SET person_id = $1 WHERE person_id = $2', [keep.id, other.id])).rowCount;

    // 5) Consolidación. Solo puede haber una por persona: si las dos tenían, se unen en la de la ficha conservada.
    const ck = (await db.query('SELECT * FROM consolidation WHERE person_id = $1', [keep.id])).rows[0];
    const co = (await db.query('SELECT * FROM consolidation WHERE person_id = $1', [other.id])).rows[0];
    if (co && !ck) {
      await db.query('UPDATE consolidation SET person_id = $1, updated_at = now() WHERE id = $2', [keep.id, co.id]);
      summary.consolidation = 'movida';
    } else if (co && ck) {
      const sets = STAGE_COLS.map(([d, by]) => `${d} = COALESCE(c.${d}, o.${d}), ${by} = CASE WHEN c.${d} IS NOT NULL THEN c.${by} ELSE o.${by} END`).join(', ');
      await db.query(
        `UPDATE consolidation c SET ${sets},
                decision_date = LEAST(c.decision_date, o.decision_date),
                sede = CASE WHEN c.sede = '' THEN o.sede ELSE c.sede END,
                invited_by = CASE WHEN c.invited_by = '' THEN o.invited_by ELSE c.invited_by END,
                group_name = CASE WHEN c.group_name = '' THEN o.group_name ELSE c.group_name END,
                assigned_to = COALESCE(c.assigned_to, o.assigned_to),
                last_seen_date = COALESCE(c.last_seen_date, o.last_seen_date),
                do_not_call = c.do_not_call OR o.do_not_call,
                historical = c.historical AND o.historical,
                updated_at = now()
           FROM consolidation o WHERE c.id = $1 AND o.id = $2`,
        [ck.id, co.id]
      );
      await db.query('UPDATE consolidation_calls SET consolidation_id = $1 WHERE consolidation_id = $2', [ck.id, co.id]);
      await db.query('UPDATE consolidation_status_log SET consolidation_id = $1 WHERE consolidation_id = $2', [ck.id, co.id]);
      await db.query('UPDATE nueva_vida SET consolidation_id = $1 WHERE consolidation_id = $2', [ck.id, co.id]);
      await db.query('DELETE FROM consolidation WHERE id = $1', [co.id]);
      summary.consolidation = 'unida';
    }
    // Donde la otra persona figuraba como responsable o quien llamó, ahora figura la conservada.
    for (const col of PERSON_REFS) await db.query(`UPDATE consolidation SET ${col} = $1 WHERE ${col} = $2`, [keep.id, other.id]);
    await db.query('UPDATE consolidation_calls SET called_by = $1 WHERE called_by = $2', [keep.id, other.id]);

    // 6) Registros de Nueva Vida.
    summary.nuevaVida = (await db.query('UPDATE nueva_vida SET person_id = $1 WHERE person_id = $2', [keep.id, other.id])).rowCount;

    // 7) Ya no queda nada que apunte a la ficha sobrante.
    await db.query('DELETE FROM people WHERE id = $1', [other.id]);
    return summary;
  });
}

/** Grupos de personas con el mismo nombre normalizado. Cada grupo va de la ficha más antigua a la más nueva. */
async function duplicateGroups(db) {
  const { rows } = await db.query(
    `SELECT p.id, p.full_name, p.phone, p.email, p.created_at, p.membership, p.in_official_group, p.active, p.role,
            (SELECT count(*)::int FROM person_ministries pm WHERE pm.person_id = p.id) AS ministries,
            (SELECT count(*)::int FROM event_participants ep WHERE ep.person_id = p.id) AS events,
            EXISTS (SELECT 1 FROM consolidation c WHERE c.person_id = p.id) AS in_consolidation
       FROM people p ORDER BY p.created_at, p.id`
  );
  const groups = new Map();
  for (const r of rows) {
    const k = nameKey(r.full_name);
    if (k.length < 3) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || nameKey(a[0].full_name).localeCompare(nameKey(b[0].full_name)));
}

/** Posibles duplicados de una persona concreta (mismo nombre normalizado). */
async function duplicatesOf(db, id) {
  const me = (await db.query('SELECT full_name FROM people WHERE id = $1', [id])).rows[0];
  if (!me) return [];
  const key = nameKey(me.full_name);
  if (key.length < 3) return [];
  const { rows } = await db.query('SELECT id, full_name, phone, email, created_at FROM people WHERE id <> $1', [id]);
  return rows.filter((r) => nameKey(r.full_name) === key);
}

/** Todo lo que cuelga de una persona, para mostrarlo antes de unir. */
async function summaryOf(db, id) {
  const p = (await db.query('SELECT * FROM people WHERE id = $1', [id])).rows[0];
  if (!p) return null;
  const one = async (sql) => (await db.query(sql, [id])).rows[0].n;
  return {
    ...p,
    ministries: (await db.query('SELECT m.name FROM person_ministries pm JOIN ministries m ON m.id = pm.ministry_id WHERE pm.person_id = $1 ORDER BY m.name', [id])).rows.map((r) => r.name),
    events: await one('SELECT count(*)::int AS n FROM event_participants WHERE person_id = $1'),
    conversations: await one('SELECT count(*)::int AS n FROM agent_messages WHERE person_id = $1'),
    consolidation: (await one('SELECT count(*)::int AS n FROM consolidation WHERE person_id = $1')) > 0,
    nuevaVida: await one('SELECT count(*)::int AS n FROM nueva_vida WHERE person_id = $1'),
  };
}

module.exports = { MergeError, nameKey, mergeRoles, mergeNotes, pickKeep, mergedFields, mergePeople, duplicateGroups, duplicatesOf, summaryOf };
