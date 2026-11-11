'use strict';
const cg = require('./care-groups');

/**
 * Remoto de reporte APARTE del enlace del grupo: un solo enlace para todos los líderes (`/reportes/<token>`),
 * pensado para guardarlo en el teléfono y reportar cada semana sin generar ni enviar enlaces nuevos.
 * El líder solo escribe su nombre. Si ese nombre coincide con el `leader_name` de UN solo grupo activo,
 * el reporte entra directo a ese grupo; si no se reconoce (o dos grupos comparten líder), queda guardado
 * como pendiente en `care_group_report_submissions` para que el panel lo asigne — nunca se pierde.
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

/** El grupo del líder por su nombre: solo si hay exactamente UN grupo activo con ese líder. */
async function findGroupByLeaderName(db, name) {
  const key = keyOf(name);
  if (!key) return null;
  const { rows } = await db.query('SELECT id, name, leader_name FROM care_groups WHERE active');
  const hits = rows.filter((g) => keyOf(g.leader_name) === key);
  return hits.length === 1 ? hits[0] : null;
}

const REPORT_COLS = ['meeting_date', 'members_count', 'guests_count', 'attendance', 'offering', 'offering_fx', 'payment_ref', 'snack', 'dynamics', 'testimonies', 'songs', 'key_element', 'notes', 'followup', 'advisor_visit', 'start_time', 'end_time', 'stage', 'stage_week', 'recent_guests', 'leader_wed', 'leader_sun'];

/**
 * Guarda el reporte que llegó por el enlace común. Devuelve { applied: true, group, created } si entró directo
 * a su grupo, o { applied: false, submissionId } si quedó pendiente de asignar en el panel.
 */
async function saveCommonReport(db, leaderName, value) {
  const group = await findGroupByLeaderName(db, leaderName);
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

/** Asigna un reporte pendiente a su grupo: entra como reporte normal (reenviar la misma fecha corrige). */
async function applySubmission(db, id, groupId) {
  const { rows } = await db.query("SELECT * FROM care_group_report_submissions WHERE id = $1 AND status = 'pendiente'", [id]);
  const s = rows[0];
  if (!s) return false;
  const g = (await db.query('SELECT id FROM care_groups WHERE id = $1 AND active', [groupId])).rows[0];
  if (!g) return false;
  const value = Object.fromEntries(REPORT_COLS.map((c) => [c, s[c]]));
  value.meeting_date = typeof s.meeting_date === 'string' ? s.meeting_date : new Date(s.meeting_date).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  await cg.upsertReport(db, g.id, value, SOURCE);
  await db.query("UPDATE care_group_report_submissions SET status = 'aplicada', group_id = $2, resolved_at = now() WHERE id = $1", [id, g.id]);
  return true;
}
async function discardSubmission(db, id) {
  const r = await db.query("UPDATE care_group_report_submissions SET status = 'descartada', resolved_at = now() WHERE id = $1 AND status = 'pendiente'", [id]);
  return r.rowCount > 0;
}

module.exports = { SOURCE, keyOf, getLink, ensureLink, regenerateLink, setLinkActive, linkIsValid, parseLeaderName, findGroupByLeaderName, saveCommonReport, listPending, countPending, applySubmission, discardSubmission };
