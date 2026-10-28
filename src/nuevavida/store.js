'use strict';
const { parseCsv, normalizeHeader } = require('../csv');
const { normalizePhone, normalizeEmail } = require('../phone');
const { parseDate } = require('../consolidation/stages');
const { classify, normName } = require('../consolidation/match');
const consolidation = require('../consolidation/store');
const { createPerson } = require('../consolidation/importer');
const { tx } = require('../db');

const PLACEHOLDER = '(sin nombre leído)';
const MAX_ROWS = 2000;

/** Columnas del archivo de carga (sin tildes ni mayúsculas) y el campo al que van. */
const HEADERS = {
  nombre: 'name', telefono: 'phone', correo: 'email', fecha_decision: 'decision_date', nota_fecha: 'date_note', sede: 'sede',
  edad: 'age', estado_civil: 'civil_status', direccion: 'address', como_llego: 'how_arrived', seguimiento: 'followup',
  nota: 'note', fuente: 'source', revisar: 'needs_review', aviso: 'review_note', texto_original: 'raw_text',
};
const TEMPLATE_HEADERS = Object.keys(HEADERS);
const YES = new Set(['si', 'sí', 'yes', '1', 'true', 'x']);

const clip = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

/** Convierte una fila del archivo en un registro validado. Devuelve { value, errors }. */
function validateRow(raw, countryCode = '58', today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const v = {
    full_name: clip(raw.name, 120) || PLACEHOLDER,
    email: null,
    sede: clip(raw.sede, 80),
    civil_status: clip(raw.civil_status, 30),
    address: clip(raw.address, 300),
    how_arrived: clip(raw.how_arrived, 300),
    followup: clip(raw.followup, 1000),
    note: clip(raw.note, 1000),
    date_note: clip(raw.date_note, 300),
    source: clip(raw.source, 80) || 'Archivo importado',
    review_note: clip(raw.review_note, 500),
    raw_text: String(raw.raw_text ?? '').trim().slice(0, 3000),
  };
  v.needs_review = YES.has(clip(raw.needs_review, 10).toLowerCase()) || v.full_name === PLACEHOLDER;
  if (String(raw.name || '').trim().length > 120) errors.push('El nombre es demasiado largo (máximo 120 caracteres).');
  if (v.full_name === PLACEHOLDER && !v.review_note) v.review_note = 'No se pudo leer el nombre: revisar el texto original.';

  const phoneRaw = clip(raw.phone, 40);
  v.phone = phoneRaw ? normalizePhone(phoneRaw, countryCode) : null;
  if (phoneRaw && !v.phone) errors.push(`Teléfono no válido: "${phoneRaw}".`);

  const emailRaw = clip(raw.email, 120);
  if (emailRaw) {
    v.email = normalizeEmail(emailRaw);
    if (!v.email) errors.push(`Correo no válido: "${emailRaw}".`);
  }

  const dateRaw = String(raw.decision_date || '').trim();
  v.decision_date = parseDate(dateRaw);
  if (dateRaw && !v.decision_date) errors.push(`Fecha no válida: "${dateRaw}".`);
  if (v.decision_date && v.decision_date > today) errors.push('La fecha no puede ser futura.');
  if (!v.decision_date && !dateRaw) {
    v.needs_review = true;
    v.review_note = [v.review_note, 'Sin fecha de decisión.'].filter(Boolean).join('; ');
  }

  const ageRaw = String(raw.age ?? '').trim();
  v.age = null;
  if (ageRaw) {
    if (/^\d{1,3}$/.test(ageRaw) && +ageRaw <= 120) v.age = +ageRaw;
    else errors.push(`Edad no válida: "${ageRaw}".`);
  }
  return { value: v, errors };
}

/** Lee el archivo y lo clasifica: nueva / ya estaba (mismo teléfono, o mismo nombre y fecha) / con errores. */
async function prepareImport(db, text, countryCode = '58', today) {
  const rows = parseCsv(text);
  const fileErrors = [];
  if (!rows.length) return { records: [], fileErrors: ['El archivo está vacío.'], unknown: [] };
  const headers = rows[0].map(normalizeHeader);
  const fields = headers.map((h) => HEADERS[h] || null);
  const unknown = rows[0].filter((_, i) => !fields[i] && headers[i]);
  if (!fields.includes('name')) fileErrors.push('Falta la columna "nombre".');
  if (rows.length - 1 > MAX_ROWS) fileErrors.push(`El archivo tiene más de ${MAX_ROWS} filas. Divídelo en partes.`);

  const existing = (await db.query('SELECT phone, full_name, decision_date::text AS d FROM nueva_vida')).rows;
  const byPhone = new Set(existing.filter((r) => r.phone).map((r) => r.phone));
  const byNameDate = new Set(existing.map((r) => `${normName(r.full_name)}|${r.d || ''}`));
  const seenPhone = new Set();
  const seenNameDate = new Set();
  const records = [];
  rows.slice(1, MAX_ROWS + 1).forEach((cells, idx) => {
    const raw = {};
    fields.forEach((f, i) => {
      if (f) raw[f] = cells[i] || '';
    });
    const { value, errors } = validateRow(raw, countryCode, today);
    let status = 'nueva';
    const nd = `${normName(value.full_name)}|${value.decision_date || ''}`;
    if (value.phone) {
      if (byPhone.has(value.phone)) status = 'ya_estaba';
      else if (seenPhone.has(value.phone)) status = 'repetida';
      seenPhone.add(value.phone);
    } else if (value.full_name !== PLACEHOLDER) {
      if (byNameDate.has(nd)) status = 'ya_estaba';
      else if (seenNameDate.has(nd)) status = 'repetida';
      seenNameDate.add(nd);
    }
    records.push({ line: idx + 2, value, errors, status });
  });
  return { records, fileErrors, unknown };
}

/** Guarda las filas nuevas. Las que ya estaban o están repetidas se omiten. Todo o nada. */
async function applyImport(pool, prepared) {
  if (prepared.fileErrors.length || prepared.records.some((r) => r.errors.length)) throw new Error('El archivo tiene errores.');
  const toSave = prepared.records.filter((r) => r.status === 'nueva');
  await tx(pool, async (db) => {
    for (const { value: v } of toSave) {
      await db.query(
        `INSERT INTO nueva_vida (full_name, phone, email, decision_date, date_note, sede, age, civil_status, address, how_arrived,
                                 followup, note, source, needs_review, review_note, raw_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [v.full_name, v.phone, v.email, v.decision_date, v.date_note, v.sede, v.age, v.civil_status, v.address, v.how_arrived,
          v.followup, v.note, v.source, v.needs_review, v.review_note, v.raw_text]
      );
    }
  });
  return { saved: toSave.length, skipped: prepared.records.length - toSave.length };
}

function filterSql(f) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.fuente) add('n.source = ?', String(f.fuente).slice(0, 80));
  if (f.conexion === 'conectada') where.push('n.consolidation_id IS NOT NULL');
  if (f.conexion === 'sin_conectar') where.push('n.consolidation_id IS NULL');
  if (f.revisar === 'si') where.push('n.needs_review');
  if (f.telefono === 'sin') where.push('n.phone IS NULL');
  if (/^\d{4}-\d{2}$/.test(String(f.mes || ''))) add("to_char(n.decision_date, 'YYYY-MM') = ?", f.mes);
  const q = String(f.q || '').trim().slice(0, 80);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const i = params.length;
    where.push(`(n.full_name ILIKE $${i} OR n.phone LIKE $${i})`);
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

async function list(db, f = {}, limit = 600) {
  const fl = filterSql(f);
  const { rows } = await db.query(
    `SELECT n.id, n.full_name, n.phone, n.decision_date::text AS d, n.date_note, n.source, n.needs_review, n.review_note, n.age,
            n.consolidation_id, n.person_id, c.historical
       FROM nueva_vida n LEFT JOIN consolidation c ON c.id = n.consolidation_id${fl.sql}
      ORDER BY n.decision_date DESC NULLS LAST, n.id DESC LIMIT ${Math.min(+limit || 600, 2000)}`,
    fl.params
  );
  return rows;
}

async function stats(db) {
  return (
    await db.query(
      `SELECT count(*)::int AS total, count(phone)::int AS with_phone,
              count(*) FILTER (WHERE consolidation_id IS NOT NULL)::int AS connected,
              count(*) FILTER (WHERE needs_review)::int AS review,
              count(*) FILTER (WHERE age IS NOT NULL AND age < 18)::int AS minors
         FROM nueva_vida`
    )
  ).rows[0];
}

async function filterOptions(db) {
  const sources = (await db.query('SELECT DISTINCT source FROM nueva_vida ORDER BY source')).rows.map((r) => r.source);
  const months = (await db.query(`SELECT DISTINCT to_char(decision_date, 'YYYY-MM') AS m FROM nueva_vida WHERE decision_date IS NOT NULL ORDER BY m DESC`)).rows.map((r) => r.m);
  return { sources, months };
}

async function get(db, id) {
  const { rows } = await db.query(
    `SELECT n.*, n.decision_date::text AS d, p.full_name AS person_name, c.historical
       FROM nueva_vida n LEFT JOIN people p ON p.id = n.person_id LEFT JOIN consolidation c ON c.id = n.consolidation_id WHERE n.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** Crea o corrige un registro a mano. Devuelve { id } o { errors }. */
async function save(db, id, raw, countryCode = '58', today) {
  const { value: v, errors } = validateRow(raw, countryCode, today);
  if (String(raw.name || '').trim() === '') errors.push('Escribe el nombre.');
  if (errors.length) return { errors };
  const params = [v.full_name, v.phone, v.email, v.decision_date, v.date_note, v.sede, v.age, v.civil_status, v.address, v.how_arrived, v.followup, v.note, v.needs_review, v.review_note];
  if (id) {
    const { rowCount } = await db.query(
      `UPDATE nueva_vida SET full_name=$2, phone=$3, email=$4, decision_date=$5, date_note=$6, sede=$7, age=$8, civil_status=$9, address=$10,
              how_arrived=$11, followup=$12, note=$13, needs_review=$14, review_note=$15, updated_at=now() WHERE id=$1`,
      [id, ...params]
    );
    return rowCount ? { id } : { errors: ['No existe ese registro.'] };
  }
  const { rows } = await db.query(
    `INSERT INTO nueva_vida (full_name, phone, email, decision_date, date_note, sede, age, civil_status, address, how_arrived, followup, note, needs_review, review_note, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Registro manual') RETURNING id`,
    params
  );
  return { id: rows[0].id };
}

async function remove(db, id) {
  await db.query('DELETE FROM nueva_vida WHERE id = $1', [id]);
}

/**
 * Conecta un registro de Nueva Vida con consolidación.
 *  - Mismo teléfono que una persona del CRM: se usa esa persona.
 *  - Nombre parecido: no se une solo; devuelve las candidatas para que alguien confirme (choice = id | 'nueva').
 *  - Si no hay nadie parecido: se crea la persona, sin consentimiento para mensajes.
 * Devuelve { status: 'conectada' | 'ya_conectada' | 'sin_fecha' | 'confirmar' | 'no_existe', ... }.
 */
async function connectOne(db, id, { historical = true, choice = '', countryCode = '58', assignedTo = null } = {}) {
  const rec = await get(db, id);
  if (!rec) return { status: 'no_existe' };
  if (rec.consolidation_id) return { status: 'ya_conectada' };
  if (rec.full_name === PLACEHOLDER) return { status: 'sin_nombre' };
  if (!rec.d) return { status: 'sin_fecha' };
  const people = (await db.query('SELECT id, full_name, phone FROM people')).rows;
  const cls = classify({ name: rec.full_name, phone: rec.phone || '' }, people, countryCode);
  let personId = null;
  if (cls.group === 'existe') personId = cls.person.id;
  else if (cls.group === 'posible') {
    if (!choice) return { status: 'confirmar', candidates: cls.candidates.map((c) => c.person) };
    if (choice !== 'nueva') {
      if (!cls.candidates.some((c) => String(c.person.id) === String(choice))) return { status: 'eleccion_no_valida' };
      personId = +choice;
    }
  }
  return tx(db, async (c) => {
    const pid = personId === null ? await createPerson(c, { name: rec.full_name }, rec.phone) : personId;
    const out = await consolidation.upsertConsolidation(c, pid, { decision_date: rec.d, sede: rec.sede, invited_by: '', assigned_to: assignedTo, historical });
    await c.query('UPDATE nueva_vida SET person_id = $2, consolidation_id = $3, connected_at = now(), updated_at = now() WHERE id = $1', [id, pid, out.id]);
    return { status: 'conectada', consolidationId: out.id, personId: pid, created: out.created };
  });
}

/** Conecta varios. Las que necesitan confirmar por nombre se dejan para hacerlas una por una. */
async function connectMany(db, ids, opts = {}) {
  const summary = { conectada: 0, ya_conectada: 0, sin_fecha: 0, sin_nombre: 0, confirmar: 0, no_existe: 0 };
  for (const id of ids) {
    const r = await connectOne(db, id, { ...opts, choice: '' });
    summary[r.status] = (summary[r.status] || 0) + 1;
  }
  return summary;
}

module.exports = {
  PLACEHOLDER, TEMPLATE_HEADERS, HEADERS, validateRow, prepareImport, applyImport, list, stats, filterOptions, get, save, remove, connectOne, connectMany, filterSql,
};
