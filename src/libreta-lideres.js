'use strict';
const crypto = require('crypto');

/**
 * Libreta de líderes — propuestas: hoja hermana de la de Reunión de equipo, con contenido nuevo.
 * El contenido es DATO EN CÓDIGO: las 7 propuestas de líderes/coordinadores que salieron de las
 * respuestas del equipo (punto que cada uno expuso + solución clave). El equipo pastoral NO va
 * en esta libreta. Por persona hay tres casillas que se llenan: acuerdo de hoy, primer paso y
 * fecha, y revisión.
 */

const PERSONAS = [
  {
    n: 1,
    name: 'Gabriel Alvarado',
    punto: 'La demanda de tiempo que exige la cantidad de personas de su equipo.',
    solucion: 'Dividir su equipo en grupos pequeños, cada uno con un responsable, para que no tenga que atenderlos a todos directamente.',
  },
  {
    n: 2,
    name: 'Gabriel Sánchez',
    punto: 'Le cuesta conectar sus palabras y lograr que los jóvenes sean conscientes de la virtud de ser jóvenes cristianos.',
    solucion: 'Trabajar con los jóvenes una serie continua sobre su identidad como jóvenes cristianos, en vez de temas sueltos.',
  },
  {
    n: 3,
    name: 'Laura Vargas',
    punto: 'Hace el cronograma de cada servicio y se desgasta esperando que los servidores confirmen si pueden o no.',
    solucion: 'Cronograma con fecha límite de confirmación: quien no confirma a tiempo, entra el suplente. Sin perseguir a nadie.',
  },
  {
    n: 4,
    name: 'Linda Hernández',
    punto: 'Da las instrucciones confiando en que cada quien hará lo que le corresponde, y no sucede.',
    solucion: 'Instrucciones por escrito — qué, quién y para cuándo — con confirmación de recibido y un chequeo a mitad de camino.',
  },
  {
    n: 5,
    name: 'Silmar Alvarado',
    punto: 'Se hacen cambios de repente y no se ve el porqué se hacen.',
    solucion: 'Ningún cambio se aplica sin comunicarlo antes y con su razón explicada.',
  },
  {
    n: 6,
    name: 'Yamilet Abarca de Escalona',
    punto: 'Su equipo no tiene la visión clara y sirve a su manera; hay quienes sirven pero no van a GDC ni se congregan.',
    solucion: 'Reunión de alineación con cada equipo donde queden por escrito la visión y los compromisos básicos del servidor, congregarse y asistir a su GDC incluidos, con seguimiento.',
  },
  {
    n: 7,
    name: 'Yanethsy Pauvil',
    punto: 'No le alcanza el tiempo para cumplir con cada líder y con las actividades.',
    solucion: 'Atender a sus líderes por agenda, con una frecuencia de contacto definida para cada uno, en bloques de tiempo, no a medida que todo llega.',
  },
];

const CAMPOS = [
  ['a', 'Acuerdo de hoy'],
  ['b', 'Primer paso y fecha'],
  ['c', 'Revisión'],
];

/** Clave de la casilla `campo` de la persona `n`: l1a … l7c. */
const keyOf = (n, campo) => `l${n}${campo}`;

/** Únicas claves aceptadas (el servidor no guarda nada fuera de esta lista). */
const KEYS = new Set(PERSONAS.flatMap((p) => CAMPOS.map(([c]) => keyOf(p.n, c))));
const MAX_LEN = 5000;

async function loadAll(db) {
  const { rows } = await db.query('SELECT key, value FROM libreta_lideres');
  const out = {};
  for (const r of rows) if (KEYS.has(r.key)) out[r.key] = r.value;
  return out;
}

/** Guarda una casilla. Devuelve false si la clave no existe. Un texto vacío borra la fila. */
async function saveField(db, key, value) {
  if (!KEYS.has(key)) return false;
  const v = String(value ?? '').replace(/\r\n/g, '\n').slice(0, MAX_LEN);
  if (!v.trim()) {
    await db.query('DELETE FROM libreta_lideres WHERE key = $1', [key]);
    return true;
  }
  await db.query(
    `INSERT INTO libreta_lideres (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, v]
  );
  return true;
}

async function clearAll(db) {
  await db.query('DELETE FROM libreta_lideres');
}

/* ---------- Enlace remoto (libreta personal, sin sesión del panel) ----------
 * El token vive en care_settings, con claves propias (no las de reunión de equipo ni las del REDIL). */
const newToken = () => crypto.randomBytes(16).toString('base64url');

async function getLink(db) {
  const { rows } = await db.query("SELECT key, value FROM care_settings WHERE key IN ('libreta_lideres_token', 'libreta_lideres_active')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { token: m.libreta_lideres_token || '', active: m.libreta_lideres_active !== 'no' };
}
async function ensureLink(db) {
  const cur = await getLink(db);
  if (cur.token) return cur;
  await db.query("INSERT INTO care_settings (key, value) VALUES ('libreta_lideres_token', $1) ON CONFLICT (key) DO NOTHING", [newToken()]);
  return getLink(db);
}
async function regenerateLink(db) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('libreta_lideres_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [newToken()]);
  await db.query("INSERT INTO care_settings (key, value) VALUES ('libreta_lideres_active', 'si') ON CONFLICT (key) DO UPDATE SET value = 'si'");
}
async function setLinkActive(db, on) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('libreta_lideres_active', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [on ? 'si' : 'no']);
}
/** Solo el enlace vigente y encendido abre la libreta. */
async function linkIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const l = await getLink(db);
  return l.active && l.token === token;
}

/* ---------- Respuestas enviadas por los líderes ---------- */
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Valida lo que llega del teléfono. Devuelve { value, errors }. Solo pasan las casillas conocidas. */
function parseSubmission(body) {
  const b = body || {};
  const errors = [];
  const name = String(b.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name.length < 2) errors.push('Escribe tu nombre.');
  const device = String(b.device ?? '');
  if (!DEVICE_RE.test(device)) errors.push('Aparato no válido.');
  const answers = {};
  const raw = b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : {};
  for (const k of Object.keys(raw)) {
    if (!KEYS.has(k)) continue;
    const v = String(raw[k] ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_LEN);
    if (v) answers[k] = v;
  }
  if (!Object.keys(answers).length) errors.push('Escribe al menos una respuesta antes de enviar.');
  return { value: { device, name, answers }, errors };
}

async function saveSubmission(db, { device, name, answers }) {
  await db.query(
    `INSERT INTO libreta_lideres_respuestas (device_id, name, answers) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (device_id) DO UPDATE SET name = EXCLUDED.name, answers = EXCLUDED.answers, updated_at = now()`,
    [device, name, JSON.stringify(answers)]
  );
}
async function listSubmissions(db) {
  const { rows } = await db.query('SELECT id, name, answers, updated_at FROM libreta_lideres_respuestas ORDER BY lower(name), id');
  return rows;
}
async function countSubmissions(db) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM libreta_lideres_respuestas');
  return rows[0].n;
}
async function deleteSubmission(db, id) {
  const { rowCount } = await db.query('DELETE FROM libreta_lideres_respuestas WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { parseSubmission, saveSubmission, listSubmissions, countSubmissions, deleteSubmission, getLink, ensureLink, regenerateLink, setLinkActive, linkIsValid, PERSONAS, CAMPOS, keyOf, KEYS, MAX_LEN, loadAll, saveField, clearAll };
