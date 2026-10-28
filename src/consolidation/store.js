'use strict';
const { STAGES, STAGE_BY_KEY, STATUSES, LOST_REASONS, CALL_RESULTS } = require('./stages');
const { nameScore, THRESHOLD } = require('./match');

/** Columnas de fecha de cada etapa, para contar cuántas personas llegaron a ella. */
const STAGE_FIELDS = STAGES.map((s) => s.date);

/** Responsables posibles: las personas del ministerio Nueva Vida. */
async function nuevaVidaPeople(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT p.id, p.full_name FROM people p
       JOIN person_ministries pm ON pm.person_id = p.id
       JOIN ministries m ON m.id = pm.ministry_id
      WHERE lower(m.name) = 'nueva vida' AND p.active ORDER BY p.full_name`
  );
  return rows;
}

/** Busca al responsable por nombre dentro de Nueva Vida. Devuelve el id o null. */
function matchResponsible(name, volunteers) {
  const n = String(name || '').trim();
  if (!n) return null;
  let best = null;
  for (const v of volunteers) {
    const s = nameScore(n, v.full_name);
    if (s >= THRESHOLD && (!best || s > best.s)) best = { id: v.id, s };
  }
  return best ? best.id : null;
}

/** Crea o completa la consolidación de una persona. En una fila ya existente solo llena lo que esté vacío. */
async function upsertConsolidation(db, personId, v) {
  const { rows } = await db.query(
    `INSERT INTO consolidation (person_id, decision_date, sede, invited_by, assigned_to, call_date, meeting_date,
                                pp_start_date, pp_end_date, baptism_date, group_date, group_name, riel_date,
                                status, lost_reason, status_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$2)
     ON CONFLICT (person_id) DO UPDATE SET
       sede = CASE WHEN consolidation.sede = '' THEN EXCLUDED.sede ELSE consolidation.sede END,
       invited_by = CASE WHEN consolidation.invited_by = '' THEN EXCLUDED.invited_by ELSE consolidation.invited_by END,
       assigned_to = COALESCE(consolidation.assigned_to, EXCLUDED.assigned_to),
       call_date = COALESCE(consolidation.call_date, EXCLUDED.call_date),
       meeting_date = COALESCE(consolidation.meeting_date, EXCLUDED.meeting_date),
       pp_start_date = COALESCE(consolidation.pp_start_date, EXCLUDED.pp_start_date),
       pp_end_date = COALESCE(consolidation.pp_end_date, EXCLUDED.pp_end_date),
       baptism_date = COALESCE(consolidation.baptism_date, EXCLUDED.baptism_date),
       group_date = COALESCE(consolidation.group_date, EXCLUDED.group_date),
       group_name = CASE WHEN consolidation.group_name = '' THEN EXCLUDED.group_name ELSE consolidation.group_name END,
       riel_date = COALESCE(consolidation.riel_date, EXCLUDED.riel_date),
       updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [
      personId, v.decision_date, v.sede || '', v.invited_by || '', v.assigned_to || null, v.call_date || null, v.meeting_date || null,
      v.pp_start_date || null, v.pp_end_date || null, v.baptism_date || null, v.group_date || null, v.group_name || '', v.riel_date || null,
      v.status && STATUSES[v.status] ? v.status : 'activo', v.status === 'perdido' ? v.lost_reason || null : null,
    ]
  );
  if (rows[0].created) {
    const st = v.status && STATUSES[v.status] ? v.status : 'activo';
    await db.query(`INSERT INTO consolidation_status_log (consolidation_id, status, reason, changed_on) VALUES ($1,'activo',NULL,$2)`, [rows[0].id, v.decision_date]);
    if (st !== 'activo') {
      await db.query(`INSERT INTO consolidation_status_log (consolidation_id, status, reason, changed_on) VALUES ($1,$2,$3,current_date)`, [rows[0].id, st, st === 'perdido' ? v.lost_reason : null]);
    }
  }
  return { id: rows[0].id, created: rows[0].created };
}

/** Marca una etapa con su fecha y responsable. La fecha no puede ser anterior a la decisión ni futura. */
async function setStage(db, id, stageKey, date, byId, extra = {}) {
  const stage = STAGE_BY_KEY[stageKey];
  if (!stage || !stage.by) return 'Etapa no válida.';
  const { rows } = await db.query('SELECT decision_date::text AS d FROM consolidation WHERE id = $1', [id]);
  if (!rows[0]) return 'No existe esa consolidación.';
  if (date < rows[0].d) return 'La fecha no puede ser anterior a la decisión.';
  const today = (await db.query("SELECT current_date::text AS d")).rows[0].d;
  if (date > today) return 'La fecha no puede ser futura.';
  const params = [id, date, byId || null];
  let groupSet = '';
  if (stageKey === 'grupo') {
    params.push(String(extra.groupName || '').slice(0, 120));
    groupSet = ', group_name = $4';
  }
  await db.query(`UPDATE consolidation SET ${stage.date} = $2, ${stage.by} = $3${groupSet}, updated_at = now() WHERE id = $1`, params);
  return null;
}

/** Quita la fecha de una etapa (por si se marcó por error). */
async function clearStage(db, id, stageKey) {
  const stage = STAGE_BY_KEY[stageKey];
  if (!stage || !stage.by) return 'Etapa no válida.';
  await db.query(`UPDATE consolidation SET ${stage.date} = NULL, ${stage.by} = NULL, updated_at = now() WHERE id = $1`, [id]);
  return null;
}

/** Cambia el estado general y deja el cambio en el historial. "Perdida" exige un motivo. */
async function setStatus(db, id, status, reason, date) {
  if (!STATUSES[status]) return 'Estado no válido.';
  if (status === 'perdido' && !LOST_REASONS[reason]) return 'Elige el motivo por el que se perdió.';
  const { rows } = await db.query('SELECT decision_date::text AS d FROM consolidation WHERE id = $1', [id]);
  if (!rows[0]) return 'No existe esa consolidación.';
  const when = date || (await db.query('SELECT current_date::text AS d')).rows[0].d;
  if (when < rows[0].d) return 'La fecha no puede ser anterior a la decisión.';
  await db.query(
    `UPDATE consolidation SET status = $2, lost_reason = $3, status_since = $4, updated_at = now() WHERE id = $1`,
    [id, status, status === 'perdido' ? reason : null, when]
  );
  await db.query(`INSERT INTO consolidation_status_log (consolidation_id, status, reason, changed_on) VALUES ($1,$2,$3,$4)`, [id, status, status === 'perdido' ? reason : null, when]);
  return null;
}

/** Anota una llamada. Si contestó y la etapa "Llamada" estaba vacía, la marca. "No llamar" la saca de las listas de llamadas. */
async function logCall(db, id, { calledBy, result, note }) {
  if (!CALL_RESULTS[result]) return 'Resultado no válido.';
  const { rows } = await db.query('SELECT id, call_date FROM consolidation WHERE id = $1', [id]);
  if (!rows[0]) return 'No existe esa consolidación.';
  await db.query(`INSERT INTO consolidation_calls (consolidation_id, called_by, result, note) VALUES ($1,$2,$3,$4)`, [id, calledBy || null, result, String(note || '').slice(0, 1000)]);
  if (result === 'contesto' && !rows[0].call_date) {
    await db.query(`UPDATE consolidation SET call_date = current_date, call_by = $2, updated_at = now() WHERE id = $1 AND call_date IS NULL`, [id, calledBy || null]);
  }
  if (result === 'no_llamar') await db.query('UPDATE consolidation SET do_not_call = TRUE, updated_at = now() WHERE id = $1', [id]);
  return null;
}

function filterSql(f, startIdx = 1) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace('?', `$${startIdx + params.length - 1}`));
  };
  if (f.sede) add('lower(c.sede) = lower(?)', f.sede);
  if (f.status && STATUSES[f.status]) add('c.status = ?', f.status);
  if (/^\d+$/.test(String(f.responsable || ''))) add('c.assigned_to = ?', +f.responsable);
  if (/^\d{4}-\d{2}$/.test(String(f.mes || ''))) add("to_char(c.decision_date, 'YYYY-MM') = ?", f.mes);
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

/** Cuántas personas llegaron a cada etapa. */
async function funnel(db, f = {}) {
  const fl = filterSql(f);
  const counts = STAGE_FIELDS.map((c, i) => `count(c.${c})::int AS s${i}`).join(', ');
  const { rows } = await db.query(`SELECT count(*)::int AS total, ${counts} FROM consolidation c${fl.sql}`, fl.params);
  return STAGES.map((s, i) => ({ key: s.key, label: s.label, count: rows[0][`s${i}`] }));
}

/** Lista de personas en consolidación, con la persona y el responsable. */
async function list(db, f = {}, limit = 500) {
  const fl = filterSql(f);
  const { rows } = await db.query(
    `SELECT c.*, c.decision_date::text AS decision_iso, p.full_name, p.phone, r.full_name AS responsible_name,
            (current_date - c.decision_date)::int AS days
       FROM consolidation c JOIN people p ON p.id = c.person_id LEFT JOIN people r ON r.id = c.assigned_to${fl.sql}
      ORDER BY c.decision_date DESC, p.full_name LIMIT ${Math.min(+limit || 500, 2000)}`,
    fl.params
  );
  return rows;
}

/** Una consolidación con los datos de la persona y los nombres de los responsables de cada etapa. */
async function get(db, id) {
  const { rows } = await db.query(
    `SELECT c.*, c.decision_date::text AS decision_iso, c.last_seen_date::text AS seen_iso,
            p.full_name, p.phone, p.opt_in, r.full_name AS responsible_name,
            (current_date - c.decision_date)::int AS days,
            ${STAGES.filter((s) => s.by)
              .map((s) => `(SELECT full_name FROM people WHERE id = c.${s.by}) AS ${s.by}_name, c.${s.date}::text AS ${s.date}_iso`)
              .join(', ')}
       FROM consolidation c JOIN people p ON p.id = c.person_id LEFT JOIN people r ON r.id = c.assigned_to WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function callsOf(db, id) {
  return (
    await db.query(
      `SELECT k.id, k.result, k.note, k.called_at, p.full_name AS by_name
         FROM consolidation_calls k LEFT JOIN people p ON p.id = k.called_by WHERE k.consolidation_id = $1 ORDER BY k.called_at DESC, k.id DESC`,
      [id]
    )
  ).rows;
}

async function statusLogOf(db, id) {
  return (await db.query(`SELECT status, reason, changed_on::text AS d FROM consolidation_status_log WHERE consolidation_id = $1 ORDER BY changed_on DESC, id DESC`, [id])).rows;
}

/** Datos generales editables. La decisión no puede quedar después de una etapa ya marcada. */
async function updateData(db, id, { decisionDate, sede, invitedBy, assignedTo, lastSeen }) {
  const cols = STAGES.filter((s) => s.by).map((s) => `${s.date}::text AS ${s.date}`).join(', ');
  const c = (await db.query(`SELECT ${cols} FROM consolidation WHERE id = $1`, [id])).rows[0];
  if (!c) return 'No existe esa consolidación.';
  if (decisionDate) {
    for (const s of STAGES.filter((x) => x.by)) {
      const d = c[s.date];
      if (d && decisionDate > d) return `La decisión no puede ser después de «${s.label}» (${d}).`;
    }
  }
  await db.query(
    `UPDATE consolidation SET decision_date = COALESCE($2::date, decision_date), sede = $3, invited_by = $4, assigned_to = $5,
            last_seen_date = $6, updated_at = now() WHERE id = $1`,
    [id, decisionDate || null, String(sede || '').trim().slice(0, 80), String(invitedBy || '').trim().slice(0, 120), assignedTo || null, lastSeen || null]
  );
  return null;
}

async function remove(db, id) {
  await db.query('DELETE FROM consolidation WHERE id = $1', [id]);
}

/** Valores para los filtros del tablero. */
async function filterOptions(db) {
  const sedes = (await db.query(`SELECT DISTINCT sede FROM consolidation WHERE sede <> '' ORDER BY sede`)).rows.map((r) => r.sede);
  const months = (await db.query(`SELECT DISTINCT to_char(decision_date, 'YYYY-MM') AS m FROM consolidation ORDER BY m DESC`)).rows.map((r) => r.m);
  const responsibles = (
    await db.query(`SELECT DISTINCT p.id, p.full_name FROM consolidation c JOIN people p ON p.id = c.assigned_to ORDER BY p.full_name`)
  ).rows;
  return { sedes, months, responsibles };
}

module.exports = { nuevaVidaPeople, matchResponsible, upsertConsolidation, setStage, clearStage, setStatus, logCall, funnel, list, filterSql, get, callsOf, statusLogOf, updateData, remove, filterOptions };
