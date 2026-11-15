'use strict';
const { tx } = require('./db');
const cg = require('./care-groups');
const repo = require('./repo');
const { normalizePhone, normalizeEmail } = require('./phone');
const { CIVIL_STATUS } = require('./member-intake');

/**
 * Líderes de ministerios de desarrollo: un solo enlace para que los líderes de los ministerios de
 * desarrollo envíen ellos mismos su ficha, como los pastores con el registro ministerial, pero
 * con un enlace y una bandeja aparte, solo para ellos.
 * Los ministerios de desarrollo son SOLO los seis cargados en la pestaña Ministerios del CRM
 * (confirmados por Eliezer, 2026-11-14): Alabanza, Anfitriones, Diaconado, Nueva Vida, Medios e
 * Intercesión («Oración» es este mismo ministerio). Nada más: ni Consolidación ni Protocolo y
 * ujieres (esos salen de las funciones del registro ministerial, no de Ministerios), ni Iglesia
 * en línea (quedó fuera por decisión de Eliezer), y tampoco «Otro ministerio».
 * Los ministerios congregacionales (Niños, Preadolescentes, Adolescentes, Jóvenes, Matrimonios,
 * Mujeres, Hombres…) NO van aquí: ya van como «congregación» en esta misma planilla.
 * Al elegir, se usa el nombre tal como está cargado en Ministerios si coincide por raíz sin
 * tildes (p. ej. si estuviera «Diáconos» en vez de «Diaconado»), para enlazar con ese ministerio.
 * Pide lo mismo que la ficha del líder de grupo de cuidado (nombre, nacimiento, cédula, dirección,
 * teléfono, correo, congregación y foto) más el estado civil, y primero el ministerio —puede ser
 * MÁS DE UNO (2026-11-14)— y a qué grupo de cuidado pertenece o asiste. Sin cargo (quitado por
 * Eliezer, 2026-11-14): el enlace es solo para líderes, así que sobra preguntarlo. También pregunta
 * si sirve en algún ministerio congregacional (Niños, Jóvenes, Mujeres…): no es lo mismo que su
 * congregación, que ya se pregunta en la ficha.
 *  - Si su teléfono ya está en Personas y no trae nada distinto, la ficha se completa sola (solo
 *    llena lo vacío; el rol solo si estaba vacío: «Líder de <ministerio>»).
 *  - Si es alguien nuevo, o trae un dato distinto, espera revisión en el panel.
 * Al aplicarse, la persona queda en sus ministerios (se crean en Ministerios si no existían) y, en
 * cada uno que aún no tenga coordinador, queda como su coordinador; si dijo que sirve en un
 * ministerio congregacional, queda sirviendo en él (sin coordinarlo); y su nombre entra en la lista
 * de gente de su grupo de cuidado (care_group_people), si dijo a cuál asiste.
 * Nunca cambia el consentimiento (opt_in) por sí solo: "quiero recibir recordatorios" queda como aviso.
 */
const DESARROLLO = ['Alabanza', 'Anfitriones', 'Diaconado', 'Intercesión', 'Medios', 'Nueva Vida'];
const SIN_GRUPO = 'ninguno'; // valor de la planilla para «No asisto a un grupo de cuidado»
const CONGREGACIONALES = cg.CONGREGATIONS.filter((c) => c !== 'General'); // ministerios congregacionales donde puede servir («General» no es un ministerio)
const SIN_CONGREGACIONAL = 'No sirvo en ninguno'; // opción de la planilla
const FIELDS = ['full_name', 'email', 'birth_date', 'cedula', 'address', 'civil_status', 'congregation'];
const LABELS = {
  ministerio: 'Ministerio', grupo_cuidado: 'Grupo de cuidado', congregacional: 'Ministerio congregacional', full_name: 'Nombre y apellido', email: 'Correo', birth_date: 'Nacimiento', cedula: 'Cédula (C.I.)',
  address: 'Dirección', civil_status: 'Estado civil', congregation: 'Congregación',
};
/** La lista de ministerios de desarrollo de una respuesta (JSON en `ministerios`; si no, el de 038). */
const ministeriosDe = (sub) => {
  try {
    const a = JSON.parse(sub.ministerios || '[]');
    if (Array.isArray(a) && a.length) return a.map(String);
  } catch { /* respuestas viejas: solo el primer ministerio */ }
  return sub.ministerio ? [sub.ministerio] : [];
};
/** «Alabanza», «Alabanza y Medios», «Alabanza, Medios y Nueva Vida». */
const joinList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
const SENSITIVE = ['birth_date', 'cedula', 'address']; // se borran de la respuesta cuando se atiende

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const keyOf = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Primera palabra sin tildes: «Diaconado» y «Diáconos» comparten raíz («diacon…»). */
const stemOf = (s) => keyOf(s).split(' ')[0] || '';
const sameMinistry = (a, b) => {
  const x = stemOf(a);
  const y = stemOf(b);
  return Boolean(x && y) && (x === y || (x.length >= 6 && y.length >= 6 && x.slice(0, 6) === y.slice(0, 6)));
};

/* ----------------------------- Enlace común ----------------------------- */
async function getSettings(db) {
  const { rows } = await db.query("SELECT key, value FROM care_settings WHERE key IN ('dev_leader_token', 'dev_leader_active')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { token: m.dev_leader_token || '', active: m.dev_leader_active !== 'no' };
}
async function ensureToken(db) {
  const cur = await getSettings(db);
  if (cur.token) return cur;
  await db.query("INSERT INTO care_settings (key, value) VALUES ('dev_leader_token', $1) ON CONFLICT (key) DO NOTHING", [cg.newToken()]);
  return getSettings(db);
}
async function regenerateToken(db) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('dev_leader_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [cg.newToken()]);
  await db.query("INSERT INTO care_settings (key, value) VALUES ('dev_leader_active', 'si') ON CONFLICT (key) DO UPDATE SET value = 'si'");
}
async function setActive(db, on) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('dev_leader_active', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [on ? 'si' : 'no']);
}
async function tokenIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const s = await getSettings(db);
  return s.active && s.token === token;
}

/* --------------------------- Ministerios a elegir --------------------------- */
/**
 * Los ministerios de desarrollo que el líder puede elegir: SOLO los seis de DESARROLLO, tal como
 * están cargados en la pestaña Ministerios. Si el nombre cargado difiere por tildes o por la raíz
 * (p. ej. «Diáconos» por «Diaconado»), se ofrece el nombre cargado, para enlazar con ese ministerio
 * y no crear uno repetido. Ningún otro ministerio del panel entra aquí.
 */
async function ministryOptions(db) {
  const rows = (await db.query('SELECT name FROM ministries ORDER BY name')).rows.map((r) => r.name).filter(Boolean);
  return DESARROLLO.map((name) => rows.find((m) => sameMinistry(m, name)) || name);
}

/** Los grupos de cuidado activos que la persona puede decir que es el suyo (con su líder, para distinguirlos). */
async function careGroupOptions(db) {
  const { rows } = await db.query('SELECT id, name, leader_name FROM care_groups WHERE active ORDER BY lower(name)');
  return rows;
}

/* ------------------------------ Validación ------------------------------ */
/**
 * Valida el envío. Obligatorios: ministerio (uno o varios), grupo de cuidado (o decir que no asiste
 * a ninguno), si sirve en un ministerio congregacional, nombre y apellido, teléfono, fecha de
 * nacimiento, cédula, dirección, estado civil y congregación (la ficha del líder, más el estado
 * civil). Correo y foto, opcionales.
 * ministryNames = lo que se puede elegir (ministryOptions); groups = careGroupOptions ({id, name}).
 */
function parseSubmission(body, ministryNames, groups, countryCode, today) {
  const errors = [];
  const rawList = Array.isArray(body.ministerio) ? body.ministerio : [body.ministerio];
  const picked = [...new Set(rawList.map((x) => String(x ?? '').trim()).filter(Boolean))];
  const ministerios = picked.filter((m) => ministryNames.includes(m));
  if (!picked.length || ministerios.length !== picked.length) errors.push('Elige tu ministerio de desarrollo.');
  const ministerio = ministerios[0] || '';

  const cRaw = String(body.congregacional ?? '').trim();
  let congregacional = '';
  if (cRaw === SIN_CONGREGACIONAL) congregacional = '';
  else if (CONGREGACIONALES.includes(cRaw)) congregacional = cRaw;
  else errors.push('Elige si sirves en un ministerio congregacional.');

  const gRaw = String(body.grupo_cuidado ?? '').trim();
  let grupo_cuidado = '';
  let grupo_cuidado_id = null;
  if (gRaw === SIN_GRUPO) {
    // no asiste a ningún grupo de cuidado: válido, queda vacío
  } else if (/^\d+$/.test(gRaw)) {
    const g = (groups || []).find((x) => x.id === Number(gRaw));
    if (g) {
      grupo_cuidado = g.name;
      grupo_cuidado_id = g.id;
    } else errors.push('Elige a qué grupo de cuidado perteneces o asistes.');
  } else errors.push('Elige a qué grupo de cuidado perteneces o asistes.');

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
    value: { ministerio, ministerios, congregacional, grupo_cuidado, grupo_cuidado_id, full_name, phone, email, birth_date, cedula: ci.value, address, civil_status: CIVIL_STATUS.includes(civil) ? civil : '', congregation, wants_messages: body.wants_messages === '1' },
    photo,
    errors: [...new Set(errors)],
  };
}

/* ------------------------------- Envío / revisión ------------------------------- */
const sameValue = (f, a, b) => (f === 'full_name' ? keyOf(a) === keyOf(b) : f === 'email' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/** Campos donde lo enviado es distinto de lo que la ficha ya tiene (ambos con valor). El ministerio no es conflicto: alguien puede liderar un ministerio y tener otro rol. */
function conflictsWith(person, v) {
  return FIELDS.filter((f) => v[f] && person[f] && !sameValue(f, v[f], person[f]));
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
    `INSERT INTO ministry_leader_submissions (person_id, ministerio, ministerios, congregacional, grupo_cuidado, grupo_cuidado_id, full_name, phone, email, birth_date, cedula, address, civil_status, congregation, wants_messages, photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [person ? person.id : null, v.ministerio, JSON.stringify(v.ministerios || []), v.congregacional || '', v.grupo_cuidado, v.grupo_cuidado_id, v.full_name, v.phone, v.email, v.birth_date, v.cedula, v.address, v.civil_status, v.congregation, v.wants_messages, sub.photo.buffer]
  );
  const id = rows[0].id;
  if (auto) {
    const out = await apply(pool, id, { auto: true });
    return { id, applied: !out.error };
  }
  return { id, applied: false };
}

/**
 * Aplica una respuesta: completa (o crea) la ficha, deja a la persona en sus ministerios y, en cada
 * uno que no tenía coordinador, lo deja como coordinador (el enlace es solo para líderes). El rol
 * solo se escribe si la ficha no tenía («Líder de <ministerios>»): liderar un ministerio nunca pisa
 * un rol pastoral. Si sirve en un ministerio congregacional, queda en él sin coordinarlo. Si dijo a
 * qué grupo de cuidado asiste, su nombre entra en la lista de gente de ese grupo (care_group_people),
 * si no estaba ya.
 * A una ficha existente, en automático solo le llena lo vacío; al aprobar a mano, lo enviado
 * reemplaza lo distinto. `consent: true` (solo desde el panel) registra el consentimiento si la
 * persona lo pidió. Devuelve { error } o { personId, created }.
 */
async function apply(pool, submissionId, { auto = false, consent = false } = {}) {
  try {
    return await tx(pool, async (db) => {
      const sub = (await db.query("SELECT * FROM ministry_leader_submissions WHERE id = $1 AND status = 'pendiente' FOR UPDATE", [submissionId])).rows[0];
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
      if (!person.role) {
        sets.push(`role = $${params.length + 1}`);
        params.push(`Líder de ${joinList(ministeriosDe(sub))}`);
      }
      sets.push('profile_updated_at = now()', 'updated_at = now()');
      if (consent && sub.wants_messages) sets.push('opt_in = TRUE');
      await db.query(`UPDATE people SET ${sets.join(', ')} WHERE id = $1`, params);
      // queda en sus ministerios (se crean si no existían) y, en cada uno sin coordinador, coordina
      for (const name of ministeriosDe(sub)) {
        const ministryId = await repo.ensureMinistry(db, name);
        await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [person.id, ministryId]);
        await db.query('UPDATE ministries SET coordinator_id = $2 WHERE id = $1 AND coordinator_id IS NULL', [ministryId, person.id]);
      }
      // si sirve en un ministerio congregacional, queda sirviendo en él (sin coordinarlo)
      if (sub.congregacional) {
        const congId = await repo.ensureMinistry(db, sub.congregacional);
        await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [person.id, congId]);
      }
      // y en la lista de gente de su grupo de cuidado, si dijo a cuál asiste y no estaba ya
      if (sub.grupo_cuidado_id) {
        const names = (await db.query('SELECT name FROM care_group_people WHERE group_id = $1', [sub.grupo_cuidado_id])).rows.map((x) => keyOf(x.name));
        if (!names.includes(keyOf(sub.full_name))) {
          const sort = (await db.query('SELECT COALESCE(max(sort), -1) + 1 AS s FROM care_group_people WHERE group_id = $1', [sub.grupo_cuidado_id])).rows[0].s;
          await db.query('INSERT INTO care_group_people (group_id, name, sort) VALUES ($1, $2, $3)', [sub.grupo_cuidado_id, sub.full_name, sort]);
        }
      }
      if (sub.photo) {
        await db.query('INSERT INTO people_photos (person_id, data) VALUES ($1, $2) ON CONFLICT (person_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [person.id, Buffer.from(sub.photo)]);
      }
      await db.query(
        `UPDATE ministry_leader_submissions SET status = 'aplicada', auto_applied = $2, person_id = $3, resolved_at = now(), photo = NULL, birth_date = '', cedula = '', address = '' WHERE id = $1`,
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
    "UPDATE ministry_leader_submissions SET status = 'descartada', resolved_at = now(), photo = NULL, birth_date = '', cedula = '', address = '' WHERE id = $1 AND status = 'pendiente'",
    [submissionId]
  );
  return rowCount > 0;
}

/** Respuestas por revisar, con la ficha actual para comparar. La foto no se trae, solo si tiene. */
async function listPending(db) {
  const { rows } = await db.query(
    `SELECT s.id, s.person_id, s.phone, s.wants_messages, s.created_at, s.ministerio, s.ministerios, s.congregacional, s.grupo_cuidado, (s.photo IS NOT NULL) AS has_photo,
            ${FIELDS.map((f) => `s.${f}`).join(', ')}, ${FIELDS.map((f) => `p.${f} AS cur_${f}`).join(', ')}
       FROM ministry_leader_submissions s LEFT JOIN people p ON p.id = s.person_id
      WHERE s.status = 'pendiente' ORDER BY s.created_at`
  );
  return rows;
}
const countPending = async (db) => (await db.query("SELECT count(*)::int AS n FROM ministry_leader_submissions WHERE status = 'pendiente'")).rows[0].n;

module.exports = { DESARROLLO, SIN_GRUPO, CONGREGACIONALES, SIN_CONGREGACIONAL, FIELDS, LABELS, SENSITIVE, ministeriosDe, joinList, getSettings, ensureToken, regenerateToken, setActive, tokenIsValid, ministryOptions, careGroupOptions, sameMinistry, parseSubmission, conflictsWith, submit, apply, discard, listPending, countPending };
