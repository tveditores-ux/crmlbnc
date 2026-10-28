'use strict';
const { parseCsv, normalizeHeader } = require('../csv');
const { normalizePhone } = require('../phone');
const { classify, normName } = require('./match');
const { parseDate, STATUSES, LOST_REASONS } = require('./stages');
const store = require('./store');

/** Columnas aceptadas (sin tildes ni mayúsculas) y el campo al que van. */
const HEADERS = {
  nombre: 'name', nombre_completo: 'name', nombre_y_apellido: 'name',
  telefono: 'phone', whatsapp: 'phone', celular: 'phone',
  fecha_decision: 'decision_date', fecha_de_decision: 'decision_date', decision: 'decision_date', fecha: 'decision_date',
  sede: 'sede',
  invitado_por: 'invited_by', quien_lo_invito: 'invited_by', invito: 'invited_by',
  responsable: 'responsible', responsable_nueva_vida: 'responsible',
  llamada: 'call_date', fecha_llamada: 'call_date',
  reunion: 'meeting_date', fecha_reunion: 'meeting_date', reunion_nueva_vida: 'meeting_date',
  primeros_pasos_inicio: 'pp_start_date', inicio_primeros_pasos: 'pp_start_date',
  primeros_pasos_fin: 'pp_end_date', fin_primeros_pasos: 'pp_end_date', primeros_pasos_termino: 'pp_end_date',
  bautismo: 'baptism_date', fecha_bautismo: 'baptism_date',
  grupo: 'group_name', grupo_de_cuidado: 'group_name', fecha_grupo: 'group_date',
  riel: 'riel_date', fecha_riel: 'riel_date',
  estado: 'status', motivo: 'lost_reason',
};
const DATE_FIELDS = ['decision_date', 'call_date', 'meeting_date', 'pp_start_date', 'pp_end_date', 'baptism_date', 'group_date', 'riel_date'];
const ORDER = ['decision_date', 'call_date', 'meeting_date', 'pp_start_date', 'pp_end_date', 'baptism_date', 'group_date', 'riel_date'];
const DATE_LABEL = {
  decision_date: 'fecha de decisión', call_date: 'llamada', meeting_date: 'reunión', pp_start_date: 'inicio de Primeros Pasos',
  pp_end_date: 'fin de Primeros Pasos', baptism_date: 'bautismo', group_date: 'grupo', riel_date: 'riel',
};

const key = (s) => normName(s).replace(/\s+/g, '_');
const byLabel = (obj) => Object.assign(Object.create(null), Object.fromEntries(Object.entries(obj).flatMap(([k, label]) => [[key(label), k], [key(k), k]])));
const STATUS_IN = Object.assign(byLabel(STATUSES), { pausa: 'en_pausa', activa: 'activo', perdida: 'perdido' });
const REASON_IN = byLabel(LOST_REASONS);
const MAX_ROWS = 2000;

const TEMPLATE_HEADERS = ['nombre', 'telefono', 'fecha_decision', 'sede', 'invitado_por', 'responsable', 'llamada', 'reunion', 'primeros_pasos_inicio', 'primeros_pasos_fin', 'bautismo', 'grupo', 'fecha_grupo', 'riel', 'estado', 'motivo'];

/** Lee el CSV y lo convierte en filas con campos estándar y errores por fila. */
function readCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], fileErrors: ['El archivo está vacío.'], unknown: [] };
  const headers = rows[0].map(normalizeHeader);
  const fields = headers.map((h) => HEADERS[h] || null);
  const unknown = rows[0].filter((_, i) => !fields[i] && headers[i]);
  const fileErrors = [];
  if (!fields.includes('name')) fileErrors.push('Falta la columna "nombre".');
  if (!fields.includes('decision_date')) fileErrors.push('Falta la columna "fecha_decision".');
  if (rows.length - 1 > MAX_ROWS) fileErrors.push(`El archivo tiene más de ${MAX_ROWS} filas. Divídelo en partes.`);
  const out = rows.slice(1, MAX_ROWS + 1).map((r, idx) => {
    const raw = {};
    fields.forEach((f, i) => {
      if (f) raw[f] = (r[i] || '').trim();
    });
    return { line: idx + 2, raw };
  });
  return { rows: out, fileErrors, unknown };
}

/** Valida una fila. Devuelve { value, errors }. `today` ('AAAA-MM-DD') impide fechas futuras. */
function validateRow(raw, countryCode = '58', today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const value = {
    name: String(raw.name || '').trim().replace(/\s+/g, ' '),
    phone: String(raw.phone || '').trim().slice(0, 40),
    sede: String(raw.sede || '').trim().replace(/\s+/g, ' '),
    invited_by: String(raw.invited_by || '').trim(),
    responsible: String(raw.responsible || '').trim().slice(0, 120),
    group_name: String(raw.group_name || '').trim().slice(0, 120),
  };
  if (!value.name) errors.push('Falta el nombre.');
  if (value.name.length > 120) errors.push('El nombre es demasiado largo (máximo 120 caracteres).');
  if (value.sede.length > 80) errors.push('La sede es demasiado larga (máximo 80 caracteres).');
  if (value.invited_by.length > 120) errors.push('«Invitado por» es demasiado largo (máximo 120 caracteres).');
  if (value.phone && !normalizePhone(value.phone, countryCode)) errors.push(`Teléfono no válido: "${value.phone}".`);
  for (const f of DATE_FIELDS) {
    const d = parseDate(raw[f]);
    if (String(raw[f] || '').trim() && !d) errors.push(`Fecha no válida en ${DATE_LABEL[f]}: "${raw[f]}".`);
    value[f] = d;
    if (d && d > today) errors.push(`La fecha de ${DATE_LABEL[f]} no puede ser futura.`);
  }
  if (!value.decision_date && !errors.some((e) => e.includes('decisión'))) errors.push('Falta la fecha de decisión.');
  if (value.decision_date) {
    for (const f of ORDER.slice(1)) {
      if (value[f] && value[f] < value.decision_date) errors.push(`La fecha de ${DATE_LABEL[f]} es anterior a la decisión.`);
    }
    if (value.pp_start_date && value.pp_end_date && value.pp_end_date < value.pp_start_date) errors.push('El fin de Primeros Pasos es anterior a su inicio.');
  }
  const st = String(raw.status || '').trim();
  value.status = 'activo';
  if (st) {
    value.status = STATUS_IN[key(st)] || null;
    if (!value.status) errors.push(`Estado no reconocido: "${st}".`);
  }
  const reason = String(raw.lost_reason || '').trim();
  if (value.status === 'perdido') {
    value.lost_reason = REASON_IN[key(reason)] || null;
    if (!value.lost_reason) errors.push('Una persona perdida necesita un motivo válido (no contesta, se mudó, otra iglesia, otra ciudad o país, no le interesa).');
  }
  return { value, errors };
}

/**
 * Revisa el archivo sin guardar nada. Cada fila queda en uno de tres grupos:
 *  existe (mismo teléfono), posible (nombre parecido, hay que confirmar) o nueva.
 */
async function prepare(db, text, countryCode = '58', today) {
  const { rows, fileErrors, unknown } = readCsv(text);
  const people = (await db.query('SELECT id, full_name, phone, active FROM people')).rows;
  const inConsolidation = new Set((await db.query('SELECT person_id FROM consolidation')).rows.map((r) => r.person_id));
  const volunteers = await store.nuevaVidaPeople(db);
  const seenPhone = new Map();
  const seenName = new Map();
  const records = [];
  for (const { line, raw } of rows) {
    const { value, errors } = validateRow(raw, countryCode, today);
    const warnings = [];
    const phone = normalizePhone(value.phone, countryCode);
    if (phone && seenPhone.has(phone)) errors.push(`Repetida: mismo teléfono que la línea ${seenPhone.get(phone)}.`);
    else if (phone) seenPhone.set(phone, line);
    const nn = normName(value.name);
    if (!phone && nn) {
      if (seenName.has(nn)) errors.push(`Repetida: mismo nombre que la línea ${seenName.get(nn)}.`);
      else seenName.set(nn, line);
    }
    const cls = classify({ name: value.name, phone: value.phone }, people, countryCode);
    if (cls.group === 'existe' && inConsolidation.has(cls.person.id)) warnings.push('Ya está en consolidación: solo se completarán los datos que falten.');
    if (cls.group === 'existe' && cls.person.active === false) warnings.push('La ficha existente está marcada como inactiva.');
    let responsibleId = null;
    if (value.responsible) {
      responsibleId = store.matchResponsible(value.responsible, volunteers);
      if (!responsibleId) warnings.push(`No encontré a "${value.responsible}" entre las personas de Nueva Vida; quedará sin responsable.`);
    }
    records.push({ line, value, errors, warnings, group: cls.group, person: cls.person || null, candidates: cls.candidates || [], phone, responsibleId });
  }
  return { records, fileErrors, unknown };
}

/**
 * Guarda todo o nada. decisions: { [línea]: id de la persona elegida | 'nueva' } solo para las "posibles".
 * Falla si alguna "posible" no se confirmó o si se elige a alguien que no era candidato.
 */
async function apply(pool, prepared, decisions = {}) {
  const { tx } = require('../db');
  const bad = prepared.records.filter((r) => r.errors.length);
  if (bad.length || prepared.fileErrors.length) throw new Error('El archivo tiene errores.');
  const pending = prepared.records.filter((r) => r.group === 'posible' && !decisions[r.line]);
  if (pending.length) throw new Error(`Falta confirmar ${pending.length} coincidencias por nombre.`);
  const summary = { newPeople: 0, linked: 0, created: 0, updated: 0 };
  await tx(pool, async (db) => {
    for (const r of prepared.records) {
      let personId;
      if (r.group === 'existe') {
        personId = r.person.id;
        summary.linked++;
      } else if (r.group === 'posible' && decisions[r.line] !== 'nueva') {
        const chosen = Number(decisions[r.line]);
        if (!r.candidates.some((c) => c.person.id === chosen)) throw new Error(`Elección no válida en la línea ${r.line}.`);
        personId = chosen;
        summary.linked++;
      } else {
        personId = await createPerson(db, r.value, r.phone);
        summary.newPeople++;
      }
      const out = await store.upsertConsolidation(db, personId, { ...r.value, assigned_to: r.responsibleId });
      if (out.created) summary.created++;
      else summary.updated++;
    }
  });
  return summary;
}

/** Crea una persona nueva sin consentimiento. Si el teléfono ya existiera (carrera entre dos cargas), usa a esa persona. */
async function createPerson(db, v, phone) {
  const { rows } = await db.query(
    `INSERT INTO people (full_name, phone, role, preferred_channel, opt_in, active)
     VALUES ($1, $2, 'Nuevo creyente', 'whatsapp', FALSE, TRUE)
     ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET full_name = people.full_name
     RETURNING id`,
    [v.name, phone || null]
  );
  return rows[0].id;
}

module.exports = { prepare, apply, readCsv, validateRow, createPerson, TEMPLATE_HEADERS, HEADERS };
