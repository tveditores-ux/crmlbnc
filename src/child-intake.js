'use strict';
const { tx } = require('./db');
const cg = require('./care-groups');
const { normalizePhone } = require('./phone');

/**
 * Registro de niños y adolescentes (pedido del pastor, 2026-11-21): un solo enlace (`/ninos/<token>`)
 * para que el papá, la mamá o el representante registre a su hijo que asiste a la congregación de
 * Niños (3 a 10 años), Preadolescentes (11 a 13) o Adolescentes (14 a 17). La congregación sale de la
 * FECHA DE NACIMIENTO, no se elige. Pide el nombre del niño, su fecha de nacimiento, el nombre del
 * representante, quién es (papá, mamá o representante), su teléfono y DOS fotos: la del niño y la del
 * representante. Cada envío espera la revisión del panel; al aplicarse crea o completa la ficha del
 * niño en Personas (sin teléfono propio: el del representante queda en la nota de su ficha) y su foto.
 * Si el mismo niño (nombre + fecha de nacimiento) ya estaba registrado, el remoto le pregunta al
 * representante si es una actualización antes de guardar otro envío.
 */
const TOKEN_KEY = 'nino_token';
const ACTIVE_KEY = 'nino_active';
const RELATIONS = ['Papá', 'Mamá', 'Representante'];

const keyOf = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

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
async function linkIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const l = await getLink(db);
  return l.active && l.token === token;
}

/** La edad cumplida a la fecha de hoy ('YYYY-MM-DD' contra 'YYYY-MM-DD'). */
function ageOn(birthDate, today) {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

/** La congregación según la edad que dictó el pastor: Niños 3–10, Preadolescentes 11–13, Adolescentes 14–17. */
function congregationForAge(age) {
  if (age >= 3 && age <= 10) return 'Niños';
  if (age >= 11 && age <= 13) return 'Preadolescentes';
  if (age >= 14 && age <= 17) return 'Adolescentes';
  return '';
}

const clean = (v, n) => String(v ?? '').trim().slice(0, n);

function parseSubmission(body, countryCode = '58', today) {
  const errors = [];
  const child_name = clean(body.child_name, 120);
  if (!child_name) errors.push('Escribe el nombre y el apellido del niño o adolescente.');
  else if (child_name.split(/\s+/).length < 2) errors.push('Escribe el nombre y el apellido del niño o adolescente.');

  const parts = [body.bd_day, body.bd_month, body.bd_year].map((x) => String(x ?? '').trim());
  let birth_date = '';
  let congregation = '';
  if (!parts.some(Boolean)) {
    errors.push('Elige la fecha de nacimiento del niño o adolescente.');
  } else if (!parts.every(Boolean)) {
    errors.push('Completa el día, el mes y el año de su nacimiento.');
  } else {
    const b = cg.parseBirthDate(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`, today, 'del niño');
    if (b.error) errors.push(b.error);
    else {
      birth_date = b.value;
      congregation = congregationForAge(ageOn(birth_date, today));
      if (!congregation) errors.push('Este registro es para niños y adolescentes de 3 a 17 años.');
    }
  }

  // Solo comida y solo si hace falta: alergias o alimentos que el niño no puede comer (opcional).
  const food_allergy = clean(body.food_allergy, 300);

  const parent_name = clean(body.parent_name, 120);
  if (!parent_name) errors.push('Escribe tu nombre y apellido (papá, mamá o representante).');
  else if (parent_name.split(/\s+/).length < 2) errors.push('Escribe tu nombre y tu apellido (papá, mamá o representante).');
  const parent_relation = RELATIONS.includes(String(body.parent_relation || '').trim()) ? String(body.parent_relation).trim() : '';
  if (!parent_relation) errors.push('Elige quién registra al niño: papá, mamá o representante.');
  let parent_phone = '';
  if (!String(body.parent_phone || '').trim()) errors.push('Escribe tu número de teléfono: es el contacto del representante.');
  else {
    parent_phone = normalizePhone(body.parent_phone, countryCode) || '';
    if (!parent_phone) errors.push('Tu número de teléfono no parece válido.');
  }

  const photoChild = cg.parsePhoto(body.photo_child_data);
  if (photoChild.error) errors.push(photoChild.error);
  else if (!photoChild.buffer) errors.push('Falta la foto del niño o adolescente.');
  const photoParent = cg.parsePhoto(body.photo_parent_data);
  if (photoParent.error) errors.push(photoParent.error);
  else if (!photoParent.buffer) errors.push('Falta tu foto (la del papá, la mamá o el representante).');

  const value = { child_name, birth_date, congregation, food_allergy, parent_name, parent_relation, parent_phone };
  return { value, photoChild, photoParent, errors: [...new Set(errors)] };
}

/**
 * ¿Este niño ya estaba registrado? Se reconoce por nombre + fecha de nacimiento, en una respuesta
 * pendiente de este registro o ya en Personas. Un hermano con el mismo representante y el mismo
 * teléfono NO es un duplicado: cada hijo se registra por separado.
 */
async function findRegistered(db, v) {
  if (!v.child_name || !v.birth_date) return null;
  const pend = (await db.query("SELECT id, child_name FROM child_submissions WHERE birth_date = $1 AND status = 'pendiente'", [v.birth_date])).rows;
  const hitP = pend.find((r) => keyOf(r.child_name) === keyOf(v.child_name));
  if (hitP) return { donde: 'pendiente', id: hitP.id };
  const people = (await db.query('SELECT id, full_name FROM people WHERE birth_date = $1', [v.birth_date])).rows;
  const hit = people.find((r) => keyOf(r.full_name) === keyOf(v.child_name));
  if (hit) return { donde: 'personas', id: hit.id };
  return null;
}

/** Guarda el envío para revisión del panel. Devuelve el id. */
async function submit(db, sub) {
  const v = sub.value;
  const { rows } = await db.query(
    `INSERT INTO child_submissions (child_name, birth_date, congregation, food_allergy, parent_name, parent_relation, parent_phone, photo_child, photo_parent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [v.child_name, v.birth_date, v.congregation, v.food_allergy, v.parent_name, v.parent_relation, v.parent_phone, sub.photoChild.buffer, sub.photoParent.buffer]
  );
  return rows[0].id;
}

const representativeLine = (sub) => `Representante: ${sub.parent_name} (${sub.parent_relation}) · Tel. ${sub.parent_phone}`;

/**
 * Aplica una respuesta: crea o completa la ficha del niño en Personas. Se reconoce por nombre +
 * fecha de nacimiento; su congregación es la de su edad, su foto es la que envió el representante y
 * el contacto del representante queda en la nota de la ficha. El niño no lleva teléfono propio (el
 * teléfono es del representante) ni consentimiento: registrarlo no marca opt_in.
 */
async function apply(pool, submissionId) {
  return tx(pool, async (db) => {
    const sub = (await db.query("SELECT * FROM child_submissions WHERE id = $1 AND status = 'pendiente' FOR UPDATE", [submissionId])).rows[0];
    if (!sub) return { error: 'Esa respuesta ya fue atendida.' };
    const people = (await db.query('SELECT * FROM people WHERE birth_date = $1', [sub.birth_date])).rows;
    let person = people.find((r) => keyOf(r.full_name) === keyOf(sub.child_name));
    const line = representativeLine(sub);
    if (!person) {
      person = (
        await db.query(
          "INSERT INTO people (full_name, birth_date, congregation, food_allergy, notes, preferred_channel, opt_in, active) VALUES ($1, $2, $3, $4, $5, 'whatsapp', FALSE, TRUE) RETURNING *",
          [sub.child_name, sub.birth_date, sub.congregation, sub.food_allergy || '', line]
        )
      ).rows[0];
    } else {
      const notes = String(person.notes || '');
      await db.query('UPDATE people SET congregation = $2, notes = $3, profile_updated_at = now(), updated_at = now() WHERE id = $1', [
        person.id,
        sub.congregation,
        notes.includes(sub.parent_phone) ? notes : [notes, line].filter(Boolean).join('\n'),
      ]);
      // una actualización sin el dato no borra la alergia ya conocida; con el dato, la reemplaza
      if (sub.food_allergy) await db.query('UPDATE people SET food_allergy = $2 WHERE id = $1', [person.id, sub.food_allergy]);
    }
    if (sub.photo_child) {
      await db.query('INSERT INTO people_photos (person_id, data) VALUES ($1, $2) ON CONFLICT (person_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [person.id, Buffer.from(sub.photo_child)]);
    }
    await db.query("UPDATE child_submissions SET status = 'aplicada', person_id = $2, resolved_at = now(), photo_child = NULL WHERE id = $1", [submissionId, person.id]);
    return { personId: person.id };
  });
}

async function discard(db, submissionId) {
  const { rowCount } = await db.query(
    "UPDATE child_submissions SET status = 'descartada', resolved_at = now(), photo_child = NULL, photo_parent = NULL WHERE id = $1 AND status = 'pendiente'",
    [submissionId]
  );
  return rowCount > 0;
}

/** Respuestas por revisar (sin las fotos en sí, solo si las tiene). */
async function listPending(db) {
  const { rows } = await db.query(
    `SELECT id, child_name, birth_date, congregation, food_allergy, parent_name, parent_relation, parent_phone, created_at,
            (photo_child IS NOT NULL) AS has_child_photo, (photo_parent IS NOT NULL) AS has_parent_photo
       FROM child_submissions WHERE status = 'pendiente' ORDER BY created_at`
  );
  return rows;
}

const countPending = async (db) => (await db.query("SELECT count(*)::int AS n FROM child_submissions WHERE status = 'pendiente'")).rows[0].n;

module.exports = {
  TOKEN_KEY, ACTIVE_KEY, RELATIONS,
  getLink, ensureLink, regenerateLink, setLinkActive, linkIsValid,
  ageOn, congregationForAge, parseSubmission, findRegistered, submit, apply, discard, listPending, countPending,
};
