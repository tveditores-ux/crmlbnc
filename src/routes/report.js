'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const charts = require('../views/charts');
const { esc } = require('../util');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const iso = /^\d{4}-\d{2}-\d{2}$/;

/** Reporte visual: indicadores y gráficas de asistencia y de la comunicación con las personas. */
function reportRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();

  const delta = (now, before) => {
    if (!before) return '';
    const p = Math.round(((now - before) / before) * 100);
    const cls = p > 0 ? 'b-ok' : p < 0 ? 'b-bad' : 'b-muted';
    return `<span class="badge ${cls}" title="Frente al periodo anterior de igual duración">${p > 0 ? '+' : ''}${p}%</span>`;
  };

  r.get(
    '/reporte',
    ah(async (req, res) => {
      const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
      const desde = iso.test(req.query.desde || '') ? req.query.desde : `${todayIso.slice(0, 4)}-01-01`;
      const hasta = iso.test(req.query.hasta || '') ? req.query.hasta : todayIso;
      const sede = String(req.query.sede || '').trim();
      const params = [desde, hasta];
      let where = 'service_date >= $1 AND service_date <= $2';
      if (sede) {
        params.push(sede);
        where += ` AND lower(sede) = lower($${params.length})`;
      }
      const q = (sql, p = params) => db.query(sql, p).then((x) => x.rows);

      // Periodo anterior de la misma duración, para comparar.
      const span = Math.max(1, Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000) + 1);
      const prevParams = [desde, span, ...(sede ? [sede] : [])];
      const prevWhere = `service_date < $1::date AND service_date >= ($1::date - $2::int)${sede ? ' AND lower(sede) = lower($3)' : ''}`;

      const [kpi, prev, weekly, bySede, byHorario, monthly, stages, composition, top, sedes, people] = await Promise.all([
        q(`SELECT count(*)::int AS servicios, round(avg(att_end))::int AS prom, max(att_end)::int AS maximo,
                  coalesce(sum(conversions),0)::int AS conv, coalesce(sum(guests),0)::int AS invitados, round(avg(servers))::int AS servidores
             FROM service_attendance WHERE ${where}`),
        q(`SELECT round(avg(att_end))::int AS prom, coalesce(sum(conversions),0)::int AS conv, coalesce(sum(guests),0)::int AS invitados
             FROM service_attendance WHERE ${prevWhere}`, prevParams),
        q(`SELECT to_char(date_trunc('week', service_date), 'DD/MM') AS label, date_trunc('week', service_date) AS wk, round(avg(att_end))::int AS value
             FROM service_attendance WHERE ${where} AND att_end IS NOT NULL GROUP BY 1, 2 ORDER BY 2`),
        q(`SELECT sede AS label, round(avg(att_end))::int AS value FROM service_attendance WHERE ${where} AND att_end IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
        q(`SELECT horario AS label, round(avg(att_end))::int AS value FROM service_attendance WHERE ${where} AND att_end IS NOT NULL AND horario <> '' GROUP BY 1 ORDER BY 1`),
        q(`SELECT to_char(date_trunc('month', service_date), 'YYYY-MM') AS ym, sum(conversions)::int AS conv, sum(guests)::int AS guests
             FROM service_attendance WHERE ${where} GROUP BY 1 ORDER BY 1`),
        q(`SELECT round(avg(att_start))::int AS inicio, round(avg(att_mid))::int AS medio, round(avg(att_end))::int AS final FROM service_attendance WHERE ${where}`),
        q(`SELECT round(avg(servers),1)::float AS servidores, round(avg(pastors),1)::float AS pastores, round(avg(kids),1)::float AS ninos,
                  round(avg(preteens),1)::float AS preadolescentes, round(avg(teens),1)::float AS adolescentes FROM service_attendance WHERE ${where}`),
        q(`SELECT to_char(service_date, 'DD/MM/YY') || ' · ' || sede || ' ' || horario AS label, att_end AS value
             FROM service_attendance WHERE ${where} AND att_end IS NOT NULL ORDER BY att_end DESC, service_date DESC LIMIT 10`),
        q('SELECT DISTINCT sede FROM service_attendance ORDER BY sede', []),
        q(`SELECT count(*)::int AS total, count(phone)::int AS phone, count(email)::int AS email, count(*) FILTER (WHERE opt_in)::int AS optin
             FROM people WHERE active`, []),
      ]);

      const k = kpi[0];
      const p0 = prev[0] || {};
      const st = stages[0] || {};
      const cmp = composition[0] || {};
      const peak = k.maximo
        ? (await q(`SELECT to_char(service_date, 'DD/MM/YYYY') AS d, sede, horario FROM service_attendance WHERE ${where} AND att_end = $${params.length + 1} ORDER BY service_date DESC LIMIT 1`, [...params, k.maximo]))[0]
        : null;
      const card = (value, label, extra = '') => `<div class="card"><div class="stat">${value ?? '—'}</div><div class="stat-label">${label} ${extra}</div></div>`;

      const body = `<h1>Reporte</h1>
        <p class="sub">Asistencia a los servicios y comunicación con las personas. Periodo: ${esc(desde)} al ${esc(hasta)}${sede ? ` · ${esc(sede)}` : ''}.</p>
        <form class="toolbar no-print" method="get">
          <div><label>Sede</label><select name="sede"><option value="">Todas</option>${sedes
            .map((s) => `<option ${sede === s.sede ? 'selected' : ''}>${esc(s.sede)}</option>`)
            .join('')}</select></div>
          <div><label>Desde</label><input type="date" name="desde" value="${esc(desde)}"></div>
          <div><label>Hasta</label><input type="date" name="hasta" value="${esc(hasta)}"></div>
          <button class="sec">Actualizar</button>
          <button type="button" onclick="window.print()">Imprimir o guardar PDF</button></form>
        <div class="grid">
          ${card(k.servicios, 'servicios registrados')}
          ${card(k.prom, 'asistencia promedio al final', delta(k.prom, p0.prom))}
          ${card(k.maximo, 'asistencia máxima', peak ? `<div class="muted" style="font-size:12px">${esc(peak.d)} · ${esc(peak.sede)} ${esc(peak.horario)}</div>` : '')}
          ${card(k.conv, 'conversiones', delta(k.conv, p0.conv))}
          ${card(k.invitados, 'invitados', delta(k.invitados, p0.invitados))}
          ${card(k.servidores, 'servidores por servicio (promedio)')}
        </div>
        <div class="charts">
          <div class="card wide"><h3>Asistencia promedio por semana</h3>${charts.lineChart(weekly.map((w) => w.label), [{ name: 'Promedio al final', values: weekly.map((w) => w.value) }], { title: 'Asistencia promedio al final por semana' })}</div>
          <div class="card"><h3>Promedio por sede</h3>${charts.hBarChart(bySede, { title: 'Asistencia promedio al final por sede' })}</div>
          <div class="card"><h3>Promedio por horario</h3>${charts.barChart(byHorario, { title: 'Asistencia promedio al final por horario', color: '#6b5b95' })}</div>
          <div class="card"><h3>Cómo crece la asistencia en el servicio</h3>${charts.barChart(
            [{ label: 'Inicio', value: st.inicio }, { label: 'Medio', value: st.medio }, { label: 'Final', value: st.final }],
            { title: 'Asistencia promedio al inicio, en medio y al final', color: '#2f5d62' }
          )}</div>
          <div class="card"><h3>Quiénes asisten (promedio por servicio)</h3>${charts.hBarChart(
            [
              { label: 'Servidores', value: cmp.servidores },
              { label: 'Niños', value: cmp.ninos },
              { label: 'Adolescentes', value: cmp.adolescentes },
              { label: 'Pastores', value: cmp.pastores },
              { label: 'Preadolescentes', value: cmp.preadolescentes },
            ],
            { title: 'Promedio de servidores, niños, adolescentes, pastores y preadolescentes por servicio' }
          )}</div>
          <div class="card"><h3>Conversiones por mes</h3>${charts.barChart(monthly.map((m) => ({ label: charts.monthLabel(m.ym), value: m.conv })), { title: 'Conversiones por mes', color: '#2f6b4f' })}</div>
          <div class="card"><h3>Invitados por mes</h3>${charts.barChart(monthly.map((m) => ({ label: charts.monthLabel(m.ym), value: m.guests })), { title: 'Invitados por mes', color: '#b4642a' })}</div>
          <div class="card wide"><h3>Los 10 servicios con más asistencia</h3>${charts.hBarChart(top, { title: 'Los diez servicios con más asistencia al final', color: '#8a3b2e' })}</div>
          <div class="card"><h3>Quién aceptó recibir mensajes</h3>${charts.donut(
            [{ label: 'Aceptaron', value: people[0].optin, color: '#2f6b4f' }, { label: 'Sin aceptar', value: people[0].total - people[0].optin, color: '#b4642a' }],
            { title: 'Personas activas que aceptaron recibir mensajes' }
          )}</div>
          <div class="card"><h3>Datos de contacto (personas activas)</h3>${charts.hBarChart(
            [{ label: 'Con WhatsApp', value: people[0].phone }, { label: 'Con correo', value: people[0].email }, { label: 'Total activas', value: people[0].total }],
            { title: 'Personas activas con WhatsApp, con correo y total' }
          )}</div>
        </div>
        <p class="muted" style="font-size:12px">Las comparaciones se hacen contra el periodo anterior de igual duración. Los promedios usan solo los servicios que tienen la cifra registrada.</p>`;
      res.send(layout({ title: 'Reporte', active: '/reporte', body, config, query: req.query }));
    })
  );

  return r;
}

module.exports = { reportRouter };
