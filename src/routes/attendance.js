'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { toCsv } = require('../csv');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SEDES = ['Agua Viva', 'Las Mercedes', 'Nuarito'];
const DAYS = ['Domingo', 'Martes', 'Miércoles', 'Otro'];
const COUNT_FIELDS = [
  ['att_start', 'Asistencia al inicio'],
  ['att_mid', 'Asistencia en el intermedio'],
  ['att_end', 'Asistencia al final'],
  ['guests', 'Invitados'],
  ['conversions', 'Conversiones'],
  ['servers', 'Servidores'],
  ['pastors', 'Pastores'],
  ['kids', 'Iglesia de niños'],
  ['preteens', 'Preadolescentes'],
  ['teens', 'Adolescentes'],
];
const OPTIONAL = new Set(['att_start', 'att_mid', 'att_end']);

/** Valida el cuerpo del formulario. Devuelve { value, errors }. */
function parseAttendance(b) {
  const errors = [];
  const date = String(b.service_date || '').trim();
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(date) && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  if (!validDate) errors.push('Escribe una fecha válida.');
  const sede = String(b.sede || '').trim().replace(/\s+/g, ' ');
  if (!sede) errors.push('Elige la sede.');
  const horario = String(b.horario || '').trim();
  if (horario && !/^\d{1,2}:\d{2}$/.test(horario)) errors.push('El horario debe verse así: 10:00.');
  const day = DAYS.includes(b.day_name) ? b.day_name : '';
  const value = { service_date: date, sede, day_name: day, horario, notes: String(b.notes || '').trim().slice(0, 2000) };
  for (const [key, label] of COUNT_FIELDS) {
    const raw = String(b[key] ?? '').trim();
    if (raw === '') {
      value[key] = OPTIONAL.has(key) ? null : 0;
      continue;
    }
    if (!/^\d{1,5}$/.test(raw)) {
      errors.push(`${label}: usa solo números enteros (0 o más).`);
      continue;
    }
    value[key] = parseInt(raw, 10);
  }
  return { value, errors };
}

function attendanceRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const page = (req, res, title, body) =>
    res.send(layout({ title, active: '/asistencia', body, config, query: req.query }));
  const go = (res, path, flash) =>
    res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);

  function form(p, action, errors = []) {
    const num = (key, label, opt) =>
      `<div><label>${label}${opt ? ' <span class="muted">(opcional)</span>' : ''}</label>
        <input type="number" min="0" step="1" inputmode="numeric" name="${key}" value="${esc(p[key] ?? '')}"></div>`;
    const sedes = [...new Set([...SEDES, p.sede].filter(Boolean))];
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
    <form method="post" action="${action}" class="card">
      <div class="row">
        <div><label>Fecha</label><input type="date" name="service_date" required value="${esc(p.service_date || '')}"></div>
        <div><label>Sede</label><select name="sede" required><option value="">Elige…</option>${sedes
          .map((s) => `<option ${p.sede === s ? 'selected' : ''}>${esc(s)}</option>`)
          .join('')}</select></div>
        <div><label>Día de reunión</label><select name="day_name">${DAYS.map(
          (d) => `<option ${p.day_name === d ? 'selected' : ''}>${d}</option>`
        ).join('')}</select></div>
        <div><label>Horario</label><input type="time" name="horario" value="${esc(p.horario || '')}"></div>
      </div>
      <div class="row">${num('att_start', 'Asistencia al inicio', true)}${num('att_mid', 'Intermedio', true)}${num('att_end', 'Al final', true)}</div>
      <div class="row">${num('guests', 'Invitados')}${num('conversions', 'Conversiones')}${num('servers', 'Servidores')}${num('pastors', 'Pastores')}</div>
      <div class="row">${num('kids', 'Iglesia de niños')}${num('preteens', 'Preadolescentes')}${num('teens', 'Adolescentes')}</div>
      <label>Novedades del servicio</label><textarea name="notes">${esc(p.notes || '')}</textarea>
      <div class="actions"><button>Guardar</button><a class="btn sec" href="/asistencia">Cancelar</a></div>
    </form>`;
  }

  const SELECT = `SELECT id, service_date::text AS iso, to_char(service_date, 'DD/MM/YYYY') AS d, sede, day_name, horario,
      att_start, att_mid, att_end, guests, conversions, servers, pastors, kids, preteens, teens, notes
    FROM service_attendance`;

  function filters(q) {
    const where = [];
    const params = [];
    if (q.sede) {
      params.push(q.sede);
      where.push(`lower(sede) = lower($${params.length})`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.desde || '')) {
      params.push(q.desde);
      where.push(`service_date >= $${params.length}`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.hasta || '')) {
      params.push(q.hasta);
      where.push(`service_date <= $${params.length}`);
    }
    return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
  }

  r.get(
    '/asistencia',
    ah(async (req, res) => {
      const f = filters(req.query);
      const rows = (await db.query(`${SELECT}${f.sql} ORDER BY service_date DESC, sede, horario LIMIT 300`, f.params)).rows;
      const sum = (
        await db.query(
          `SELECT sede, count(*)::int AS servicios, round(avg(att_end))::int AS prom_final,
                  coalesce(sum(guests),0)::int AS invitados, coalesce(sum(conversions),0)::int AS conversiones
             FROM service_attendance${f.sql} GROUP BY sede ORDER BY sede`,
          f.params
        )
      ).rows;
      const sedesAll = (await db.query('SELECT DISTINCT sede FROM service_attendance ORDER BY sede')).rows.map((x) => x.sede);
      const sedeOpts = [...new Set([...SEDES, ...sedesAll])];
      const cell = (v) => (v === null || v === undefined ? '<span class="muted">—</span>' : v);

      const list = rows
        .map(
          (a) => `<tr>
          <td>${esc(a.d)}<div class="muted">${esc(a.day_name)} ${esc(a.horario)}</div></td>
          <td>${esc(a.sede)}</td>
          <td>${cell(a.att_start)} / ${cell(a.att_mid)} / ${cell(a.att_end)}</td>
          <td>${a.guests}</td><td>${a.conversions}</td><td>${a.servers}</td><td>${a.pastors}</td>
          <td>${a.kids} / ${a.preteens} / ${a.teens}</td>
          <td>${esc(a.notes)}</td>
          <td style="white-space:nowrap"><a class="btn sec small" href="/asistencia/${a.id}">Editar</a>
            <form class="inline" method="post" action="/asistencia/${a.id}/eliminar" onsubmit="return confirm('¿Eliminar este registro?')">
              <button class="danger small" title="Eliminar" aria-label="Eliminar registro">✕</button></form></td></tr>`
        )
        .join('');
      const sumRows = sum
        .map(
          (s) => `<tr><td>${esc(s.sede)}</td><td>${s.servicios}</td><td>${cell(s.prom_final)}</td><td>${s.invitados}</td><td>${s.conversiones}</td></tr>`
        )
        .join('');

      page(
        req,
        res,
        'Asistencia',
        `<h1>Asistencia a los servicios</h1>
        <p class="sub">Registra cada servicio de celebración. ${rows.length} registros en esta vista.</p>
        <div class="actions"><a class="btn" href="/asistencia/nueva">Registrar servicio</a>
          <a class="btn sec" href="/asistencia/exportar.csv${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}">Descargar lista</a></div>
        <form class="toolbar" method="get">
          <div><label>Sede</label><select name="sede"><option value="">Todas</option>${sedeOpts
            .map((s) => `<option ${req.query.sede === s ? 'selected' : ''}>${esc(s)}</option>`)
            .join('')}</select></div>
          <div><label>Desde</label><input type="date" name="desde" value="${esc(req.query.desde || '')}"></div>
          <div><label>Hasta</label><input type="date" name="hasta" value="${esc(req.query.hasta || '')}"></div>
          <button class="sec">Filtrar</button></form>
        <h2>Resumen por sede</h2>
        <div class="table-scroll"><table><tr><th>Sede</th><th>Servicios</th><th>Promedio al final</th><th>Invitados</th><th>Conversiones</th></tr>${
          sumRows || '<tr><td colspan="5" class="muted">Sin datos.</td></tr>'
        }</table></div>
        <h2>Registros</h2>
        <div class="table-scroll"><table><tr><th>Fecha</th><th>Sede</th><th>Inicio / medio / final</th><th>Invitados</th><th>Conversiones</th><th>Servidores</th><th>Pastores</th><th>Niños / pre / adolesc.</th><th>Novedades</th><th></th></tr>${
          list || '<tr><td colspan="10" class="muted">Aún no hay registros.</td></tr>'
        }</table></div>`
      );
    })
  );

  r.get('/asistencia/nueva', (req, res) => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
    page(req, res, 'Registrar servicio', `<h1>Registrar servicio</h1>${form({ service_date: today, day_name: 'Domingo' }, '/asistencia')}`);
  });

  async function save(req, res, id) {
    const { value, errors } = parseAttendance(req.body);
    if (!errors.length) {
      const dup = (
        await db.query(
          `SELECT id FROM service_attendance WHERE service_date = $1 AND lower(sede) = lower($2) AND horario = $3 AND ($4::int IS NULL OR id <> $4)`,
          [value.service_date, value.sede, value.horario, id]
        )
      ).rows[0];
      if (dup) errors.push('Ya hay un registro de esa sede, fecha y horario. Edítalo en vez de crear otro.');
    }
    if (errors.length) {
      return page(
        req,
        res,
        'Registrar servicio',
        `<h1>${id ? 'Editar registro' : 'Registrar servicio'}</h1>${form({ ...req.body }, id ? `/asistencia/${id}` : '/asistencia', errors)}`
      );
    }
    const v = value;
    const cols = [v.service_date, v.sede, v.day_name, v.horario, v.att_start, v.att_mid, v.att_end, v.guests, v.conversions, v.servers, v.pastors, v.kids, v.preteens, v.teens, v.notes];
    if (id) {
      await db.query(
        `UPDATE service_attendance SET service_date=$2, sede=$3, day_name=$4, horario=$5, att_start=$6, att_mid=$7, att_end=$8,
           guests=$9, conversions=$10, servers=$11, pastors=$12, kids=$13, preteens=$14, teens=$15, notes=$16, updated_at=now() WHERE id=$1`,
        [id, ...cols]
      );
    } else {
      await db.query(
        `INSERT INTO service_attendance (service_date, sede, day_name, horario, att_start, att_mid, att_end, guests, conversions, servers, pastors, kids, preteens, teens, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        cols
      );
    }
    go(res, '/asistencia', { ok: `Guardado: ${v.sede}, ${v.service_date}` });
  }

  r.post('/asistencia', ah((req, res) => save(req, res, null)));

  r.get(
    '/asistencia/:id(\\d+)',
    ah(async (req, res) => {
      const a = (await db.query(`${SELECT} WHERE id = $1`, [+req.params.id])).rows[0];
      if (!a) return go(res, '/asistencia', { err: 'No existe ese registro.' });
      page(req, res, 'Editar registro', `<h1>Editar registro</h1>${form({ ...a, service_date: a.iso }, `/asistencia/${a.id}`)}`);
    })
  );
  r.post('/asistencia/:id(\\d+)', ah((req, res) => save(req, res, +req.params.id)));

  r.post(
    '/asistencia/:id(\\d+)/eliminar',
    ah(async (req, res) => {
      await db.query('DELETE FROM service_attendance WHERE id = $1', [+req.params.id]);
      go(res, '/asistencia', { ok: 'Registro eliminado.' });
    })
  );

  r.get(
    '/asistencia/exportar.csv',
    ah(async (req, res) => {
      const f = filters(req.query);
      const rows = (await db.query(`${SELECT}${f.sql} ORDER BY service_date, sede, horario`, f.params)).rows;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="asistencia.csv"');
      res.send(
        toCsv([
          ['Fecha', 'Sede', 'Día', 'Horario', 'Inicio', 'Intermedio', 'Final', 'Invitados', 'Conversiones', 'Servidores', 'Pastores', 'Iglesia de niños', 'Preadolescentes', 'Adolescentes', 'Novedades'],
          ...rows.map((a) => [a.iso, a.sede, a.day_name, a.horario, a.att_start, a.att_mid, a.att_end, a.guests, a.conversions, a.servers, a.pastors, a.kids, a.preteens, a.teens, a.notes]),
        ])
      );
    })
  );

  return r;
}

module.exports = { attendanceRouter, parseAttendance };
