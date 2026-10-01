'use strict';
const crypto = require('crypto');
const { tx } = require('./db');
const { normalizePhone, normalizeEmail } = require('./phone');

const newToken = () => crypto.randomBytes(12).toString('base64url');

function parseYes(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return null;
  if (['si', 's', 'yes', 'y', 'x', '1', 'true', 'acepta'].includes(t)) return true;
  if (['no', 'n', '0', 'false'].includes(t)) return false;
  return null;
}

function parseChannel(v) {
  const t = String(v || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return null;
  if (t.startsWith('whats') || t === 'wa') return 'whatsapp';
  if (t.startsWith('correo') || t.startsWith('email') || t === 'mail') return 'email';
  if (t.startsWith('amb') || t === 'los dos' || t === 'todos') return 'ambos';
  return null;
}

function splitMinistries(v) {
  return String(v || '')
    .split(/[|,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Valida y normaliza los datos de una persona. Devuelve { value, errors }. */
function validatePerson(input, countryCode, { allowNoContact = false } = {}) {
  const errors = [];
  const full_name = String(input.full_name || '').trim().replace(/\s+/g, ' ');
  if (!full_name) errors.push('Falta el nombre.');
  let phone = null;
  if (input.phone && String(input.phone).trim()) {
    phone = normalizePhone(input.phone, countryCode);
    if (!phone) errors.push(`Teléfono no válido: "${input.phone}".`);
  }
  let email = null;
  if (input.email && String(input.email).trim()) {
    email = normalizeEmail(input.email);
    if (!email) errors.push(`Correo no válido: "${input.email}".`);
  }
  if (!phone && !email && !errors.length && !allowNoContact) errors.push('Necesita al menos teléfono o correo.');
  const preferred_channel = input.preferred_channel || (phone ? 'whatsapp' : 'email');
  if (!['whatsapp', 'email', 'ambos'].includes(preferred_channel)) errors.push('Canal no válido.');
  return {
    errors,
    value: {
      full_name,
      phone,
      email,
      role: String(input.role || '').trim(),
      preferred_channel,
      // Sin teléfono ni correo no hay a quién escribir: nunca queda con consentimiento.
      opt_in: Boolean(input.opt_in) && Boolean(phone || email),
      active: input.active === undefined ? true : Boolean(input.active),
      notes: String(input.notes || '').trim(),
    },
  };
}

async function ensureMinistry(db, name) {
  const clean = String(name).trim().replace(/\s+/g, ' ');
  const { rows } = await db.query(
    `INSERT INTO ministries (name) VALUES ($1)
     ON CONFLICT ((lower(name))) DO UPDATE SET name = ministries.name
     RETURNING id`,
    [clean]
  );
  return rows[0].id;
}

async function setPersonMinistries(db, personId, ministryIds) {
  await db.query('DELETE FROM person_ministries WHERE person_id = $1', [personId]);
  for (const mid of ministryIds) {
    await db.query(
      'INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [personId, mid]
    );
  }
}

async function findExisting(db, { phone, email }, excludeId = null) {
  const { rows } = await db.query(
    `SELECT id FROM people
      WHERE ((phone IS NOT NULL AND phone = $1) OR (email IS NOT NULL AND lower(email) = lower($2)))
        AND ($3::int IS NULL OR id <> $3)
      ORDER BY id LIMIT 1`,
    [phone, email, excludeId]
  );
  return rows[0] ? rows[0].id : null;
}

/** Busca por nombre (sin distinguir mayúsculas); para filas sin contacto. */
async function findByName(db, fullName) {
  const { rows } = await db.query('SELECT id FROM people WHERE lower(full_name) = lower($1) ORDER BY id LIMIT 1', [fullName]);
  return rows[0] ? rows[0].id : null;
}

async function savePerson(db, id, v) {
  if (id) {
    await db.query(
      `UPDATE people SET full_name=$2, phone=$3, email=$4, role=$5, preferred_channel=$6,
              opt_in=$7, active=$8, notes=$9, updated_at=now() WHERE id=$1`,
      [id, v.full_name, v.phone, v.email, v.role, v.preferred_channel, v.opt_in, v.active, v.notes]
    );
    return id;
  }
  const { rows } = await db.query(
    `INSERT INTO people (full_name, phone, email, role, preferred_channel, opt_in, active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [v.full_name, v.phone, v.email, v.role, v.preferred_channel, v.opt_in, v.active, v.notes]
  );
  return rows[0].id;
}

/**
 * Importa personas desde registros del CSV. Si ya existe alguien con el mismo teléfono o
 * correo, lo actualiza (y le suma los ministerios). Todo o nada: si hay errores, no guarda.
 */
const hasContact = (v) => Boolean(v.phone || v.email);

async function importPeople(pool, records, countryCode, { dryRun = false } = {}) {
  const report = { created: 0, updated: 0, errors: [], ministriesCreated: [] };
  const prepared = [];
  const seen = new Map();

  for (const rec of records) {
    const optIn = parseYes(rec.acepta_mensajes);
    const { value, errors } = validatePerson(
      {
        full_name: rec.nombre,
        phone: rec.telefono,
        email: rec.correo,
        role: rec.rol,
        preferred_channel: parseChannel(rec.canal) || undefined,
        opt_in: optIn === true,
      },
      countryCode,
      { allowNoContact: true }
    );
    if (rec.canal && !parseChannel(rec.canal)) errors.push(`Canal no reconocido: "${rec.canal}".`);
    const key = value.phone || value.email || `nombre:${value.full_name.toLowerCase()}`;
    if (key && seen.has(key)) errors.push(`Repetido con la línea ${seen.get(key)}.`);
    if (key) seen.set(key, rec._line);
    if (errors.length) report.errors.push({ line: rec._line, name: value.full_name, errors });
    prepared.push({ value, ministries: splitMinistries(rec.ministerios), line: rec._line });
  }
  if (report.errors.length || dryRun) {
    if (dryRun && !report.errors.length) {
      for (const p of prepared) {
        const existing = hasContact(p.value) ? await findExisting(pool, p.value) : await findByName(pool, p.value.full_name);
        if (existing) report.updated++;
        else report.created++;
      }
    }
    return report;
  }

  await tx(pool, async (db) => {
    const before = new Set((await db.query('SELECT lower(name) AS n FROM ministries')).rows.map((r) => r.n));
    for (const p of prepared) {
      const contact = hasContact(p.value);
      const existing = contact ? await findExisting(db, p.value) : await findByName(db, p.value.full_name);
      // Una fila sin contacto nunca pisa los datos de alguien que ya los tiene: solo suma ministerios.
      const id = !contact && existing ? existing : await savePerson(db, existing, p.value);
      if (existing) report.updated++;
      else report.created++;
      for (const name of p.ministries) {
        const mid = await ensureMinistry(db, name);
        if (!before.has(name.toLowerCase())) {
          before.add(name.toLowerCase());
          report.ministriesCreated.push(name);
        }
        await db.query(
          'INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, mid]
        );
      }
    }
  });
  return report;
}

/** Agrega como participantes a todos los miembros activos de los ministerios del evento. */
async function syncEventMinistryMembers(db, eventId) {
  const { rows } = await db.query(
    `SELECT DISTINCT pm.person_id
       FROM event_ministries em
       JOIN person_ministries pm ON pm.ministry_id = em.ministry_id
       JOIN people p ON p.id = pm.person_id AND p.active
      WHERE em.event_id = $1`,
    [eventId]
  );
  let added = 0;
  for (const r of rows) added += await addParticipant(db, eventId, r.person_id);
  return added;
}

async function addParticipant(db, eventId, personId) {
  const { rowCount } = await db.query(
    `INSERT INTO event_participants (event_id, person_id, token) VALUES ($1,$2,$3)
     ON CONFLICT (event_id, person_id) DO NOTHING`,
    [eventId, personId, newToken()]
  );
  return rowCount;
}

async function saveEvent(pool, id, ev, ministryIds) {
  return tx(pool, async (db) => {
    let eventId = id;
    if (id) {
      await db.query(
        `UPDATE events SET title=$2, description=$3, location=$4, starts_at=$5, updated_at=now() WHERE id=$1`,
        [id, ev.title, ev.description, ev.location, ev.starts_at]
      );
      await db.query('DELETE FROM event_ministries WHERE event_id=$1', [id]);
    } else {
      const { rows } = await db.query(
        `INSERT INTO events (title, description, location, starts_at) VALUES ($1,$2,$3,$4) RETURNING id`,
        [ev.title, ev.description, ev.location, ev.starts_at]
      );
      eventId = rows[0].id;
    }
    for (const mid of ministryIds) {
      await db.query('INSERT INTO event_ministries (event_id, ministry_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        eventId,
        mid,
      ]);
    }
    const added = await syncEventMinistryMembers(db, eventId);
    return { eventId, added };
  });
}

module.exports = {
  newToken,
  parseYes,
  parseChannel,
  splitMinistries,
  validatePerson,
  ensureMinistry,
  setPersonMinistries,
  findExisting,
  savePerson,
  importPeople,
  addParticipant,
  syncEventMinistryMembers,
  saveEvent,
};
