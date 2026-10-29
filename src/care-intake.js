'use strict';
const { tx } = require('./db');
const cg = require('./care-groups');

const FIELDS = ['leader_name', 'leader_phone', 'leader_email', 'advisor_name', 'congregation', 'address', 'place', 'meeting_day', 'meeting_time', 'stage', 'leader_birth_date'];
const LABELS = {
  leader_name: 'Líder', leader_phone: 'Teléfono', leader_email: 'Correo', advisor_name: 'Líder asesor', congregation: 'Congregación',
  address: 'Dirección', place: 'Lugar', meeting_day: 'Día', meeting_time: 'Hora', stage: 'Etapa', leader_birth_date: 'Nacimiento del líder',
};
const keyOf = (name) => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Enlace común: se crea la primera vez que se pide y se puede regenerar o apagar. */
async function getSettings(db) {
  const { rows } = await db.query("SELECT key, value FROM care_settings WHERE key IN ('intake_token', 'intake_active')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { token: m.intake_token || '', active: m.intake_active !== 'no' };
}
async function ensureToken(db) {
  const cur = await getSettings(db);
  if (cur.token) return cur;
  await db.query("INSERT INTO care_settings (key, value) VALUES ('intake_token', $1) ON CONFLICT (key) DO NOTHING", [cg.newToken()]);
  return getSettings(db);
}
async function regenerateToken(db) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('intake_token', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [cg.newToken()]);
  await db.query("INSERT INTO care_settings (key, value) VALUES ('intake_active', 'si') ON CONFLICT (key) DO UPDATE SET value = 'si'");
}
async function setActive(db, on) {
  await db.query("INSERT INTO care_settings (key, value) VALUES ('intake_active', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [on ? 'si' : 'no']);
}
/** Solo el enlace vigente y encendido abre el formulario. */
async function tokenIsValid(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return false;
  const s = await getSettings(db);
  return s.active && s.token === token;
}

/**
 * Valida el envío del formulario común. El grupo no se elige: se reconoce por el teléfono del líder.
 * Si ese teléfono es de un solo grupo, es ese; si lleva varios, desempatan el nombre que escribió o su congregación;
 * si no hay coincidencia clara, groupId queda en null y la respuesta espera la revisión del panel.
 * Devuelve { value, photo, groupId, newGroupName, errors }.
 */
function parseSubmission(body, groups, countryCode, today) {
  const errors = [];
  const congregation = String(body.congregation ?? '').trim();
  if (!cg.CONGREGATIONS.includes(congregation)) errors.push('Elige tu congregación.');
  const { value, errors: e2 } = cg.parseLeaderProfile({ ...body, congregation, name: 'x' }, countryCode, today);
  errors.push(...e2);
  const photo = cg.parsePhoto(body.photo_data);
  if (photo.error) errors.push(photo.error);
  else if (!photo.buffer) errors.push('Falta la foto del líder.');

  const byPhone = value.leader_phone ? groups.filter((g) => g.leader_phone && g.leader_phone === value.leader_phone) : [];
  let groupId = null;
  if (byPhone.length === 1) {
    groupId = byPhone[0].id;
  } else if (byPhone.length > 1) {
    const byCong = byPhone.filter((g) => g.congregation === congregation);
    if (byCong.length === 1) groupId = byCong[0].id;
  }
  const newGroupName = `${congregation} · ${value.leader_name}`.slice(0, 120);
  return { value, photo, groupId, newGroupName, errors: [...new Set(errors)] };
}

/** Guarda el envío; si el teléfono ya identificó su grupo, lo aplica en el acto. */
async function submit(pool, sub) {
  const v = sub.value;
  const { rows } = await pool.query(
    `INSERT INTO care_group_submissions (group_id, new_group_name, leader_name, leader_phone, leader_email, advisor_name, congregation, address, place, meeting_day, meeting_time, stage, leader_birth_date, photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [sub.groupId, sub.newGroupName, v.leader_name, v.leader_phone, v.leader_email, v.advisor_name, v.congregation, v.address, v.place, v.meeting_day, v.meeting_time, v.stage, v.leader_birth_date, sub.photo.buffer]
  );
  const id = rows[0].id;
  if (sub.groupId) {
    await apply(pool, id, { auto: true });
    return { id, applied: true };
  }
  return { id, applied: false };
}

/**
 * Aplica una respuesta al grupo: solo copia lo que vino lleno (nunca deja un dato en blanco), pone la foto
 * y marca los datos como confirmados. Si era de un grupo nuevo, lo crea. Todo en una transacción.
 * Devuelve { error } si no se puede, o { groupId }.
 */
async function apply(pool, submissionId, { auto = false, groupId: assignTo = null } = {}) {
  return tx(pool, async (db) => {
    const sub = (await db.query("SELECT * FROM care_group_submissions WHERE id = $1 AND status = 'pendiente' FOR UPDATE", [submissionId])).rows[0];
    if (!sub) return { error: 'Esa respuesta ya fue atendida.' };
    let groupId = sub.group_id;
    if (assignTo) {
      if (!(await db.query('SELECT 1 FROM care_groups WHERE id = $1', [assignTo])).rows.length) return { error: 'Ese grupo ya no existe.' };
      groupId = assignTo;
    }
    if (!groupId) {
      const existing = (await db.query('SELECT id, name FROM care_groups')).rows.find((g) => keyOf(g.name) === keyOf(sub.new_group_name));
      if (existing) return { error: `Ya existe un grupo llamado "${existing.name}". Descarta esta respuesta y pídele al líder que lo elija de la lista.` };
      groupId = (
        await db.query('INSERT INTO care_groups (name, token) VALUES ($1, $2) RETURNING id', [sub.new_group_name, cg.newToken()])
      ).rows[0].id;
    }
    const set = FIELDS.filter((f) => sub[f] !== '');
    const sql = `UPDATE care_groups SET ${[...set.map((f, i) => `${f} = $${i + 2}`), 'profile_updated_at = now()'].join(', ')} WHERE id = $1`;
    await db.query(sql, [groupId, ...set.map((f) => sub[f])]);
    if (sub.photo) await cg.savePhoto(db, groupId, Buffer.from(sub.photo));
    await db.query("UPDATE care_group_submissions SET status = 'aplicada', auto_applied = $2, group_id = $3, resolved_at = now(), photo = NULL WHERE id = $1", [submissionId, auto, groupId]);
    return { groupId };
  });
}

async function discard(db, submissionId) {
  const { rowCount } = await db.query("UPDATE care_group_submissions SET status = 'descartada', resolved_at = now(), photo = NULL WHERE id = $1 AND status = 'pendiente'", [submissionId]);
  return rowCount > 0;
}

/** Respuestas por revisar, con el grupo actual para comparar. La foto no se trae, solo si tiene. */
async function listPending(db) {
  const { rows } = await db.query(
    `SELECT s.id, s.group_id, s.new_group_name, s.created_at, ${FIELDS.map((f) => `s.${f}`).join(', ')}, (s.photo IS NOT NULL) AS has_photo,
            g.name AS group_name, ${FIELDS.map((f) => `g.${f} AS cur_${f}`).join(', ')}
       FROM care_group_submissions s LEFT JOIN care_groups g ON g.id = s.group_id
      WHERE s.status = 'pendiente' ORDER BY s.created_at`
  );
  return rows;
}
const countPending = async (db) => (await db.query("SELECT count(*)::int AS n FROM care_group_submissions WHERE status = 'pendiente'")).rows[0].n;

module.exports = { FIELDS, LABELS, getSettings, ensureToken, regenerateToken, setActive, tokenIsValid, parseSubmission, submit, apply, discard, listPending, countPending };
