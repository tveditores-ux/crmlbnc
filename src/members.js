'use strict';
const { normalizePhone, displayPhone } = require('./phone');
const { csvToRecords } = require('./csv');
const { tx } = require('./db');

/** Tipos de persona. '' = por clasificar. */
const TIPOS = { miembro: 'Miembro', amigo: 'Amigo' };
const FILTERS = { todos: 'Todos', miembro: 'Miembros', amigo: 'Amigos', sin: 'Por clasificar' };
const ADMIN_ROLE = 'Admin grupo WhatsApp';

const plain = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

function tipoLabel(m) {
  return TIPOS[m] || 'Por clasificar';
}

/** Valor de la columna `tipo`: '' (sin dato), 'miembro', 'amigo', o null si no se entiende. */
function parseTipo(raw) {
  const t = plain(raw);
  if (!t) return '';
  if (/^miembros?$/.test(t)) return 'miembro';
  if (/^amig[oa]s?$/.test(t)) return 'amigo';
  return null;
}

const isYes = (raw) => /^(si|s|yes|y|true|1|x)$/.test(plain(raw));
const isWhatsAppProfile = (raw) => plain(raw) === 'perfil de whatsapp';
const isNoName = (raw) => {
  const t = plain(raw);
  return !t || t === '(sin nombre)' || t === 'sin nombre';
};

/** Agrega "Admin grupo WhatsApp" al rol sin borrar lo que ya tenía ni repetirlo. */
function addAdminRole(role) {
  const current = String(role || '').trim();
  if (current.split(',').some((r) => plain(r) === plain(ADMIN_ROLE))) return current;
  return current ? `${current}, ${ADMIN_ROLE}` : ADMIN_ROLE;
}

/** Valida una fila del archivo. Devuelve { value, errors }. El teléfono es la clave. */
function validateRow(rec, countryCode = '58') {
  const errors = [];
  const phone = normalizePhone(rec.telefono, countryCode);
  if (!String(rec.telefono || '').trim()) errors.push('Falta el teléfono.');
  else if (!phone) errors.push(`Teléfono no válido: "${rec.telefono}".`);
  const tipo = parseTipo(rec.tipo);
  if (tipo === null) errors.push(`Tipo no válido: "${rec.tipo}" (usa miembro o amigo).`);
  const noName = isNoName(rec.nombre);
  const name = noName ? '' : String(rec.nombre).trim().replace(/\s+/g, ' ');
  if (name.length > 120) errors.push('El nombre es demasiado largo (máximo 120 caracteres).');
  return {
    errors,
    value: {
      phone,
      fullName: noName ? (phone ? displayPhone(phone) : '') : name.slice(0, 120),
      noName,
      whatsappName: !noName && isWhatsAppProfile(rec.origen_del_nombre) ? name.slice(0, 120) : '',
      admin: isYes(rec.admin),
      tipo: tipo === null ? '' : tipo,
    },
  };
}

const MAX_ROWS = 3000;

/**
 * Importa la lista del grupo oficial. El teléfono es la clave: si la persona ya existe se actualiza
 * (sin pisar su nombre, correo ni consentimiento); si no, se crea sin consentimiento.
 * Todo en una transacción. Con dryRun solo revisa.
 */
async function importGroup(pool, text, countryCode = '58', { dryRun = false } = {}) {
  const { records, unknownHeaders } = csvToRecords(text);
  const report = { created: 0, updated: 0, errors: [], unknownHeaders, rows: records.length };
  if (!records.length) {
    report.errors.push({ line: '-', name: '', errors: ['No encontré filas. Revisa que la primera fila tenga los encabezados (Nombre, Teléfono, Admin, Origen del nombre).'] });
    return report;
  }
  if (records.length > MAX_ROWS) {
    report.errors.push({ line: '-', name: '', errors: [`El archivo tiene más de ${MAX_ROWS} filas. Divídelo en partes.`] });
    return report;
  }
  const prepared = [];
  const seen = new Map();
  for (const rec of records) {
    const { value, errors } = validateRow(rec, countryCode);
    if (value.phone) {
      if (seen.has(value.phone)) errors.push(`Repetido con la línea ${seen.get(value.phone)} (mismo teléfono).`);
      else seen.set(value.phone, rec._line);
    }
    if (errors.length) report.errors.push({ line: rec._line, name: String(rec.nombre || ''), errors });
    prepared.push({ line: rec._line, value });
  }
  if (report.errors.length) return report;

  const phones = prepared.map((p) => p.value.phone);
  if (dryRun) {
    const have = new Set((await pool.query('SELECT phone FROM people WHERE phone = ANY($1::text[])', [phones])).rows.map((r) => r.phone));
    for (const p of prepared) (have.has(p.value.phone) ? report.updated++ : report.created++);
    return report;
  }

  await tx(pool, async (db) => {
    for (const { value: v } of prepared) {
      let row = (await db.query('SELECT id, role FROM people WHERE phone = $1 FOR UPDATE', [v.phone])).rows[0];
      if (!row) {
        const ins = await db.query(
          `INSERT INTO people (full_name, phone, role, preferred_channel, opt_in, active, membership, whatsapp_name, in_official_group)
           VALUES ($1, $2, $3, 'whatsapp', FALSE, TRUE, $4, $5, TRUE)
           ON CONFLICT (phone) WHERE phone IS NOT NULL DO NOTHING RETURNING id`,
          [v.fullName, v.phone, v.admin ? ADMIN_ROLE : '', v.tipo, v.whatsappName]
        );
        if (ins.rows[0]) {
          report.created++;
          continue;
        }
        row = (await db.query('SELECT id, role FROM people WHERE phone = $1 FOR UPDATE', [v.phone])).rows[0]; // otra carga la creó justo antes
      }
      // Existente: no se toca el nombre, el correo ni opt_in. El rol solo crece; el tipo solo cambia si el archivo lo trae.
      await db.query(
        `UPDATE people SET in_official_group = TRUE,
                whatsapp_name = CASE WHEN $2 <> '' THEN $2 ELSE whatsapp_name END,
                role = $3,
                membership = CASE WHEN $4 <> '' THEN $4 ELSE membership END,
                updated_at = now()
          WHERE id = $1`,
        [row.id, v.whatsappName, v.admin ? addAdminRole(row.role) : row.role, v.tipo]
      );
      report.updated++;
    }
  });
  return report;
}

/** Cambia el tipo de una persona. Devuelve un mensaje de error o null. */
async function setMembership(db, id, tipo) {
  const t = String(tipo ?? '');
  if (!(t === '' || Object.hasOwn(TIPOS, t))) return 'Tipo no válido.';
  const { rowCount } = await db.query('UPDATE people SET membership = $2, updated_at = now() WHERE id = $1', [id, t]);
  return rowCount ? null : 'No existe esa persona.';
}

/** Marca o desmarca "en el grupo oficial". Devuelve un mensaje de error o null. */
async function setOfficialGroup(db, id, inGroup) {
  const { rowCount } = await db.query('UPDATE people SET in_official_group = $2, updated_at = now() WHERE id = $1', [id, Boolean(inGroup)]);
  return rowCount ? null : 'No existe esa persona.';
}

const GROUP_FILTERS = { todos: 'Todos', si: 'En el grupo oficial', no: 'Fuera del grupo' };

/** Filtros de la lista de Personas, a partir de la URL o de un formulario. Solo valores conocidos. */
function parseView(src = {}) {
  return {
    tipo: Object.hasOwn(FILTERS, src.tipo) ? src.tipo : 'todos',
    grupo: src.grupo === 'si' || src.grupo === 'no' ? src.grupo : 'todos',
    q: String(src.q || '').trim().slice(0, 80),
    m: /^\d{1,9}$/.test(String(src.m || '')) ? +src.m : null,
  };
}

/** La URL que conserva los filtros (sin los que están en su valor por defecto). Nunca copia una URL cruda. */
function viewQuery(v, extra = {}) {
  const p = new URLSearchParams();
  if (v.tipo && v.tipo !== 'todos') p.set('tipo', v.tipo);
  if (v.grupo && v.grupo !== 'todos') p.set('grupo', v.grupo);
  if (v.q) p.set('q', v.q);
  if (v.m) p.set('m', String(v.m));
  for (const [k, x] of Object.entries(extra)) p.set(k, x);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Condiciones para la tabla people (alias p): tipo, grupo oficial, ministerio y búsqueda por nombre, teléfono o correo. */
function filterSql(f) {
  const where = [];
  const params = [];
  if (f.tipo === 'miembro' || f.tipo === 'amigo') {
    params.push(f.tipo);
    where.push(`p.membership = $${params.length}`);
  } else if (f.tipo === 'sin') {
    where.push(`p.membership = ''`);
  }
  if (f.grupo === 'si') where.push('p.in_official_group');
  else if (f.grupo === 'no') where.push('NOT p.in_official_group');
  const min = f.ministry ?? f.m;
  if (/^\d{1,9}$/.test(String(min ?? ''))) {
    params.push(+min);
    where.push(`EXISTS (SELECT 1 FROM person_ministries x WHERE x.person_id = p.id AND x.ministry_id = $${params.length})`);
  }
  const q = String(f.q || '').trim().slice(0, 80);
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const i = params.length;
    // El teléfono se guarda con código de país (58414…); quien busca escribe 0414…, así que se quita el cero inicial.
    const digits = q.replace(/\D/g, '').replace(/^0+/, '');
    let cond = `p.full_name ILIKE $${i} OR p.whatsapp_name ILIKE $${i} OR p.email ILIKE $${i}`;
    if (digits.length >= 3) {
      params.push(`%${digits}%`);
      cond += ` OR p.phone LIKE $${params.length}`;
    }
    where.push(`(${cond})`);
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

async function list(db, f = {}, limit = 1000) {
  const fl = filterSql(f);
  const { rows } = await db.query(
    `SELECT p.id, p.full_name, p.phone, p.membership, p.in_official_group, p.active, p.whatsapp_name
       FROM people p${fl.sql} ORDER BY lower(p.full_name), p.id LIMIT ${Math.min(+limit || 1000, 5000)}`,
    fl.params
  );
  return rows;
}

async function counts(db) {
  const r = (
    await db.query(
      `SELECT count(*)::int AS todos,
              count(*) FILTER (WHERE membership = 'miembro')::int AS miembro,
              count(*) FILTER (WHERE membership = 'amigo')::int AS amigo,
              count(*) FILTER (WHERE membership = '')::int AS sin,
              count(*) FILTER (WHERE in_official_group)::int AS grupo
         FROM people`
    )
  ).rows[0];
  return r;
}

module.exports = {
  TIPOS, FILTERS, GROUP_FILTERS, ADMIN_ROLE, tipoLabel, parseTipo, addAdminRole, validateRow, importGroup, setMembership, setOfficialGroup,
  parseView, viewQuery, list, counts, filterSql,
};
