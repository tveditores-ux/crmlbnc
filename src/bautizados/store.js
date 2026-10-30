'use strict';
const { parseCsv, normalizeHeader } = require('../csv');
const { normalizePhone } = require('../phone');
const { normName, nameScore, THRESHOLD } = require('../consolidation/match');
const { tx } = require('../db');

const MAX_ROWS = 2000;

/** Columnas del archivo de carga (sin tildes ni mayúsculas) y el campo al que van. */
const HEADERS = {
  nombre: 'name', nombre_completo: 'name', nombre_y_apellido: 'name',
  telefono: 'phone', whatsapp: 'phone', celular: 'phone',
  fecha_bautismo: 'baptism_date', fecha: 'baptism_date', bautismo: 'baptism_date',
  sede: 'sede', ministro: 'minister', bautizado_por: 'minister', nota: 'note', fuente: 'source',
};
const TEMPLATE_HEADERS = ['nombre', 'telefono', 'fecha_bautismo', 'sede', 'ministro', 'nota'];

const clip = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

/** Fecha 'AAAA-MM-DD' o 'DD/MM/AAAA' (también con - o .). Acepta listas viejas: desde 1940. */
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
  if (y < 1940 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Convierte una fila (o lo escrito en el formulario) en un registro validado. Devuelve { value, errors }. */
function validateRow(raw, countryCode = '58', today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const v = {
    full_name: clip(raw.name, 120),
    sede: clip(raw.sede, 80),
    minister: clip(raw.minister, 120),
    note: clip(raw.note, 1000),
    source: clip(raw.source, 80) || 'Registro manual',
  };
  if (!v.full_name) errors.push('Falta el nombre.');
  if (String(raw.name || '').trim().length > 120) errors.push('El nombre es demasiado largo (máximo 120 caracteres).');

  const phoneRaw = clip(raw.phone, 40);
  v.phone = phoneRaw ? normalizePhone(phoneRaw, countryCode) : null;
  if (phoneRaw && !v.phone) errors.push(`Teléfono no válido: "${phoneRaw}".`);

  const dateRaw = String(raw.baptism_date || '').trim();
  v.baptism_date = parseDate(dateRaw);
  if (dateRaw && !v.baptism_date) errors.push(`Fecha no válida: "${dateRaw}". Usa DD/MM/AAAA.`);
  if (v.baptism_date && v.baptism_date > today) errors.push('La fecha del bautismo no puede ser futura.');
  return { value: v, errors };
}

/**
 * Lee lo cargado. Sirve de dos formas:
 *  - Archivo CSV con encabezados (debe traer la columna "nombre").
 *  - Lista simple: un nombre por línea, sin encabezados.
 * defaults (fecha, sede, ministro, fuente) se aplican a las filas que no traen ese dato.
 * Clasifica cada fila: nueva / ya_estaba (mismo teléfono, o mismo nombre y fecha) / repetida (dos veces en lo cargado).
 */
async function prepareImport(db, text, { countryCode = '58', today, defaults = {} } = {}) {
  const rows = parseCsv(text);
  const fileErrors = [];
  if (!rows.length) return { records: [], fileErrors: ['No hay nada que cargar.'], unknown: [], mode: 'lista' };
  const headers = rows[0].map(normalizeHeader);
  const fields = headers.map((h) => HEADERS[h] || null);
  const mode = fields.includes('name') ? 'csv' : 'lista';
  const unknown = mode === 'csv' ? rows[0].filter((_, i) => !fields[i] && headers[i]) : [];
  const body = mode === 'csv' ? rows.slice(1) : rows;
  if (body.length > MAX_ROWS) fileErrors.push(`Hay más de ${MAX_ROWS} filas. Divídelo en partes.`);

  const existing = (await db.query('SELECT phone, full_name, baptism_date::text AS d FROM bautizados')).rows;
  const byPhone = new Set(existing.filter((r) => r.phone).map((r) => r.phone));
  const byNameDate = new Set(existing.map((r) => `${normName(r.full_name)}|${r.d || ''}`));
  const seenPhone = new Set();
  const seenNameDate = new Set();
  const records = [];
  body.slice(0, MAX_ROWS).forEach((cells, idx) => {
    const raw = {};
    if (mode === 'csv') fields.forEach((f, i) => f && (raw[f] = cells[i] || ''));
    else {
      // "Nombre" o "Nombre, teléfono": si lo último parece un teléfono, va aparte.
      const parts = cells.map((c) => c.trim()).filter(Boolean);
      if (parts.length > 1 && /^[+\d][\d\s().-]{6,}$/.test(parts[parts.length - 1])) raw.phone = parts.pop();
      raw.name = parts.join(' ');
    }
    for (const k of ['baptism_date', 'sede', 'minister', 'source']) if (!String(raw[k] || '').trim() && defaults[k]) raw[k] = defaults[k];
    const { value, errors } = validateRow(raw, countryCode, today);
    let status = 'nueva';
    const nd = `${normName(value.full_name)}|${value.baptism_date || ''}`;
    if (value.phone && byPhone.has(value.phone)) status = 'ya_estaba';
    else if (byNameDate.has(nd)) status = 'ya_estaba';
    else if ((value.phone && seenPhone.has(value.phone)) || seenNameDate.has(nd)) status = 'repetida';
    if (value.phone) seenPhone.add(value.phone);
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
        'INSERT INTO bautizados (full_name, phone, baptism_date, sede, minister, note, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [v.full_name, v.phone, v.baptism_date, v.sede, v.minister, v.note, v.source]
      );
    }
  });
  return { saved: toSave.length, skipped: prepared.records.length - toSave.length };
}

function filterSql(f) {
  const where = [];
  const params = [];
  if (/^\d{4}$/.test(String(f.anio || ''))) {
    params.push(+f.anio);
    where.push(`EXTRACT(YEAR FROM baptism_date) = $${params.length}`);
  }
  if (f.fecha === 'sin') where.push('baptism_date IS NULL');
  for (const [key, op] of [['desde', '>='], ['hasta', '<=']]) {
    const d = parseDate(f[key]);
    if (d) {
      params.push(d);
      where.push(`baptism_date ${op} $${params.length}`);
    }
  }
  if (f.sede) {
    params.push(String(f.sede).slice(0, 80));
    where.push(`sede = $${params.length}`);
  }
  const q = String(f.q || '').trim().slice(0, 80);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(full_name ILIKE $${params.length} OR phone LIKE $${params.length})`);
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

async function list(db, f = {}, limit = 1000) {
  const fl = filterSql(f);
  const { rows } = await db.query(
    `SELECT id, full_name, phone, baptism_date::text AS d, sede, minister, source FROM bautizados${fl.sql}
      ORDER BY baptism_date DESC NULLS LAST, id DESC LIMIT ${Math.min(+limit || 1000, 3000)}`,
    fl.params
  );
  return rows;
}

async function stats(db, year) {
  return (
    await db.query(
      `SELECT count(*)::int AS total, count(phone)::int AS with_phone,
              count(*) FILTER (WHERE EXTRACT(YEAR FROM baptism_date) = $1)::int AS this_year,
              count(*) FILTER (WHERE baptism_date IS NULL)::int AS no_date
         FROM bautizados`,
      [year]
    )
  ).rows[0];
}

async function years(db) {
  return (await db.query('SELECT DISTINCT EXTRACT(YEAR FROM baptism_date)::int AS y FROM bautizados WHERE baptism_date IS NOT NULL ORDER BY y DESC')).rows.map((r) => String(r.y));
}

async function sedes(db) {
  return (await db.query("SELECT DISTINCT sede FROM bautizados WHERE sede <> '' ORDER BY sede")).rows.map((r) => r.sede);
}

async function get(db, id) {
  return (await db.query('SELECT *, baptism_date::text AS d FROM bautizados WHERE id = $1', [id])).rows[0] || null;
}

/** Crea o corrige un registro a mano. Devuelve { id, duplicate } o { errors }. */
async function save(db, id, raw, countryCode = '58', today) {
  const { value: v, errors } = validateRow(raw, countryCode, today);
  if (errors.length) return { errors };
  const params = [v.full_name, v.phone, v.baptism_date, v.sede, v.minister, v.note];
  if (id) {
    const { rowCount } = await db.query(
      'UPDATE bautizados SET full_name=$2, phone=$3, baptism_date=$4, sede=$5, minister=$6, note=$7, updated_at=now() WHERE id=$1',
      [id, ...params]
    );
    return rowCount ? { id } : { errors: ['No existe ese registro.'] };
  }
  // Uno por uno: si ya estaba (mismo teléfono, o mismo nombre y fecha) no se duplica.
  const same = (await db.query('SELECT id, full_name, phone, baptism_date::text AS d FROM bautizados WHERE ($1::text IS NOT NULL AND phone = $1) OR baptism_date IS NOT DISTINCT FROM $2::date', [v.phone, v.baptism_date])).rows
    .find((r) => (v.phone && r.phone === v.phone) || (normName(r.full_name) === normName(v.full_name) && (r.d || null) === (v.baptism_date || null)));
  if (same) return { id: same.id, duplicate: true };
  const { rows } = await db.query(
    "INSERT INTO bautizados (full_name, phone, baptism_date, sede, minister, note, source) VALUES ($1,$2,$3,$4,$5,$6,'Registro manual') RETURNING id",
    params
  );
  return { id: rows[0].id };
}

/**
 * Teléfonos para los bautizados que no lo tienen, tomados de Personas y de Nueva Vida.
 * Solo sugiere: nombre igual o muy parecido (la misma regla que para unir personas; un apellido
 * suelto no basta, y los dos nombres deben tener nombre y apellido). Nunca sugiere un teléfono que ya tenga otro bautizado.
 * Devuelve [{ id, full_name, d, candidates: [{ key, source, name, phone, score }] }], solo los que tienen alguna.
 */
async function phoneSuggestions(db) {
  const missing = (await db.query('SELECT id, full_name, baptism_date::text AS d FROM bautizados WHERE phone IS NULL ORDER BY baptism_date DESC NULLS LAST, full_name')).rows;
  if (!missing.length) return [];
  const used = new Set((await db.query('SELECT phone FROM bautizados WHERE phone IS NOT NULL')).rows.map((r) => r.phone));
  const pool = [
    ...(await db.query('SELECT id, full_name, phone FROM people WHERE phone IS NOT NULL')).rows.map((r) => ({ key: `p:${r.id}`, source: 'Personas', ...r })),
    ...(await db.query('SELECT id, full_name, phone FROM nueva_vida WHERE phone IS NOT NULL')).rows.map((r) => ({ key: `n:${r.id}`, source: 'Nueva Vida', ...r })),
  ].filter((r) => !used.has(r.phone));
  const words = (name) => normName(name).split(' ').filter(Boolean).length;
  const out = [];
  for (const b of missing) {
    if (words(b.full_name) < 2) continue; // un nombre suelto ("Diego") no alcanza para saber quién es
    const seen = new Set();
    const candidates = pool
      .map((r) => ({ key: r.key, source: r.source, name: r.full_name, phone: r.phone, score: nameScore(b.full_name, r.full_name) }))
      .filter((c) => c.score >= THRESHOLD && words(c.name) >= 2)
      .sort((a, c) => c.score - a.score)
      .filter((c) => (seen.has(c.phone) ? false : seen.add(c.phone))) // el mismo teléfono en las dos listas sale una vez
      .slice(0, 4);
    if (candidates.length) out.push({ ...b, candidates });
  }
  return out;
}

/**
 * Guarda los teléfonos elegidos a mano. choices = { [bautizadoId]: candidateKey }.
 * Vuelve a calcular las sugerencias y solo acepta una que siga siendo válida. Deja anotado de dónde salió.
 */
async function applyPhones(pool, choices) {
  const sugg = new Map((await phoneSuggestions(pool)).map((b) => [String(b.id), b]));
  const picks = [];
  for (const [id, key] of Object.entries(choices || {})) {
    const c = sugg.get(String(id))?.candidates.find((x) => x.key === key);
    if (c) picks.push({ id: +id, c });
  }
  const taken = new Set();
  let saved = 0;
  await tx(pool, async (db) => {
    for (const { id, c } of picks) {
      if (taken.has(c.phone)) continue; // dos bautizados no pueden quedar con el mismo teléfono
      const { rowCount } = await db.query(
        `UPDATE bautizados SET phone = $2, updated_at = now(),
                note = trim(both ' ' FROM note || CASE WHEN note = '' THEN '' ELSE ' · ' END || $3)
          WHERE id = $1 AND phone IS NULL`,
        [id, c.phone, `Teléfono tomado de ${c.source} (${c.name}).`]
      );
      if (rowCount) {
        taken.add(c.phone);
        saved++;
      }
    }
  });
  return { saved, ignored: Object.keys(choices || {}).length - saved };
}

async function remove(db, id) {
  await db.query('DELETE FROM bautizados WHERE id = $1', [id]);
}

module.exports = { TEMPLATE_HEADERS, HEADERS, parseDate, validateRow, prepareImport, applyImport, list, stats, years, sedes, get, save, remove, phoneSuggestions, applyPhones };
