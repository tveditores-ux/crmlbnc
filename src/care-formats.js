'use strict';
const { tx } = require('./db');
const { STAGES } = require('./care-groups');

/** Hitos de la ruta de desarrollo, tal como aparecen en el libro (Formato 04). */
const MILESTONES = ['NV', 'B', 'tPE', 'VL', '2D', 'DRT', 'dLC', 'LCa', 'CC'];
const MAX_PEOPLE = 80;

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanLong = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
const keyOf = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------ Trimestres ------------------------------ */
function quarterOf(iso) {
  const [y, m] = String(iso).slice(0, 10).split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}
const validQuarter = (q) => /^\d{4}-Q[1-4]$/.test(String(q || ''));
function quarterBounds(q) {
  const y = +q.slice(0, 4);
  const n = +q.slice(6);
  const next = n === 4 ? `${y + 1}-01-01` : `${y}-${pad(n * 3 + 1)}-01`;
  return { start: `${y}-${pad((n - 1) * 3 + 1)}-01`, end: next };
}
const quarterLabel = (q) => `${q.slice(6)}.º trimestre de ${q.slice(0, 4)}`;
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** Reporte trimestral: 13 semanas contadas desde el inicio del trimestre, con totales y promedios. */
async function quarterly(db, groupId, q) {
  const { start, end } = quarterBounds(q);
  const { rows } = await db.query(
    `SELECT meeting_date::text AS d, attendance, guests_count, offering FROM care_group_reports
      WHERE group_id = $1 AND meeting_date >= $2 AND meeting_date < $3 ORDER BY meeting_date`,
    [groupId, start, end]
  );
  const weeks = Array.from({ length: 13 }, (_, i) => ({ n: i + 1, offering: null, guests: null, attendance: null }));
  const add = (cur, v) => (v === null || v === undefined ? cur : (cur ?? 0) + Number(v));
  for (const r of rows) {
    const w = weeks[Math.min(12, Math.floor(dayDiff(r.d, start) / 7))];
    w.offering = add(w.offering, r.offering);
    w.guests = add(w.guests, r.guests_count);
    w.attendance = add(w.attendance, r.attendance);
  }
  const avg = (key) => {
    const vals = weeks.map((w) => w[key]).filter((v) => v !== null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };
  return {
    quarter: q,
    start,
    end,
    weeks,
    reports: rows.length,
    offeringTotal: weeks.reduce((a, w) => a + (w.offering ?? 0), 0),
    guestsAvg: avg('guests'),
    attendanceAvg: avg('attendance'),
  };
}

/* ----------------------------- Ruta de desarrollo ----------------------------- */
/** Lista de personas desde el formulario (filas n_0, m_0 (varios), o_0...). Repetidos por nombre se juntan. */
function parsePeople(body) {
  const byKey = new Map();
  for (let i = 0; i < MAX_PEOPLE; i++) {
    const name = clean(body[`n_${i}`], 120);
    if (!name) continue;
    const ms = [].concat(body[`m_${i}`] || []).filter((m) => MILESTONES.includes(m));
    const other = clean(body[`o_${i}`], 160);
    const k = keyOf(name);
    const prev = byKey.get(k);
    if (prev) {
      prev.milestones = [...new Set([...prev.milestones, ...ms])];
      prev.other = prev.other || other;
    } else {
      byKey.set(k, { name, milestones: [...new Set(ms)], other });
    }
  }
  return [...byKey.values()].map((p) => ({ ...p, milestones: MILESTONES.filter((m) => p.milestones.includes(m)) }));
}

/** Reemplaza la lista del grupo en una sola transacción. Una lista vacía no borra a quien ya estaba. */
async function savePeople(pool, groupId, list) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM care_group_people WHERE group_id = $1', [groupId]);
  if (!list.length && rows[0].n) return { error: 'La lista quedó vacía y no se guardó, para no borrar a todos por error.' };
  await tx(pool, async (db) => {
    await db.query('DELETE FROM care_group_people WHERE group_id = $1', [groupId]);
    for (const [i, p] of list.entries()) {
      await db.query('INSERT INTO care_group_people (group_id, name, milestones, other, sort) VALUES ($1,$2,$3,$4,$5)', [groupId, p.name, p.milestones, p.other, i]);
    }
  });
  return { saved: list.length };
}

const listPeople = async (db, groupId) => (await db.query('SELECT * FROM care_group_people WHERE group_id = $1 ORDER BY sort, id', [groupId])).rows;

/* ---------------------------- Planificador mensual ---------------------------- */
const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

function parsePlan(body) {
  const errors = [];
  const month = String(body.month || '').trim();
  if (!validMonth(month)) errors.push('Elige el mes.');
  const weeks = [1, 2, 3, 4].map((w) => ({
    snack: clean(body[`snack_${w}`], 300),
    dynamics: cleanLong(body[`dynamics_${w}`]),
    key_element: cleanLong(body[`key_element_${w}`]),
    support: cleanLong(body[`support_${w}`]),
  }));
  if (!weeks.some((w) => w.snack || w.dynamics || w.key_element || w.support)) errors.push('Escribe algo en al menos una semana.');
  return { value: { month, stage: STAGES.includes(body.stage) ? body.stage : '', weeks }, errors };
}

async function upsertPlan(db, groupId, v) {
  await db.query(
    `INSERT INTO care_group_plans (group_id, month, stage, weeks) VALUES ($1,$2,$3,$4)
     ON CONFLICT (group_id, month) DO UPDATE SET stage = EXCLUDED.stage, weeks = EXCLUDED.weeks, updated_at = now()`,
    [groupId, v.month, v.stage, JSON.stringify(v.weeks)]
  );
}

async function getPlan(db, groupId, month) {
  const { rows } = await db.query('SELECT * FROM care_group_plans WHERE group_id = $1 AND month = $2', [groupId, month]);
  return rows[0] || null;
}

/* ----------------------------------- F.O.D.A. ----------------------------------- */
function parseFoda(body) {
  const errors = [];
  const quarter = String(body.quarter || '').trim();
  if (!validQuarter(quarter)) errors.push('Elige el trimestre.');
  const v = { quarter, strengths: cleanLong(body.strengths), opportunities: cleanLong(body.opportunities), weaknesses: cleanLong(body.weaknesses), threats: cleanLong(body.threats) };
  if (!v.strengths && !v.opportunities && !v.weaknesses && !v.threats) errors.push('Escribe algo en al menos un recuadro.');
  return { value: v, errors };
}

async function upsertFoda(db, groupId, v) {
  await db.query(
    `INSERT INTO care_group_foda (group_id, quarter, strengths, opportunities, weaknesses, threats) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (group_id, quarter) DO UPDATE SET strengths = EXCLUDED.strengths, opportunities = EXCLUDED.opportunities,
       weaknesses = EXCLUDED.weaknesses, threats = EXCLUDED.threats, updated_at = now()`,
    [groupId, v.quarter, v.strengths, v.opportunities, v.weaknesses, v.threats]
  );
}

async function getFoda(db, groupId, quarter) {
  const { rows } = await db.query('SELECT * FROM care_group_foda WHERE group_id = $1 AND quarter = $2', [groupId, quarter]);
  return rows[0] || null;
}

module.exports = {
  MILESTONES, MAX_PEOPLE, quarterOf, validQuarter, quarterBounds, quarterLabel, quarterly,
  parsePeople, savePeople, listPeople, validMonth, parsePlan, upsertPlan, getPlan, parseFoda, upsertFoda, getFoda,
};
