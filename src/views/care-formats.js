'use strict';
const { esc } = require('../util');
const charts = require('./charts');
const f = require('../care-formats');

const money = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cell = (v) => (v === null || v === undefined ? '—' : esc(v));
const monthName = (m) => {
  const names = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${names[+m.slice(5) - 1]} de ${m.slice(0, 4)}`;
};

/** Reporte trimestral (Formato 05): ofrendas, visitantes y asistencia por semana, más totales y promedios. */
function quarterlyView(t) {
  const col = (title, key, fmt, footLabel, footValue) => `<div class="card"><strong>${title}</strong>
    <div class="table-scroll"><table><tr><th>Semana</th><th>${key === 'offering' ? 'Monto' : 'Nº'}</th></tr>
    ${t.weeks.map((w) => `<tr><td>${w.n}</td><td>${fmt(w[key])}</td></tr>`).join('')}
    <tr><th>${footLabel}</th><th>${footValue}</th></tr></table></div></div>`;
  return `<div class="grid">
      ${col('Ofrendas', 'offering', money, 'Total', money(t.offeringTotal))}
      ${col('Visitantes', 'guests', cell, 'Promedio', cell(t.guestsAvg))}
      ${col('Asistencia', 'attendance', cell, 'Promedio', cell(t.attendanceAvg))}
    </div>
    <p class="muted" style="font-size:13px">Se calcula con los reportes semanales (${t.reports} en este trimestre). Las semanas se cuentan desde el ${esc(t.start.split('-').reverse().join('/'))}. Los promedios solo toman las semanas con reporte.</p>
    ${t.reports > 1 ? `<div class="card"><h3>Asistencia y visitantes por semana</h3>${charts.lineChart(
      t.weeks.map((w) => String(w.n)),
      [{ name: 'Asistencia', values: t.weeks.map((w) => w.attendance) }, { name: 'Visitantes', values: t.weeks.map((w) => w.guests) }],
      { title: 'Asistencia y visitantes por semana del trimestre' }
    )}</div>` : ''}`;
}

/** Ruta de desarrollo (Formato 04): matriz de personas por hito. */
function milestoneMatrix(people) {
  if (!people.length) return '<p class="muted">Todavía no hay personas en la ruta de desarrollo.</p>';
  return `<div class="table-scroll"><table><tr><th>Nombre</th>${f.MILESTONES.map((m) => `<th style="text-align:center">${esc(m)}</th>`).join('')}<th>Otros</th></tr>
    ${people
      .map(
        (p) => `<tr><td>${esc(p.name)}</td>${f.MILESTONES.map((m) => `<td style="text-align:center">${p.milestones.includes(m) ? '✓' : ''}</td>`).join('')}<td>${esc(p.other)}</td></tr>`
      )
      .join('')}</table></div>`;
}

/** Cuántas personas llevan cada hito, para la gráfica. */
function milestoneCounts(people) {
  return f.MILESTONES.map((m) => ({ label: m, value: people.filter((p) => p.milestones.includes(m)).length }));
}

/** Planificador mensual (Formato 03), solo lectura. */
function planView(plan) {
  if (!plan) return '<p class="muted">Este mes todavía no tiene plan.</p>';
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : [];
  return `<p><strong>${esc(monthName(plan.month))}</strong>${plan.stage ? ` · Etapa: ${esc(plan.stage)}` : ''}</p>
    <div class="grid">${weeks
      .map(
        (w, i) => `<div class="card"><strong>Semana ${i + 1}</strong>
        ${[['Refrigerio', w.snack], ['Dinámicas', w.dynamics], ['Elemento clave', w.key_element], ['Apoyo', w.support]]
          .map(([l, v]) => `<div style="margin-top:6px"><span class="muted">${l}</span><div style="white-space:pre-wrap">${v ? esc(v) : '—'}</div></div>`)
          .join('')}</div>`
      )
      .join('')}</div>`;
}

/** F.O.D.A. (Formato 06), solo lectura. */
function fodaView(foda) {
  if (!foda) return '<p class="muted">Este trimestre todavía no tiene análisis F.O.D.A.</p>';
  const box = (t, v) => `<div class="card"><strong>${t}</strong><div style="white-space:pre-wrap;margin-top:6px">${v ? esc(v) : '<span class="muted">—</span>'}</div></div>`;
  return `<div class="grid">${box('Fortalezas', foda.strengths)}${box('Oportunidades', foda.opportunities)}${box('Debilidades', foda.weaknesses)}${box('Amenazas', foda.threats)}</div>`;
}

/** Selector de trimestres (el actual y los 3 anteriores), como enlaces. */
function quarterOptions(current) {
  const out = [];
  let [y, n] = [+current.slice(0, 4), +current.slice(6)];
  for (let i = 0; i < 4; i++) {
    out.push(`${y}-Q${n}`);
    n -= 1;
    if (n === 0) [y, n] = [y - 1, 4];
  }
  return out;
}

module.exports = { quarterlyView, milestoneMatrix, milestoneCounts, planView, fodaView, quarterOptions, monthName, money };
