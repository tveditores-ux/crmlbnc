'use strict';

/**
 * Presentación de niños: registro de los niños presentados al Señor, como Bautizados pero de niños.
 * Lista independiente (sin FK a people): registrar aquí no crea personas ni toca opt_in.
 */
const { parseCsv, normalizeHeader } = require('./csv');
const { normName } = require('./consolidation/match');
const { tx } = require('./db');

const SEDES = ['Las Mercedes', 'Nuarito'];
const MAX_ROWS = 2000;

/** Columnas del archivo de carga (sin tildes ni mayúsculas) y el campo al que van. */
const HEADERS = {
  nombre: 'name', nino: 'name', nombre_del_nino: 'name', nombre_completo: 'name',
  nacimiento: 'birth_date', fecha_nacimiento: 'birth_date', fecha_de_nacimiento: 'birth_date',
  fecha_presentacion: 'presentation_date', presentacion: 'presentation_date', fecha: 'presentation_date',
  sede: 'sede',
  padres: 'parents', representantes: 'parents', padres_o_representantes: 'parents',
  presentado_por: 'presented_by', presentado: 'presented_by',
  nota: 'note', fuente: 'source', lista: 'source',
};
const TEMPLATE_HEADERS = ['nombre', 'nacimiento', 'fecha_presentacion', 'sede', 'padres', 'presentado_por', 'nota'];

const clip = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

/** Fecha 'AAAA-MM-DD' o 'DD/MM/AAAA' (también con - o .). Devuelve 'AAAA-MM-DD' o null. */
function parseDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y, m, d;
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    [, d, m, y] = r;
    if (y.length === 2) y = `20${y}`;
  } else return null;
  [y, m, d] = [+y, +m, +d];
  if (y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Convierte lo escrito en el formulario en un registro validado. Devuelve { value, errors }. */
function validateRow(raw, today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const v = {
    child_name: clip(raw.name, 120),
    sede: clip(raw.sede, 80),
    parents: clip(raw.parents, 200),
    presented_by: clip(raw.presented_by, 120),
    note: clip(raw.note, 1000),
    source: clip(raw.source, 80) || 'Registro manual',
  };
  if (!v.child_name) errors.push('Falta el nombre del niño.');
  if (String(raw.name || '').trim().length > 120) errors.push('El nombre es demasiado largo (máximo 120 caracteres).');
  if (v.sede && !SEDES.includes(v.sede)) errors.push('La sede debe ser Las Mercedes o Nuarito.');

  const birthRaw = String(raw.birth_date || '').trim();
  v.birth_date = parseDate(birthRaw);
  if (birthRaw && !v.birth_date) errors.push(`Fecha de nacimiento no válida: "${birthRaw}". Usa DD/MM/AAAA.`);
  if (v.birth_date && v.birth_date > today) errors.push('La fecha de nacimiento no puede ser futura.');

  const dateRaw = String(raw.presentation_date || '').trim();
  v.presentation_date = parseDate(dateRaw);
  if (dateRaw && !v.presentation_date) errors.push(`Fecha de presentación no válida: "${dateRaw}". Usa DD/MM/AAAA.`);
  if (v.presentation_date && v.presentation_date > today) errors.push('La fecha de presentación no puede ser futura.');
  if (v.birth_date && v.presentation_date && v.presentation_date < v.birth_date) errors.push('La presentación no puede ser antes del nacimiento.');

  return { value: v, errors };
}

async function add(db, raw, today) {
  const { value, errors } = validateRow(raw, today);
  if (errors.length) return { errors };
  const { rows } = await db.query(
    `INSERT INTO presentaciones_ninos (child_name, birth_date, presentation_date, sede, parents, presented_by, note, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [value.child_name, value.birth_date, value.presentation_date, value.sede, value.parents, value.presented_by, value.note, value.source]
  );
  return { id: rows[0].id, value };
}

async function list(db, { q = '', limit = 300 } = {}) {
  const needle = `%${String(q || '').trim().toLowerCase()}%`;
  const { rows } = await db.query(
    `SELECT id, child_name, birth_date::text AS birth_date, presentation_date::text AS presentation_date,
            sede, parents, presented_by, note, source, created_at
       FROM presentaciones_ninos
      WHERE ($1 = '' OR lower(child_name) LIKE $2 OR lower(parents) LIKE $2)
      ORDER BY presentation_date DESC NULLS LAST, id DESC
      LIMIT $3`,
    [String(q || '').trim(), needle, limit]
  );
  return rows;
}

async function stats(db, year) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE extract(year FROM presentation_date) = $1)::int AS this_year,
            count(*) FILTER (WHERE presentation_date IS NULL)::int AS no_date
       FROM presentaciones_ninos`,
    [year]
  );
  return rows[0];
}

async function remove(db, id) {
  const { rowCount } = await db.query('DELETE FROM presentaciones_ninos WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * Lee una lista ya existente. Sirve de dos formas:
 *  - Archivo CSV con encabezados (debe traer la columna "nombre").
 *  - Lista simple: un nombre por línea, sin encabezados.
 * defaults (fecha de presentación, sede, presentado por, fuente) se aplican a las filas que no traen ese dato.
 * Clasifica cada fila: nueva / ya_estaba (mismo nombre y misma fecha de presentación) / repetida (dos veces en la lista).
 */
async function prepareImport(db, text, { today, defaults = {} } = {}) {
  const rows = parseCsv(text);
  const fileErrors = [];
  if (!rows.length) return { records: [], fileErrors: ['No hay nada que cargar.'], unknown: [], mode: 'lista' };
  const headers = rows[0].map(normalizeHeader);
  const fields = headers.map((h) => HEADERS[h] || null);
  const mode = fields.includes('name') ? 'csv' : 'lista';
  const unknown = mode === 'csv' ? rows[0].filter((_, i) => !fields[i] && headers[i]) : [];
  const body = mode === 'csv' ? rows.slice(1) : rows;
  if (body.length > MAX_ROWS) fileErrors.push(`Hay más de ${MAX_ROWS} filas. Divídelo en partes.`);

  const existing = (await db.query('SELECT child_name, presentation_date::text AS d FROM presentaciones_ninos')).rows;
  const byNameDate = new Set(existing.map((r) => `${normName(r.child_name)}|${r.d || ''}`));
  const seenNameDate = new Set();
  const records = [];
  body.slice(0, MAX_ROWS).forEach((cells, idx) => {
    const raw = {};
    if (mode === 'csv') fields.forEach((f, i) => f && (raw[f] = cells[i] || ''));
    else raw.name = cells.map((c) => c.trim()).filter(Boolean).join(' ');
    for (const k of ['presentation_date', 'sede', 'presented_by', 'source']) if (!String(raw[k] || '').trim() && defaults[k]) raw[k] = defaults[k];
    const { value, errors } = validateRow(raw, today);
    let status = 'nueva';
    const nd = `${normName(value.child_name)}|${value.presentation_date || ''}`;
    if (byNameDate.has(nd)) status = 'ya_estaba';
    else if (seenNameDate.has(nd)) status = 'repetida';
    seenNameDate.add(nd);
    records.push({ line: idx + (mode === 'csv' ? 2 : 1), value, errors, status });
  });
  return { records, fileErrors, unknown, mode };
}

/** Guarda las filas nuevas. Las que ya estaban o están repetidas se omiten. Todo o nada. */
async function applyImport(pool, prepared) {
  if (prepared.fileErrors.length || prepared.records.some((r) => r.errors.length)) throw new Error('La carga tiene errores.');
  const toSave = prepared.records.filter((r) => r.status === 'nueva');
  await tx(pool, async (db) => {
    for (const { value: v } of toSave) {
      await db.query(
        'INSERT INTO presentaciones_ninos (child_name, birth_date, presentation_date, sede, parents, presented_by, note, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [v.child_name, v.birth_date, v.presentation_date, v.sede, v.parents, v.presented_by, v.note, v.source]
      );
    }
  });
  return { saved: toSave.length, skipped: prepared.records.length - toSave.length };
}

module.exports = { SEDES, HEADERS, TEMPLATE_HEADERS, parseDate, validateRow, add, list, stats, remove, prepareImport, applyImport };
