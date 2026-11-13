'use strict';
const { tx } = require('./db');
const cg = require('./care-groups');
const { normalizePhone, normalizeEmail } = require('./phone');
const { CIVIL_STATUS } = require('./member-intake');

/**
 * Registro ministerial: un solo enlace para que los pastores y los servidores de los ministerios se
 * registren ellos mismos, como los líderes de grupo de cuidado con su enlace, pero su destino es la
 * ficha de Personas con su función como rol.
 * Pide lo mismo que la ficha del líder (nombre, nacimiento, cédula, dirección, teléfono, correo,
 * congregación y foto) más el estado civil, y primero que nada la función: Pastor, Pastor asistente
 * o un ministerio (Nueva Vida, Alabanza, etc.; también los que existan en Ministerios).
 *  - Si su teléfono ya está en Personas y no trae nada distinto, la ficha se completa sola (solo llena
 *    lo vacío, y el rol solo si estaba vacío).
 *  - Si es alguien nuevo, o trae un dato distinto (también una función distinta a su rol), espera revisión.
 * Nunca cambia el consentimiento (opt_in) por sí solo: "quiero recibir recordatorios" queda como aviso.
 */
const FUNCIONES_BASE = ['Pastor', 'Pastor asistente'];
const MINISTERIOS_BASE = ['Nueva Vida', 'Alabanza', 'Diáconos'];
const FUNCIONES = [...FUNCIONES_BASE, ...MINISTERIOS_BASE];

/**
 * Opciones de la función: pastores, luego los ministerios base y los que ya existen en la base
 * (tabla `ministries`), sin repetir nombres (sin distinguir mayúsculas).
 */
async function functionOptions(db) {
  const { rows } = await db.query('SELECT name FROM ministries ORDER BY name');
  const seen = new Set();
  const out = [];
  for (const name of [...FUNCIONES_BASE, ...MINISTERIOS_BASE, ...rows.map((r) => String(r.name).trim())]) {
    const key = keyOf(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
const FIELDS = ['full_name', 'email', 'birth_date', 'cedula', 'address', 'civil_status', 'congregation'];
const LABELS = {
  funcion: 'Función', full_name: 'Nombre y apellido', email: 'Correo', birth_date: 'Nacimiento', cedula: 'Cédula (C.I.)',
  address: 'Dirección', civil_status: 'Estado civil', congregation: 'Congregación',
};
const SENSITIVE = ['birth_date', 'cedula', 'address']; // se borran de la respuesta cuando se atiende

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const keyOf = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ----------------------------- Enlace común ----------------------------- */
async function getSettings(db) {
  const { rows } = await db.query("SELECT key, value FROM care_settings WHERE key IN ('pastor_token', 'pastor_active')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { token: m.pastor_token || '', active: m.pastor_active !== 'no' };
}
async function ensureToken(db) {
  const cur = await getSettings(db);
  if (cur.token) return cur;
  await db.query("INSERT INTO care_settings (key, value) VALUES ('pastor_token', $1) ON CONFLICT (key) DO NOTHING", [cg.newToken()]);
  return getSettings(db);
}
async function regenerateToken(db) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('pastor_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [cg.newToken()]);
  await db.query("INSERT INTO care_settings (key, value) VALUES ('pastor_active', 'si') ON CONFLICT (key) DO UPDATE SET value = 'si'");
}
async function setActive(db, on) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('pastor_active', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [on ? 'si' : 'no']);
}
async function tokenIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const s = await getSettings(db);
  return s.active && s.token === token;
}

/* ------------------------------ Validación ------------------------------ */
/**
 * Valida el envío. Obligatorios: función, nombre y apellido, teléfono, fecha de nacimiento, cédula,
 * dirección, estado civil y congregación (la ficha del líder, más el estado civil). Correo y foto, opcionales.
 */
function parseSubmission(body, countryCode, today, funciones = FUNCIONES) {
  const errors = [];
  const funcion = String(body.funcion ?? '').trim();
  if (!funciones.includes(funcion)) errors.push('Elige tu función o ministerio.');

  const full_name = clean(body.full_name, 120);
  if (!full_name) errors.push('Escribe tu nombre y apellido.');
  else if (full_name.split(' ').length < 2) errors.push('Escribe tu nombre y tu apellido.');

  const phoneRaw = clean(body.phone, 30);
  const phone = phoneRaw ? normalizePhone(phoneRaw, countryCode) || '' : '';
  if (!phoneRaw) errors.push('Escribe tu teléfono (WhatsApp).');
  else if (!phone) errors.push('Tu teléfono no parece válido.');

  const emailRaw = clean(body.email, 120);
  const email = emailRaw ? normalizeEmail(emailRaw) || '' : '';
  if (emailRaw && !email) errors.push('Tu correo no parece válido.');

  const parts = [body.bd_day, body.bd_month, body.bd_year].map((x) => String(x ?? '').trim());
  let birth_date = '';
  if (!parts.some(Boolean)) {
    errors.push('Elige tu fecha de nacimiento.');
  } else if (!parts.every(Boolean)) {
    errors.push('Completa el día, el mes y el año de tu nacimiento.');
  } else {
    const b = cg.parseBirthDate(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`, today, 'tuya');
    if (b.error) errors.push(b.error);
    birth_date = b.value;
  }

  const ci = cg.parseCedula(body.cedula);
  if (ci.error) errors.push(ci.error.replace('del líder', 'tuya').replace('La cédula tuya', 'Tu cédula'));
  else if (!ci.value) errors.push('Escribe tu cédula de identidad.');

  const address = clean(body.address, 250);
  if (!address) errors.push('Escribe tu dirección.');

  const civil = String(body.civil_status ?? '').trim();
  if (!CIVIL_STATUS.includes(civil)) errors.push('Elige tu estado civil.');

  const congregation = String(body.congregation ?? '').trim();
  if (!cg.CONGREGATIONS.includes(congregation)) errors.push('Elige tu congregación.');

  const photo = cg.parsePhoto(body.photo_data);
  if (photo.error) errors.push(photo.error);

  return {
    value: { funcion: funciones.includes(funcion) ? funcion : '', full_name, phone, email, birth_date, cedula: ci.value, address, civil_status: CIVIL_STATUS.includes(civil) ? civil : '', congregation, wants_messages: body.wants_messages === '1' },
    photo,
    errors: [...new Set(errors)],
  };
}

/* ------------------------------- Envío / revisión ------------------------------- */
const sameValue = (f, a, b) => (f === 'full_name' ? keyOf(a) === keyOf(b) : f === 'email' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Campos donde lo enviado es distinto de lo que la ficha ya tiene (ambos con valor); la función se compara con el rol. */
function conflictsWith(person, v) {
  const out = FIELDS.filter((f) => v[f] && person[f] && !sameValue(f, v[f], person[f]));
  if (v.funcion && person.role && keyOf(v.funcion) !== keyOf(person.role)) out.push('funcion');
  return out;
}

async function submit(pool, sub) {
  const v = sub.value;
  const person = (await pool.query('SELECT * FROM people WHERE phone = $1', [v.phone])).rows[0] || null;
  let auto = false;
  if (person) {
    auto = conflictsWith(person, v).length === 0;
    if (auto && v.email) {
      const other = (await pool.query('SELECT 1 FROM people WHERE lower(email) = lower($1) AND id <> $2', [v.email, person.id])).rows.length;
      if (other) auto = false;
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO pastor_submissions (person_id, funcion, full_name, phone, email, birth_date, cedula, address, civil_status, congregation, wants_messages, photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [person ? person.id : null, v.funcion, v.full_name, v.phone, v.email, v.birth_date, v.cedula, v.address, v.civil_status, v.congregation, v.wants_messages, sub.photo.buffer]
  );
  const id = rows[0].id;
  if (auto) {
    const out = await apply(pool, id, { auto: true });
    return { id, applied: !out.error };
  }
  return { id, applied: false };
}

/**
 * Aplica una respuesta: completa (o crea) la ficha y deja la función como rol de la persona.
 * A una ficha existente, en automático solo le llena lo vacío; al aprobar a mano, lo enviado reemplaza
 * lo distinto y el rol pasa a ser la función declarada. `consent: true` (solo desde el panel) registra
 * el consentimiento si la persona lo pidió. Devuelve { error } o { personId, created }.
 */
async function apply(pool, submissionId, { auto = false, consent = false } = {}) {
  try {
    return await tx(pool, async (db) => {
      const sub = (await db.query("SELECT * FROM pastor_submissions WHERE id = $1 AND status = 'pendiente' FOR UPDATE", [submissionId])).rows[0];
      if (!sub) return { error: 'Esa respuesta ya fue atendida.' };
      let person = (await db.query('SELECT * FROM people WHERE phone = $1', [sub.phone])).rows[0];
      let created = false;
      if (!person) {
        person = (
          await db.query("INSERT INTO people (full_name, phone, email, preferred_channel, opt_in, active) VALUES ($1, $2, NULLIF($3, ''), 'whatsapp', FALSE, TRUE) RETURNING *", [sub.full_name, sub.phone, sub.email])
        ).rows[0];
        created = true;
      }
      const keepOwn = (f) => (f === 'full_name' || f === 'email') && (created || (auto && person[f]));
      const set = FIELDS.filter((f) => sub[f] !== '' && !keepOwn(f));
      const sets = [...set.map((f, i) => (f === 'email' ? `email = NULLIF($${i + 2}, '')` : `${f} = $${i + 2}`))];
      const params = [person.id, ...set.map((f) => sub[f])];
      if (!auto || !person.role) {
        sets.push(`role = $${params.length + 1}`);
        params.push(sub.funcion);
      }
      sets.push('profile_updated_at = now()', 'updated_at = now()');
      if (consent && sub.wants_messages) sets.push('opt_in = TRUE');
      await db.query(`UPDATE people SET ${sets.join(', ')} WHERE id = $1`, params);
      if (sub.photo) {
        await db.query('INSERT INTO people_photos (person_id, data) VALUES ($1, $2) ON CONFLICT (person_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [person.id, Buffer.from(sub.photo)]);
      }
      await db.query(
        `UPDATE pastor_submissions SET status = 'aplicada', auto_applied = $2, person_id = $3, resolved_at = now(), photo = NULL, birth_date = '', cedula = '', address = '' WHERE id = $1`,
        [submissionId, auto, person.id]
      );
      return { personId: person.id, created };
    });
  } catch (err) {
    if (err && err.code === '23505') return { error: 'Ese correo ya está en la ficha de otra persona. Descarta esta respuesta o corrige el correo en esa ficha primero.' };
    throw err;
  }
}

async function discard(db, submissionId) {
  const { rowCount } = await db.query(
    "UPDATE pastor_submissions SET status = 'descartada', resolved_at = now(), photo = NULL, birth_date = '', cedula = '', address = '' WHERE id = $1 AND status = 'pendiente'",
    [submissionId]
  );
  return rowCount > 0;
}

/** Respuestas por revisar, con la ficha actual para comparar (el rol actual va como cur_funcion). La foto no se trae, solo si tiene. */
async function listPending(db) {
  const { rows } = await db.query(
    `SELECT s.id, s.person_id, s.phone, s.wants_messages, s.created_at, s.funcion, p.role AS cur_funcion, (s.photo IS NOT NULL) AS has_photo,
            ${FIELDS.map((f) => `s.${f}`).join(', ')}, ${FIELDS.map((f) => `p.${f} AS cur_${f}`).join(', ')}
       FROM pastor_submissions s LEFT JOIN people p ON p.id = s.person_id
      WHERE s.status = 'pendiente' ORDER BY s.created_at`
  );
  return rows;
}
const countPending = async (db) => (await db.query("SELECT count(*)::int AS n FROM pastor_submissions WHERE status = 'pendiente'")).rows[0].n;

module.exports = { FUNCIONES, FUNCIONES_BASE, MINISTERIOS_BASE, functionOptions, FIELDS, LABELS, SENSITIVE, getSettings, ensureToken, regenerateToken, setActive, tokenIsValid, parseSubmission, conflictsWith, submit, apply, discard, listPending, countPending };
