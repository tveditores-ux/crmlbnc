'use strict';
const cg = require('./care-groups');
const nv = require('./nuevavida/store');

/**
 * Registro de nuevos creyentes para llenar EL DÍA de la conversión (pedido del pastor, 2026-11-15):
 * un solo enlace (`/nuevos-creyentes/<token>`, token en care_settings) que el equipo de Nueva Vida
 * abre en el teléfono en el momento de la decisión. Lo enviado entra directo a la lista de Nueva
 * Vida (`nueva_vida`) marcado «por revisar», con la fuente «Enlace del día de conversión», para que
 * el panel lo revise y lo conecte a consolidación — nunca se pierde y Grace pastoral lo ve al
 * instante en su herramienta de nuevos creyentes.
 */
const TOKEN_KEY = 'nuevo_creyente_token';
const ACTIVE_KEY = 'nuevo_creyente_active';
const SOURCE = 'Enlace del día de conversión';
const REVIEW_NOTE = 'Llegó por el enlace del día de conversión: revisar y conectar a consolidación.';

const HOW_ARRIVED = [
  'Invitado por un hermano de la iglesia',
  'Invitado por un familiar',
  'Invitado por un amigo o vecino',
  'Llegó por un grupo de cuidado',
  'Por las redes sociales',
  'Pasaba por la iglesia',
  'Otro',
];

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

/** Las sedes que ya usa la lista de Nueva Vida, para ofrecerlas en el formulario. */
async function listSedes(db) {
  const { rows } = await db.query("SELECT DISTINCT sede FROM nueva_vida WHERE sede <> '' ORDER BY sede");
  return rows.map((r) => r.sede);
}

/**
 * Valida lo que se llena en el momento de la conversión. Lo esencial va obligatorio — nombre y
 * apellido, WhatsApp (para la llamada de seguimiento), fecha de la decisión (hoy por defecto),
 * sede y cómo llegó — y el resto es opcional, para no frenar el registro en el momento.
 * La limpieza de cada campo la hace el mismo validateRow de la lista de Nueva Vida.
 */
function parseSubmission(body, countryCode = '58', today) {
  const raw = {
    name: body.full_name,
    phone: body.phone,
    email: body.email,
    decision_date: body.decision_date,
    sede: body.sede,
    age: body.age,
    civil_status: body.civil_status,
    address: body.address,
    how_arrived: body.how_arrived,
  };
  const { value, errors } = nv.validateRow(raw, countryCode, today);
  const name = String(body.full_name || '').trim();
  if (!name) errors.push('Escribe el nombre y el apellido del nuevo creyente.');
  else if (name.split(/\s+/).length < 2) errors.push('Escribe el nombre y el apellido, para poder identificarlo.');
  if (!String(body.phone || '').trim()) errors.push('Escribe su número de WhatsApp: es el medio para llamarlo en el seguimiento.');
  if (!String(body.decision_date || '').trim()) errors.push('Escribe la fecha de la decisión (la de hoy, si se convirtió hoy).');
  if (!String(body.sede || '').trim()) errors.push('Elige la sede donde se convirtió.');
  if (!String(body.how_arrived || '').trim()) errors.push('Elige cómo llegó a la iglesia.');
  return { value, errors: [...new Set(errors)] };
}

/** Guarda el registro en la lista de Nueva Vida, marcado por revisar. Devuelve el id. */
async function submit(db, v) {
  const { rows } = await db.query(
    `INSERT INTO nueva_vida (full_name, phone, email, decision_date, date_note, sede, age, civil_status, address, how_arrived, followup, note, needs_review, review_note, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'','',TRUE,$11,$12) RETURNING id`,
    [v.full_name, v.phone, v.email, v.decision_date, v.date_note, v.sede, v.age, v.civil_status, v.address, v.how_arrived, REVIEW_NOTE, SOURCE]
  );
  return rows[0].id;
}

/** Cuántos registros del enlace esperan revisión en el panel. */
async function countPending(db) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM nueva_vida WHERE needs_review AND source = $1', [SOURCE]);
  return rows[0].n;
}

module.exports = {
  TOKEN_KEY, ACTIVE_KEY, SOURCE, HOW_ARRIVED,
  getLink, ensureLink, regenerateLink, setLinkActive, linkIsValid,
  listSedes, parseSubmission, submit, countPending,
};
