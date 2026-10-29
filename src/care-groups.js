'use strict';
const crypto = require('crypto');
const { normalizePhone, normalizeEmail } = require('./phone');
const { parseCsv, normalizeHeader } = require('./csv');
const { tx } = require('./db');

const STAGES = ['Equipo', 'Conquista', 'Consolidación', 'Multiplicación'];
const CONGREGATIONS = ['Niños', 'Adolescentes', 'Jóvenes', 'Jóvenes adultos', 'Matrimonios', 'Mujeres', 'Hombres'];
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const COUNTS = ['members_count', 'guests_count', 'attendance'];
const TEXTS = ['snack', 'dynamics', 'testimonies', 'songs', 'key_element', 'notes', 'followup'];
const MAX_TEXT = 2000;

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanLong = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);

/** Datos del grupo desde un formulario. Devuelve { value, errors }. */
function parseGroup(src, countryCode = '58') {
  const errors = [];
  const v = {
    name: clean(src.name, 120),
    leader_name: clean(src.leader_name, 120),
    leader_phone: '',
    leader_email: '',
    advisor_name: clean(src.advisor_name, 120),
    belongs_to: clean(src.belongs_to, 120),
    congregation: clean(src.congregation, 120),
    address: clean(src.address, 250),
    place: clean(src.place, 160),
    meeting_day: DAYS.includes(src.meeting_day) ? src.meeting_day : '',
    meeting_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(src.meeting_time || '')) ? src.meeting_time : '',
    stage: STAGES.includes(src.stage) ? src.stage : '',
  };
  if (!v.name) errors.push('Escribe el nombre del grupo.');
  if (clean(src.leader_phone)) {
    v.leader_phone = normalizePhone(src.leader_phone, countryCode) || '';
    if (!v.leader_phone) errors.push('El teléfono del líder no parece válido.');
  }
  if (clean(src.leader_email)) {
    v.leader_email = normalizeEmail(src.leader_email) || '';
    if (!v.leader_email) errors.push('El correo del líder no parece válido.');
  }
  return { value: v, errors };
}

/** Reporte semanal desde el formulario del teléfono. today = 'YYYY-MM-DD' en la zona de la iglesia. */
function parseReport(src, today) {
  const errors = [];
  const v = { meeting_date: String(src.meeting_date || '').trim(), offering: null, advisor_visit: src.advisor_visit === '1' || src.advisor_visit === 'on' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.meeting_date) || Number.isNaN(Date.parse(`${v.meeting_date}T00:00:00Z`))) {
    errors.push('Elige la fecha de la reunión.');
  } else if (today) {
    const diff = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${v.meeting_date}T00:00:00Z`)) / 86400000;
    if (diff < -1) errors.push('La fecha no puede ser futura.');
    if (diff > 60) errors.push('La fecha es de hace más de 60 días. Para fechas antiguas pídele ayuda a quien administra el panel.');
  }
  for (const k of COUNTS) {
    const raw = String(src[k] ?? '').trim();
    if (raw === '') {
      v[k] = null;
    } else if (!/^\d{1,4}$/.test(raw)) {
      v[k] = null;
      errors.push('Las cifras de personas deben ser números enteros, sin signos.');
    } else {
      v[k] = Number(raw);
    }
  }
  const off = String(src.offering ?? '').trim().replace(',', '.');
  if (off !== '') {
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(off)) errors.push('La ofrenda debe ser un monto, por ejemplo 25.50.');
    else v.offering = Number(off);
  }
  for (const k of TEXTS) v[k] = cleanLong(src[k]);
  if (v.attendance === null && v.members_count === null && v.guests_count === null) {
    errors.push('Escribe al menos cuántos asistieron (miembros, invitados o el total).');
  }
  // Si dieron miembros e invitados pero no el total, se calcula.
  if (v.attendance === null && v.members_count !== null && v.guests_count !== null) v.attendance = v.members_count + v.guests_count;
  return { value: v, errors: [...new Set(errors)] };
}

/** Crea o corrige el reporte de ese grupo y esa fecha (reenviar la misma fecha lo corrige). */
async function upsertReport(db, groupId, v, source = 'telefono') {
  const { rows } = await db.query(
    `INSERT INTO care_group_reports (group_id, meeting_date, members_count, guests_count, attendance, offering, snack, dynamics, testimonies, songs, key_element, notes, followup, advisor_visit, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (group_id, meeting_date) DO UPDATE SET
       members_count = EXCLUDED.members_count, guests_count = EXCLUDED.guests_count, attendance = EXCLUDED.attendance,
       offering = EXCLUDED.offering, snack = EXCLUDED.snack, dynamics = EXCLUDED.dynamics, testimonies = EXCLUDED.testimonies,
       songs = EXCLUDED.songs, key_element = EXCLUDED.key_element, notes = EXCLUDED.notes, followup = EXCLUDED.followup,
       advisor_visit = EXCLUDED.advisor_visit, source = EXCLUDED.source, updated_at = now()
     RETURNING (xmax = 0) AS created`,
    [groupId, v.meeting_date, v.members_count, v.guests_count, v.attendance, v.offering, v.snack, v.dynamics, v.testimonies, v.songs, v.key_element, v.notes, v.followup, v.advisor_visit, source]
  );
  return { created: !!(rows[0] && rows[0].created) };
}

const newToken = () => crypto.randomBytes(16).toString('base64url');

/** Grupos con su último reporte y cuántos reportes tienen en los últimos 30 días. */
async function listGroups(db, today) {
  const { rows } = await db.query(
    `SELECT g.*,
            (SELECT max(meeting_date)::text FROM care_group_reports r WHERE r.group_id = g.id) AS last_report,
            (SELECT count(*)::int FROM care_group_reports r WHERE r.group_id = g.id AND r.meeting_date > ($1::date - 30)) AS reports_30d,
            EXISTS (SELECT 1 FROM care_group_photos p WHERE p.group_id = g.id) AS has_photo
       FROM care_groups g ORDER BY g.active DESC, lower(g.name)`,
    [today]
  );
  return rows;
}

/** Días desde el último reporte (null si nunca reportó). */
function daysSince(lastReport, today) {
  if (!lastReport) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(lastReport).slice(0, 10)}T00:00:00Z`)) / 86400000);
}

const IMPORT_ALIASES = {
  grupo: 'name', nombre: 'name', nombre_del_grupo: 'name', gdc: 'name',
  lider: 'leader_name', lider_del_grupo: 'leader_name',
  telefono: 'leader_phone', telefono_del_lider: 'leader_phone', whatsapp: 'leader_phone', celular: 'leader_phone',
  correo: 'leader_email', email: 'leader_email', correo_del_lider: 'leader_email',
  lider_asesor: 'advisor_name', asesor: 'advisor_name',
  pertenece_a: 'belongs_to', congregacion: 'congregation', direccion: 'address',
  lugar: 'place', dia: 'meeting_day', hora: 'meeting_time', etapa: 'stage',
};
const FIELDS = ['leader_name', 'leader_phone', 'leader_email', 'advisor_name', 'belongs_to', 'congregation', 'address', 'place', 'meeting_day', 'meeting_time', 'stage'];
const keyOf = (name) => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Importa grupos desde un CSV. La clave es el nombre del grupo (sin importar mayúsculas ni acentos):
 * el que ya existe solo recibe los datos que vengan llenos (nunca se borra nada ni se cambia su enlace);
 * el nuevo se crea con su enlace. Si una fila falla, no se guarda ninguna.
 */
async function importGroups(pool, text, countryCode = '58', { dryRun = false } = {}) {
  const rows = parseCsv(text);
  const report = { created: 0, updated: 0, errors: [], unknownHeaders: [] };
  if (!rows.length) return report;
  const keys = rows[0].map((h) => IMPORT_ALIASES[normalizeHeader(h)] || null);
  report.unknownHeaders = rows[0].filter((h, i) => !keys[i] && String(h).trim());
  if (!keys.includes('name')) {
    report.errors.push({ line: 1, name: '', errors: ['Falta la columna "Grupo" (o "Nombre").'] });
    return report;
  }
  const { rows: existing } = await pool.query('SELECT id, name FROM care_groups');
  const byKey = new Map(existing.map((g) => [keyOf(g.name), g.id]));
  const plan = [];
  const seen = new Set();
  rows.slice(1).forEach((cells, i) => {
    const src = {};
    keys.forEach((k, j) => { if (k) src[k] = String(cells[j] || '').trim(); });
    const { value, errors } = parseGroup(src, countryCode);
    const line = i + 2;
    // los valores que no se reconocen (día, etapa, hora) se avisan en vez de perderse en silencio
    if (src.meeting_day && !value.meeting_day) errors.push('El día no es válido (Lunes a Domingo).');
    if (src.stage && !value.stage) errors.push('La etapa no es válida (' + STAGES.join(', ') + ').');
    if (src.meeting_time && !value.meeting_time) errors.push('La hora debe ser como 19:00.');
    const k = keyOf(value.name);
    if (k && seen.has(k)) errors.push('El grupo está repetido en el archivo.');
    seen.add(k);
    if (errors.length) report.errors.push({ line, name: value.name, errors });
    else plan.push({ value, id: byKey.get(k) });
  });
  if (report.errors.length) return report;
  report.created = plan.filter((p) => !p.id).length;
  report.updated = plan.length - report.created;
  if (dryRun) return report;
  await tx(pool, async (db) => {
    for (const { value, id } of plan) {
      if (!id) {
        await db.query(
          'INSERT INTO care_groups (name, leader_name, leader_phone, leader_email, advisor_name, belongs_to, congregation, address, place, meeting_day, meeting_time, stage, token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [value.name, value.leader_name, value.leader_phone, value.leader_email, value.advisor_name, value.belongs_to, value.congregation, value.address, value.place, value.meeting_day, value.meeting_time, value.stage, newToken()]
        );
      } else {
        const set = FIELDS.filter((f) => value[f] !== '');
        if (set.length) await db.query('UPDATE care_groups SET ' + set.map((f, n) => f + ' = $' + (n + 2)).join(', ') + ' WHERE id = $1', [id, ...set.map((f) => value[f])]);
      }
    }
  });
  return report;
}

/* ------------- Datos del líder (fecha de nacimiento y foto) ------------- */
const MAX_PHOTO_BYTES = 1200 * 1024;

/** Fecha 'YYYY-MM-DD' real, no futura y razonable. Devuelve { value, error }; vacío es válido. */
function parseBirthDate(raw, today, who = 'del líder') {
  const v = String(raw ?? '').trim();
  if (!v) return { value: '' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { value: '', error: `La fecha de nacimiento ${who} no es válida.` };
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { value: '', error: `La fecha de nacimiento ${who} no existe.` };
  if (y < 1910 || (today && v > today)) return { value: '', error: `Revisa la fecha de nacimiento ${who}: el año no parece correcto.` };
  return { value: v };
}

/** Datos del formulario "Datos del grupo": lo de parseGroup más nacimiento del líder y de su pareja. */
function parseLeaderProfile(src, countryCode, today) {
  const { value, errors } = parseGroup(src, countryCode);
  const b1 = parseBirthDate(src.leader_birth_date, today, 'del líder');
  const b2 = parseBirthDate(src.co_leader_birth_date, today, 'de la pareja o co-líder');
  if (b1.error) errors.push(b1.error);
  if (b2.error) errors.push(b2.error);
  value.leader_birth_date = b1.value;
  value.co_leader_birth_date = b2.value;
  value.co_leader_name = clean(src.co_leader_name, 120);
  return { value, errors };
}

/** Foto en data URL JPEG (el teléfono la reduce y la reconvierte). Devuelve { buffer } o { error }; vacío = sin foto nueva. */
function parsePhoto(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return { buffer: null };
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return { error: 'No pude leer la foto. Prueba con otra.' };
  const buffer = Buffer.from(m[1], 'base64');
  if (buffer.length < 200 || buffer.length > MAX_PHOTO_BYTES) return { error: 'La foto es demasiado grande o está dañada. Prueba con otra.' };
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) || !(buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9)) {
    return { error: 'La foto no es válida. Prueba con otra.' };
  }
  return { buffer };
}

async function savePhoto(db, groupId, buffer) {
  await db.query(
    `INSERT INTO care_group_photos (group_id, data) VALUES ($1, $2)
     ON CONFLICT (group_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [groupId, buffer]
  );
}

/** Próximos cumpleaños (líder y pareja) dentro de `days` días. today = 'YYYY-MM-DD'. */
function upcomingBirthdays(groups, today, days = 45) {
  const [ty, tm, td] = today.split('-').map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  const out = [];
  const consider = (group, who, iso) => {
    if (!iso) return;
    const [by, bm, bd] = iso.split('-').map(Number);
    for (const year of [ty, ty + 1]) {
      let day = bd;
      if (bm === 2 && bd === 29 && new Date(Date.UTC(year, 1, 29)).getUTCMonth() !== 1) day = 28; // 29 de febrero en año no bisiesto
      const diff = Math.round((Date.UTC(year, bm - 1, day) - t0) / 86400000);
      if (diff < 0) continue;
      if (diff <= days) out.push({ group, who, month: bm, day, turns: year - by, inDays: diff });
      break;
    }
  };
  for (const g of groups) {
    if (!g.active) continue;
    consider(g.name, g.co_leader_name ? g.leader_name : g.leader_name || 'Líder', g.leader_birth_date);
    consider(g.name, g.co_leader_name || `${g.leader_name || 'Líder'} (pareja)`, g.co_leader_birth_date);
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.who.localeCompare(b.who));
}

module.exports = { parseBirthDate, parseLeaderProfile, parsePhoto, savePhoto, upcomingBirthdays, MAX_PHOTO_BYTES, importGroups, STAGES, CONGREGATIONS, DAYS, parseGroup, parseReport, upsertReport, listGroups, daysSince, newToken };
