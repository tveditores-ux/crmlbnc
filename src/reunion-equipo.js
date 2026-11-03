'use strict';
const crypto = require('crypto');

/** Hoja de la reunión extendida de equipo: casillas de texto que se guardan solas. */

const ENTREVISTA = [
  ['e1', '1. ¿Cuándo sentiste que Dios te llamó a servir en lo que haces hoy?'],
  ['e2', '2. ¿Qué es lo más pesado de tu área que quizá el resto no ve?'],
  ['e3', '3. ¿En qué puedo ayudarte yo, aunque no sea mi área?'],
];
const TEMAS = [
  { k: 't1', title: 'Recibir y acompañar', q: 'Cómo recibimos y acompañamos a una persona nueva' },
  { k: 't2', title: 'Comunicarnos', q: 'Cómo nos comunicamos' },
  { k: 't3', title: 'Servicios y GdeC', q: 'Nuestros servicios y los grupos de cuidado' },
  { k: 't4', title: 'Cuidarnos', q: 'Cómo nos cuidamos y trabajamos entre nosotros' },
];
const CAMPOS_TEMA = [
  ['a', 'Qué está funcionando'],
  ['b', 'Dónde nos descoordinamos'],
  ['c', 'Qué propongo'],
];
const ACUERDOS = [1, 2, 3, 4];

/** Únicas claves aceptadas (el servidor no guarda nada fuera de esta lista). */
const KEYS = new Set([
  ...ENTREVISTA.map(([k]) => k),
  ...TEMAS.flatMap((t) => CAMPOS_TEMA.map(([c]) => t.k + c)),
  ...ACUERDOS.flatMap((n) => [`ac${n}`, `ac${n}r`, `ac${n}f`]),
]);
const MAX_LEN = 5000;

async function loadAll(db) {
  const { rows } = await db.query('SELECT key, value FROM reunion_equipo');
  const out = {};
  for (const r of rows) if (KEYS.has(r.key)) out[r.key] = r.value;
  return out;
}

/** Guarda una casilla. Devuelve false si la clave no existe. Un texto vacío borra la fila. */
async function saveField(db, key, value) {
  if (!KEYS.has(key)) return false;
  const v = String(value ?? '').replace(/\r\n/g, '\n').slice(0, MAX_LEN);
  if (!v.trim()) {
    await db.query('DELETE FROM reunion_equipo WHERE key = $1', [key]);
    return true;
  }
  await db.query(
    `INSERT INTO reunion_equipo (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, v]
  );
  return true;
}

async function clearAll(db) {
  await db.query('DELETE FROM reunion_equipo');
}

/* ---------- Enlace remoto (libreta personal, sin sesión del panel) ----------
 * El token vive en care_settings (misma tabla de ajustes que el enlace común de líderes). */
const newToken = () => crypto.randomBytes(16).toString('base64url');

async function getLink(db) {
  const { rows } = await db.query("SELECT key, value FROM care_settings WHERE key IN ('reunion_token', 'reunion_active')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { token: m.reunion_token || '', active: m.reunion_active !== 'no' };
}
async function ensureLink(db) {
  const cur = await getLink(db);
  if (cur.token) return cur;
  await db.query("INSERT INTO care_settings (key, value) VALUES ('reunion_token', $1) ON CONFLICT (key) DO NOTHING", [newToken()]);
  return getLink(db);
}
async function regenerateLink(db) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('reunion_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [newToken()]);
  await db.query("INSERT INTO care_settings (key, value) VALUES ('reunion_active', 'si') ON CONFLICT (key) DO UPDATE SET value = 'si'");
}
async function setLinkActive(db, on) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('reunion_active', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [on ? 'si' : 'no']);
}
/** Solo el enlace vigente y encendido abre la libreta. */
async function linkIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const l = await getLink(db);
  return l.active && l.token === token;
}

module.exports = { getLink, ensureLink, regenerateLink, setLinkActive, linkIsValid, ENTREVISTA, TEMAS, CAMPOS_TEMA, ACUERDOS, KEYS, MAX_LEN, loadAll, saveField, clearAll };
