'use strict';

/**
 * Calendario general: actividades (eventos, con los REDIL aparte), cumpleaños de las personas y de los líderes.
 * Todo se calcula en el momento a partir de lo que ya existe (events, people.birth_date, care_groups); no guarda nada propio.
 * Un cumpleaños muestra solo día y mes, nunca la edad.
 */
const KINDS = {
  actividad: { label: 'Actividades', icon: '📅' },
  redil: { label: 'REDIL', icon: '📣' },
  lider: { label: 'Cumpleaños de líderes', icon: '⭐' },
  cumple: { label: 'Cumpleaños', icon: '🎂' },
};
const FILTERS = { todo: Object.keys(KINDS), actividades: ['actividad', 'redil'], cumpleanos: ['lider', 'cumple'], lideres: ['lider'] };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => new Date(utc(s) + n * 86400000).toISOString().slice(0, 10);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** 0 = lunes … 6 = domingo */
const weekday = (s) => (new Date(utc(s)).getUTCDay() + 6) % 7;

/** Lunes y domingo de la semana de una fecha. */
function weekRange(today) {
  const mon = addDays(today, -weekday(today));
  return { from: mon, to: addDays(mon, 6) };
}
const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
function monthRange(ym) {
  const y = +ym.slice(0, 4);
  const m = +ym.slice(5, 7);
  return { from: iso(y, m, 1), to: iso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate()) };
}
function shiftMonth(ym, delta) {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Día y mes de una fecha de nacimiento escrita AAAA-MM-DD o DD/MM/AAAA; null si no se entiende. */
function parseBirth(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let d, mo;
  if (m) [mo, d] = [+m[2], +m[3]];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [d, mo] = [+m[1], +m[2]];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { month: mo, day: d };
}

/** La fecha de ese cumpleaños dentro de [from, to] (puede cruzar de año); el 29 de febrero cae el 28 en años no bisiestos. */
function birthdayDates(b, from, to) {
  const out = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
    const day = b.month === 2 && b.day === 29 && !isLeap(y) ? 28 : b.day;
    if (day > new Date(Date.UTC(y, b.month, 0)).getUTCDate()) continue;
    const d = iso(y, b.month, day);
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Todo lo que cae entre from y to (AAAA-MM-DD, inclusive), ordenado por día y hora.
 * Cada elemento: { date, time, kind, title, sub, href }.
 */
async function collect(db, tz, from, to) {
  const items = [];
  const { rows: events } = await db.query(
    `SELECT id, title, event_type, location,
            (starts_at AT TIME ZONE $1)::date::text AS d, to_char(starts_at AT TIME ZONE $1, 'HH24:MI') AS t
       FROM events
      WHERE cancelled = FALSE AND (starts_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
      ORDER BY starts_at`,
    [tz, from, to]
  );
  for (const e of events) {
    items.push({ date: e.d, time: e.t, kind: e.event_type ? 'redil' : 'actividad', title: e.title, sub: [e.event_type, e.location].filter(Boolean).join(' · '), href: `/eventos/${e.id}` });
  }

  // líderes de grupos de cuidado: por teléfono (una persona que es líder y está en Personas cuenta una sola vez)
  const { rows: groups } = await db.query('SELECT name, leader_name, leader_phone, leader_birth_date, co_leader_name, co_leader_birth_date FROM care_groups WHERE active');
  const leaderPhones = new Set(groups.map((g) => g.leader_phone).filter(Boolean));
  const seen = new Set();
  const add = ({ name, phone, birth }, kind, sub, href = '') => {
    const b = parseBirth(birth);
    if (!b || !name) return;
    for (const d of birthdayDates(b, from, to)) {
      const key = `${phone ? `t:${phone}` : `n:${norm(name)}`}|${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ date: d, time: '', kind, title: name, sub, href });
    }
  };
  const { rows: people } = await db.query("SELECT id, full_name, phone, birth_date, role FROM people WHERE active AND birth_date <> ''");
  for (const p of people) {
    const lider = p.phone && leaderPhones.has(p.phone);
    add({ name: p.full_name, phone: p.phone, birth: p.birth_date }, lider ? 'lider' : 'cumple', lider ? 'Líder de grupo de cuidado' : p.role || '', `/personas/${p.id}`);
  }
  // líderes que aún no están en Personas (o con otro teléfono)
  for (const g of groups) {
    add({ name: g.leader_name, phone: g.leader_phone, birth: g.leader_birth_date }, 'lider', `Líder · ${g.name}`);
    add({ name: g.co_leader_name, phone: '', birth: g.co_leader_birth_date }, 'lider', `Líder · ${g.name}`);
  }
  return items.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || KINDS[a.kind].label.localeCompare(KINDS[b.kind].label) || a.title.localeCompare(b.title));
}

const today = (tz) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
/** "viernes 6 de noviembre" */
function dayLabel(s) {
  return `${DAYS[weekday(s)]} ${+s.slice(8, 10)} de ${MONTHS[+s.slice(5, 7) - 1]}`;
}

module.exports = { KINDS, FILTERS, MONTHS, DAYS, weekRange, monthRange, validMonth, shiftMonth, parseBirth, birthdayDates, collect, today, dayLabel, weekday, addDays };
