'use strict';

/**
 * Presentación de niños: registro de los niños presentados al Señor, como Bautizados pero de niños.
 * Lista independiente (sin FK a people): registrar aquí no crea personas ni toca opt_in.
 */

const SEDES = ['Las Mercedes', 'Nuarito'];

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

module.exports = { SEDES, parseDate, validateRow, add, list, stats, remove };
