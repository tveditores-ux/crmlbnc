'use strict';
const crypto = require('node:crypto');
const webpush = require('./web-push');
const { normalizePhone } = require('./phone');

/**
 * Chat de líderes: una sala común donde líderes y servidores conversan entre ellos. Grace es una
 * usuaria más de la sala: responde cuando la mencionan en un mensaje, con un límite diario por
 * persona. Cada quien entra con SU enlace personal (desde su ficha):
 * el enlace identifica quién escribe y a quién se le avisa. Los avisos son notificaciones de la
 * propia app (Web Push), no WhatsApp: al llegar un mensaje nuevo se avisa a los demás miembros que
 * tengan las notificaciones activadas, con una pausa de 15 minutos entre avisos por persona (salvo
 * cuando Grace responde la pregunta de esa persona: ahí se avisa siempre).
 */

const newToken = () => crypto.randomBytes(24).toString('base64url');
const LIMIT_KEY = 'chat_grace_limite';
const DEFAULT_GRACE_LIMIT = 5;
const NOTIFY_PAUSE_MS = 15 * 60 * 1000;

// ---------- Enlace personal ----------
async function getLink(db, personId) {
  const { rows } = await db.query('SELECT * FROM person_chat_links WHERE person_id = $1', [personId]);
  return rows[0] || null;
}

async function ensureLink(db, personId) {
  const existing = await getLink(db, personId);
  if (existing) return existing;
  await db.query('INSERT INTO person_chat_links (person_id, token) VALUES ($1, $2) ON CONFLICT (person_id) DO NOTHING', [personId, newToken()]);
  return getLink(db, personId);
}

async function regenerate(db, personId) {
  await db.query(
    `INSERT INTO person_chat_links (person_id, token, active) VALUES ($1, $2, TRUE)
     ON CONFLICT (person_id) DO UPDATE SET token = EXCLUDED.token, active = TRUE, updated_at = now()`,
    [personId, newToken()]
  );
  return getLink(db, personId);
}

async function setActive(db, personId, on) {
  await db.query('UPDATE person_chat_links SET active = $2, updated_at = now() WHERE person_id = $1', [personId, Boolean(on)]);
  return getLink(db, personId);
}

/** Resuelve el enlace público: solo si existe, está activo y la persona está activa. */
async function byToken(db, token) {
  if (!token || typeof token !== 'string' || token.length > 80) return null;
  const { rows } = await db.query(
    `SELECT l.person_id, l.token, l.active, p.full_name, p.phone, p.opt_in, p.role, p.active AS person_active
       FROM person_chat_links l JOIN people p ON p.id = l.person_id WHERE l.token = $1`,
    [token]
  );
  const r = rows[0];
  if (!r || !r.active || !r.person_active) return null;
  return { person: { id: r.person_id, full_name: r.full_name, phone: r.phone, opt_in: r.opt_in, role: r.role }, token: r.token };
}

/** Miembros de la sala: personas con enlace activo. */
async function members(db) {
  const { rows } = await db.query(
    `SELECT p.id, p.full_name, p.role FROM person_chat_links l JOIN people p ON p.id = l.person_id
      WHERE l.active AND p.active ORDER BY p.full_name`
  );
  return rows;
}

// ---------- Sala ----------
async function postMessage(db, { personId = null, authorName = '', kind = 'persona', preguntaDe = null, body }) {
  const { rows } = await db.query(
    'INSERT INTO chat_room_messages (person_id, author_name, kind, pregunta_de, body) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
    [personId, authorName, kind, preguntaDe, body]
  );
  return rows[0];
}

async function listMessages(db, { sinceId = 0, limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT id, person_id, author_name, kind, pregunta_de, body, created_at FROM chat_room_messages
      WHERE id > $1 ORDER BY id LIMIT $2`,
    [sinceId, limit]
  );
  return rows;
}

async function recentMessages(db, limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM (SELECT id, person_id, author_name, kind, pregunta_de, body, created_at FROM chat_room_messages ORDER BY id DESC LIMIT $1) t ORDER BY id`,
    [limit]
  );
  return rows;
}

async function deleteMessage(db, id) {
  await db.query('DELETE FROM chat_room_messages WHERE id = $1', [id]);
}

async function countLastHour(db, personId) {
  const { rows } = await db.query(
    "SELECT count(*)::int AS c FROM chat_room_messages WHERE person_id = $1 AND kind = 'persona' AND created_at > now() - interval '1 hour'",
    [personId]
  );
  return rows[0].c;
}

// ---------- Lectura ----------
async function markRead(db, personId, upToId) {
  await db.query(
    `INSERT INTO chat_room_reads (person_id, last_read_id) VALUES ($1, $2)
     ON CONFLICT (person_id) DO UPDATE SET last_read_id = GREATEST(chat_room_reads.last_read_id, EXCLUDED.last_read_id), updated_at = now()`,
    [personId, upToId]
  );
}

async function lastReadId(db, personId) {
  const { rows } = await db.query('SELECT last_read_id FROM chat_room_reads WHERE person_id = $1', [personId]);
  return rows.length ? rows[0].last_read_id : 0;
}

// ---------- Grace: límite diario ----------
async function getGraceLimit(db) {
  const { rows } = await db.query('SELECT value FROM care_settings WHERE key = $1', [LIMIT_KEY]);
  const n = rows.length ? parseInt(rows[0].value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : DEFAULT_GRACE_LIMIT;
}

async function setGraceLimit(db, n) {
  const v = Math.max(0, Math.min(50, parseInt(n, 10) || 0));
  await db.query("INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [LIMIT_KEY, String(v)]);
  return v;
}

async function graceAskedToday(db, personId, timezone) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS c FROM chat_room_messages
      WHERE kind = 'grace' AND pregunta_de = $1 AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
    [personId, timezone]
  );
  return rows[0].c;
}

// ---------- Suscripciones push ----------
async function saveSubscription(db, personId, sub) {
  await db.query(
    `INSERT INTO push_subscriptions (person_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET person_id = EXCLUDED.person_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [personId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
}

async function deleteSubscription(db, endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function hasSubscription(db, personId) {
  const { rows } = await db.query('SELECT 1 FROM push_subscriptions WHERE person_id = $1 LIMIT 1', [personId]);
  return rows.length > 0;
}

/**
 * Avisa a los miembros (menos al autor) que hay mensajes nuevos. `urgentFor` = persona a la que
 * Grace le respondió su pregunta: a esa se le avisa siempre, sin la pausa de 15 minutos.
 * Nunca lanza: devuelve cuántos avisos salieron.
 */
async function notifyRoom(ctx, { exceptPersonId = null, urgentFor = null, title, bodyText }) {
  const { db, config } = ctx;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  let sent = 0;
  try {
    const keys = await webpush.ensureVapid(db);
    const subject = config.publicUrl || 'https://localhost';
    const { rows } = await db.query(
      `SELECT s.person_id, s.endpoint, s.p256dh, s.auth, l.token, r.last_notified_at
         FROM push_subscriptions s
         JOIN person_chat_links l ON l.person_id = s.person_id AND l.active
         JOIN people p ON p.id = s.person_id AND p.active
         LEFT JOIN chat_room_reads r ON r.person_id = s.person_id`
    );
    for (const sub of rows) {
      if (exceptPersonId && sub.person_id === exceptPersonId) continue;
      const urgent = urgentFor && sub.person_id === urgentFor;
      if (!urgent && sub.last_notified_at && Date.now() - new Date(sub.last_notified_at).getTime() < NOTIFY_PAUSE_MS) continue;
      const payload = JSON.stringify({ title, body: bodyText, url: `/chat/${sub.token}` });
      try {
        const status = await webpush.sendPush(fetchImpl, { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, keys, subject);
        if (status === 404 || status === 410) {
          await deleteSubscription(db, sub.endpoint);
          continue;
        }
        if (status >= 200 && status < 300) {
          sent++;
          await db.query('UPDATE push_subscriptions SET last_push_at = now() WHERE endpoint = $1', [sub.endpoint]);
          await db.query(
            `INSERT INTO chat_room_reads (person_id, last_read_id, last_notified_at) VALUES ($1, 0, now())
             ON CONFLICT (person_id) DO UPDATE SET last_notified_at = now(), updated_at = now()`,
            [sub.person_id]
          );
        }
      } catch {
        /* un aviso fallido no rompe la sala */
      }
    }
  } catch {
    /* sin claves o sin red: la sala sigue */
  }
  return sent;
}

// ---------- Enlace de invitación (uno solo, para compartir con los miembros) ----------
// El chat se comparte como un grupo de WhatsApp: UN enlace de invitación que el pastor (o cualquier
// miembro, desde el botón ↗ del chat) manda a los demás. Quien lo abre escribe SU número de WhatsApp
// y el sistema lo reconoce entre las personas con acceso y lo lleva a SU enlace personal: cada quien
// sigue entrando como sí mismo, pero ya nadie tiene que repartir enlace por enlace.
const INVITE_TOKEN_KEY = 'chat_invite_token';
const INVITE_ACTIVE_KEY = 'chat_invite_active';

async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM care_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
async function setSetting(db, key, value) {
  await db.query('INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)]);
}

async function getInvite(db) {
  const token = await getSetting(db, INVITE_TOKEN_KEY);
  if (!token) return { token: null, active: false };
  return { token, active: (await getSetting(db, INVITE_ACTIVE_KEY)) !== '0' };
}
async function ensureInvite(db) {
  const inv = await getInvite(db);
  if (inv.token) return inv;
  const token = newToken();
  await setSetting(db, INVITE_TOKEN_KEY, token);
  await setSetting(db, INVITE_ACTIVE_KEY, '1');
  return { token, active: true };
}
async function regenerateInvite(db) {
  const token = newToken();
  await setSetting(db, INVITE_TOKEN_KEY, token);
  await setSetting(db, INVITE_ACTIVE_KEY, '1');
  return { token, active: true };
}
async function setInviteActive(db, on) {
  await setSetting(db, INVITE_ACTIVE_KEY, on ? '1' : '0');
  return getInvite(db);
}

/** Busca al miembro por su número de WhatsApp entre las personas con acceso activo a la sala. */
async function findMemberByPhone(db, rawPhone, countryCode) {
  const wanted = normalizePhone(rawPhone, countryCode || '58');
  if (!wanted) return null;
  const { rows } = await db.query(
    `SELECT l.person_id, l.token, p.full_name, p.phone FROM person_chat_links l JOIN people p ON p.id = l.person_id
      WHERE l.active = TRUE AND p.active = TRUE`
  );
  for (const row of rows) {
    const have = normalizePhone(row.phone, countryCode || '58');
    if (have && (have === wanted || have.slice(-9) === wanted.slice(-9))) {
      return { person: { id: row.person_id, full_name: row.full_name, phone: row.phone }, token: row.token };
    }
  }
  return null;
}

module.exports = {
  newToken,
  LIMIT_KEY,
  DEFAULT_GRACE_LIMIT,
  NOTIFY_PAUSE_MS,
  getLink,
  ensureLink,
  regenerate,
  setActive,
  byToken,
  members,
  getInvite,
  ensureInvite,
  regenerateInvite,
  setInviteActive,
  findMemberByPhone,
  postMessage,
  listMessages,
  recentMessages,
  deleteMessage,
  countLastHour,
  markRead,
  lastReadId,
  getGraceLimit,
  setGraceLimit,
  graceAskedToday,
  saveSubscription,
  deleteSubscription,
  hasSubscription,
  notifyRoom,
};
