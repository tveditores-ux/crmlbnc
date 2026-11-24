'use strict';
const cg = require('./care-groups');

/**
 * Remoto de reporte APARTE del enlace del grupo: un solo enlace para todos los líderes (`/reportes/<token>`),
 * pensado para guardarlo en el teléfono y reportar cada semana sin generar ni enviar enlaces nuevos.
 * El líder solo escribe su nombre (si lleva varios grupos, además elige cuál). El reporte entra DIRECTO al grupo
 * de quien lo envía: el nombre se reconoce por sus palabras (sin tildes, mayúsculas ni conectores como «y» o «de»)
 * contra el líder Y el co-líder de cada grupo activo — vale el nombre completo, una parte («Luis Vasquez» por
 * «Luis Miguel Vasquez»), la forma de casada («Ana de Fersaca») o la pareja junta («Luis y Ana Vasquez»). Si apunta
 * a un solo grupo, entra a ese; si la persona lleva varios grupos, elige el suyo en el remoto; si no se reconoce,
 * queda guardado como pendiente en `care_group_report_submissions` — nunca se pierde — y entra solo en cuanto el
 * nombre apunte a un solo grupo (la página del panel corre `autoAssignPending` al abrirse). No hay asignación
 * manual: la quitó el pastor el 2026-11-23 («que lo asigne directo al grupo del líder que envía el reporte»).
 * El token vive en `care_settings` (`reporte_token` / `reporte_active`), como la libretica y `/registro`.
 */
const TOKEN_KEY = 'reporte_token';
const ACTIVE_KEY = 'reporte_active';
const SOURCE = 'enlace_comun';

/** Comparación de nombres sin tildes, sin mayúsculas y con los espacios limpios (la misma idea que care-intake). */
const keyOf = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function getLink(db) {
  const { rows } = await db.query('SELECT key, value FROM care_settings WHERE key IN ($1, $2)', [TOKEN_KEY, ACTIVE_KEY]);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { token: m[TOKEN_KEY] || '', active: m[ACTIVE_KEY] !== 'no' };
}
async function ensureLink(db) {
  const cur = await getLink(db);
  if (cur.token) return cur;
  await db.query('INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [TOKEN_KEY, cg.newToken()]);
  return getLink(db);
}
async function regenerateLink(db) {
  await db.query('INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [TOKEN_KEY, cg.newToken()]);
  await db.query('INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [ACTIVE_KEY, 'si']);
}
async function setLinkActive(db, on) {
  await db.query('INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [ACTIVE_KEY, on ? 'si' : 'no']);
}
/** Solo el enlace vigente y encendido abre el remoto. */
async function linkIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const l = await getLink(db);
  return l.active && l.token === token;
}

/** Valida el nombre que escribe el líder: con nombre y apellido, para poder reconocer su grupo. */
function parseLeaderName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 3) return { error: 'Escribe tu nombre para saber de quién es el reporte.' };
  if (name.length > 80) return { error: 'El nombre es muy largo (máximo 80 letras).' };
  if (name.split(' ').length < 2) return { error: 'Escribe tu nombre y tu apellido, para reconocer tu grupo.' };
  return { value: name };
}

const CONNECTORS = new Set(['y', 'e', 'de', 'del', 'la', 'el', 'los', 'las']);
/** Las palabras con peso de un nombre: sin tildes ni mayúsculas (keyOf) y sin conectores («Ana de Fersaca» → ana, fersaca). */
const wordSet = (name) => new Set(keyOf(name).split(' ').filter((w) => w && !CONNECTORS.has(w)));
const isSubset = (a, b) => a.size > 0 && [...a].every((w) => b.has(w));

/**
 * ¿El nombre escrito es el de quien lidera este grupo? Vale contra el líder o el co-líder:
 * el nombre escrito está contenido en el registrado (escribió una parte, o la forma de casada),
 * o el registrado está contenido en el escrito (escribió la pareja junta). Hacen falta 2+ palabras.
 */
function nameMatches(typed, leader, coLeader) {
  const t = wordSet(typed);
  if (t.size < 2) return false;
  const l = wordSet(leader);
  const c = wordSet(coLeader);
  const union = new Set([...l, ...c]);
  if (isSubset(t, union)) return true;
  if (l.size >= 2 && isSubset(l, t)) return true;
  if (c.size >= 2 && isSubset(c, t)) return true;
  return false;
}

/**
 * Los grupos activos que lidera esa persona: su nombre se reconoce por palabras contra el líder o el
 * co-líder del grupo. Un líder puede llevar más de un grupo; entonces el remoto le pide elegir.
 */
async function groupsForLeaderName(db, name) {
  if (!keyOf(name)) return [];
  const { rows } = await db.query('SELECT id, name, leader_name, co_leader_name FROM care_groups WHERE active ORDER BY name, id');
  return rows.filter((g) => nameMatches(name, g.leader_name, g.co_leader_name));
}

/** El grupo del líder por su nombre: solo si hay exactamente UN grupo activo con ese líder. */
async function findGroupByLeaderName(db, name) {
  const hits = await groupsForLeaderName(db, name);
  return hits.length === 1 ? hits[0] : null;
}

const REPORT_COLS = ['meeting_date', 'members_count', 'guests_count', 'attendance', 'offering', 'offering_fx', 'payment_ref', 'snack', 'dynamics', 'testimonies', 'songs', 'key_element', 'notes', 'followup', 'advisor_visit', 'start_time', 'end_time', 'stage', 'stage_week', 'recent_guests', 'leader_wed', 'leader_sun'];

/**
 * Guarda el reporte que llegó por el enlace común. Devuelve:
 * - { applied: true, group, created } si entró directo a su grupo;
 * - { needsChoice: true, groups } si la persona lidera más de un grupo y no eligió uno de los suyos (no guarda nada:
 *   el remoto le muestra sus grupos para que elija);
 * - { applied: false, submissionId } si el nombre no coincide con ningún grupo: queda guardado y entra solo
 *   cuando el nombre apunte a un solo grupo (ver `autoAssignPending`); nadie lo asigna a mano.
 * `groupId` solo vale si es uno de los grupos de esa persona: no se puede reportar en un grupo ajeno.
 */
async function saveCommonReport(db, leaderName, value, groupId = null) {
  const hits = await groupsForLeaderName(db, leaderName);
  let group = hits.length === 1 ? hits[0] : null;
  if (hits.length > 1) {
    group = hits.find((g) => String(g.id) === String(groupId || '')) || null;
    if (!group) return { needsChoice: true, groups: hits };
  }
  if (group) {
    const out = await cg.upsertReport(db, group.id, value, SOURCE);
    return { applied: true, group, created: out.created };
  }
  const vals = REPORT_COLS.map((c) => value[c] ?? null);
  const { rows } = await db.query(
    `INSERT INTO care_group_report_submissions (leader_name, ${REPORT_COLS.join(', ')}) VALUES ($1, ${REPORT_COLS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [leaderName, ...vals]
  );
  return { applied: false, submissionId: rows[0].id };
}

async function listPending(db) {
  const { rows } = await db.query("SELECT * FROM care_group_report_submissions WHERE status = 'pendiente' ORDER BY created_at, id");
  return rows;
}
async function countPending(db) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM care_group_report_submissions WHERE status = 'pendiente'");
  return rows[0].n;
}

/** Un reporte guardado entra a su grupo: como reporte normal (reenviar la misma fecha corrige). */
async function applyToGroup(db, s, group) {
  const value = Object.fromEntries(REPORT_COLS.map((c) => [c, s[c]]));
  value.meeting_date = typeof s.meeting_date === 'string' ? s.meeting_date : new Date(s.meeting_date).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  await cg.upsertReport(db, group.id, value, SOURCE);
  await db.query("UPDATE care_group_report_submissions SET status = 'aplicada', group_id = $2, resolved_at = now() WHERE id = $1", [s.id, group.id]);
}

/**
 * Asignación automática de los guardados: cada reporte pendiente cuyo nombre ya apunta a UN solo
 * grupo entra directo a ese grupo, sin que nadie lo asigne a mano. Devuelve cuántos entraron.
 */
async function autoAssignPending(db) {
  const pending = await listPending(db);
  let applied = 0;
  for (const s of pending) {
    const hits = await groupsForLeaderName(db, s.leader_name);
    if (hits.length !== 1) continue;
    await applyToGroup(db, s, hits[0]);
    applied++;
  }
  return applied;
}

module.exports = { SOURCE, keyOf, getLink, ensureLink, regenerateLink, setLinkActive, linkIsValid, parseLeaderName, nameMatches, groupsForLeaderName, findGroupByLeaderName, saveCommonReport, listPending, countPending, autoAssignPending };
