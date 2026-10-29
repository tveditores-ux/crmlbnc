'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const { toCsv } = require('../csv');
const charts = require('../views/charts');
const cg = require('../care-groups');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STALE_DAYS = 8; // un grupo que se reúne cada semana y lleva más de esto sin reportar

function careGroupsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/grupos', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const short = (iso) => {
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  };

  const select = (name, options, value, blank) =>
    `<select name="${name}">${blank ? `<option value="">${esc(blank)}</option>` : ''}${options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

  function groupForm(g, action, errors = []) {
    const t = (name, label, extra = '') => `<div><label>${label}</label><input type="text" name="${name}" value="${esc(g[name] || '')}" ${extra}></div>`;
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" action="${action}" class="card">
        <div class="row">
          ${t('name', 'Nombre del grupo', 'required maxlength="120"')}${t('leader_name', 'Líder')}
          ${t('leader_phone', 'Teléfono del líder', 'inputmode="tel"')}${t('leader_email', 'Correo del líder', 'type="text"')}
          ${t('advisor_name', 'Líder asesor')}${t('belongs_to', 'Pertenece a')}
          ${t('congregation', 'Congregación')}${t('place', 'Lugar de reunión')}
          <div><label>Día</label>${select('meeting_day', cg.DAYS, g.meeting_day, 'Sin definir')}</div>
          <div><label>Hora</label><input type="time" name="meeting_time" value="${esc(g.meeting_time || '')}"></div>
          <div><label>Etapa</label>${select('stage', cg.STAGES, g.stage, 'Sin definir')}</div>
          ${t('address', 'Dirección')}
        </div>
        <button style="margin-top:14px">Guardar grupo</button>
      </form>`;
  }

  /* ------------------------------- Lista ------------------------------- */
  r.get(
    '/grupos',
    ah(async (req, res) => {
      const t = today();
      const groups = await cg.listGroups(db, t);
      const active = groups.filter((g) => g.active);
      const stale = active.filter((g) => {
        const d = cg.daysSince(g.last_report, t);
        return d === null || d > STALE_DAYS;
      });
      const weekly = (
        await db.query(
          `SELECT to_char(date_trunc('week', meeting_date), 'DD/MM') AS lbl, date_trunc('week', meeting_date) AS wk,
                  coalesce(sum(attendance), 0)::int AS att, coalesce(sum(guests_count), 0)::int AS guests
             FROM care_group_reports WHERE meeting_date > $1::date - 84
            GROUP BY wk ORDER BY wk`,
          [t]
        )
      ).rows;
      const totals = (
        await db.query(`SELECT count(*)::int AS n, coalesce(sum(attendance),0)::int AS att, coalesce(sum(guests_count),0)::int AS guests FROM care_group_reports WHERE meeting_date > $1::date - 30`, [t])
      ).rows[0];
      const rows = groups
        .map((g) => {
          const d = cg.daysSince(g.last_report, t);
          const badge = !g.active ? '<span class="badge b-muted">Inactivo</span>' : d === null ? '<span class="badge b-warn">Sin reportes</span>' : d > STALE_DAYS ? `<span class="badge b-warn">Hace ${d} días</span>` : `<span class="badge b-ok">Al día</span>`;
          return `<tr style="${g.active ? '' : 'opacity:.55'}">
            <td><a href="/grupos/${g.id}"><strong>${esc(g.name)}</strong></a><div class="muted">${esc([g.stage, g.congregation].filter(Boolean).join(' · '))}</div></td>
            <td>${esc(g.leader_name)}<div class="muted">${esc(displayPhone(g.leader_phone))}</div></td>
            <td>${esc([g.meeting_day, g.meeting_time].filter(Boolean).join(' '))}<div class="muted">${esc(g.place)}</div></td>
            <td>${badge}<div class="muted">${g.last_report ? esc(short(g.last_report)) : ''}</div></td>
            <td>${g.reports_30d}</td></tr>`;
        })
        .join('');
      page(
        req,
        res,
        'Grupos de cuidado',
        `<h1>Grupos de cuidado</h1>
        <p class="sub">Cada grupo tiene un enlace para que su líder reporte la reunión desde el teléfono, sin contraseña.</p>
        <div class="grid">
          <div class="card"><div class="stat">${active.length}</div><div class="stat-label">grupos activos</div></div>
          <div class="card"><div class="stat">${totals.n}</div><div class="stat-label">reportes en 30 días</div></div>
          <div class="card"><div class="stat">${totals.att}</div><div class="stat-label">asistentes (30 días)</div></div>
          <div class="card"><div class="stat">${stale.length}</div><div class="stat-label">sin reportar hace más de ${STALE_DAYS} días</div></div>
        </div>
        <p class="toolbar"><a class="btn" href="/grupos/nuevo">Agregar grupo</a> <a class="btn sec" href="/grupos/reportes.csv">Descargar reportes</a></p>
        ${weekly.length ? `<div class="card"><h3>Asistencia semanal en todos los grupos</h3>${charts.lineChart(weekly.map((w) => w.lbl), [{ name: 'Asistentes', values: weekly.map((w) => w.att) }, { name: 'Invitados', values: weekly.map((w) => w.guests) }], { title: 'Asistencia semanal en los grupos de cuidado' })}</div>` : ''}
        <div class="table-scroll"><table><tr><th>Grupo</th><th>Líder</th><th>Reunión</th><th>Último reporte</th><th>Reportes (30 d)</th></tr>${
          rows || '<tr><td colspan="5" class="muted">Aún no hay grupos. Agrega el primero.</td></tr>'
        }</table></div>`
      );
    })
  );

  r.get('/grupos/nuevo', (req, res) => page(req, res, 'Nuevo grupo', `<h1>Nuevo grupo de cuidado</h1>${groupForm({}, '/grupos')}`));
  r.post(
    '/grupos',
    ah(async (req, res) => {
      const { value, errors } = cg.parseGroup(req.body, config.defaultCountryCode);
      if (errors.length) return page(req, res, 'Nuevo grupo', `<h1>Nuevo grupo de cuidado</h1>${groupForm(req.body, '/grupos', errors)}`);
      const ins = await db.query(
        `INSERT INTO care_groups (name, leader_name, leader_phone, leader_email, advisor_name, belongs_to, congregation, address, place, meeting_day, meeting_time, stage, token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [value.name, value.leader_name, value.leader_phone, value.leader_email, value.advisor_name, value.belongs_to, value.congregation, value.address, value.place, value.meeting_day, value.meeting_time, value.stage, cg.newToken()]
      );
      go(res, `/grupos/${ins.rows[0].id}`, { ok: 'Grupo creado. Copia su enlace y envíaselo al líder.' });
    })
  );

  r.get(
    '/grupos/reportes.csv',
    ah(async (req, res) => {
      const { rows } = await db.query(
        `SELECT r.*, g.name FROM care_group_reports r JOIN care_groups g ON g.id = r.group_id ORDER BY r.meeting_date DESC, g.name`
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="reportes-grupos-de-cuidado.csv"');
      res.send(
        toCsv([
          ['Grupo', 'Fecha', 'Miembros', 'Invitados', 'Asistentes', 'Ofrenda', 'Refrigerio', 'Dinámicas', 'Testimonios', 'Canciones', 'Elemento clave', 'Seguimiento', 'Notas', 'Visita del asesor'],
          ...rows.map((x) => [x.name, String(x.meeting_date).slice(0, 10), x.members_count, x.guests_count, x.attendance, x.offering, x.snack, x.dynamics, x.testimonies, x.songs, x.key_element, x.followup, x.notes, x.advisor_visit ? 'sí' : 'no']),
        ])
      );
    })
  );

  /* ------------------------------ Un grupo ------------------------------ */
  async function loadGroup(id) {
    return (await db.query('SELECT * FROM care_groups WHERE id = $1', [id])).rows[0];
  }

  r.get(
    '/grupos/:id(\\d{1,9})',
    ah(async (req, res) => {
      const g = await loadGroup(+req.params.id);
      if (!g) return go(res, '/grupos', { err: 'Ese grupo no existe.' });
      const reports = (
        await db.query(`SELECT *, meeting_date::text AS d FROM care_group_reports WHERE group_id = $1 ORDER BY meeting_date DESC LIMIT 60`, [g.id])
      ).rows;
      const url = `${config.publicUrl}/g/${g.token}`;
      const chronological = [...reports].reverse().slice(-16);
      const history = reports
        .map(
          (x) => `<tr><td>${esc(short(x.d))}${x.advisor_visit ? '<div class="muted">Visita del asesor</div>' : ''}</td>
            <td>${x.attendance ?? '—'}<div class="muted">${x.members_count ?? '—'} miembros · ${x.guests_count ?? '—'} invitados</div></td>
            <td>${x.offering === null ? '—' : esc(Number(x.offering).toLocaleString('es-VE', { minimumFractionDigits: 2 }))}</td>
            <td>${[['Elemento clave', x.key_element], ['Testimonios', x.testimonies], ['Seguimiento', x.followup], ['Notas', x.notes]]
              .filter(([, v]) => v)
              .map(([l, v]) => `<div><span class="muted">${l}:</span> ${esc(v)}</div>`)
              .join('')}</td></tr>`
        )
        .join('');
      page(
        req,
        res,
        g.name,
        `<p><a href="/grupos">← Grupos de cuidado</a></p>
        <h1>${esc(g.name)} ${g.active ? '' : '<span class="badge b-muted">Inactivo</span>'}</h1>
        <p class="sub">${esc([g.stage, g.leader_name && `Líder: ${g.leader_name}`, g.advisor_name && `Asesor: ${g.advisor_name}`, [g.meeting_day, g.meeting_time].filter(Boolean).join(' '), g.place].filter(Boolean).join(' · '))}</p>
        <div class="card"><h3>Enlace del líder</h3>
          <p class="muted" style="font-size:13px">Quien tenga este enlace puede enviar reportes de este grupo. Compártelo solo con el líder; si se pierde, genera uno nuevo y el anterior deja de funcionar.</p>
          <input type="text" readonly value="${esc(url)}" onclick="this.select()" style="font-size:13px" ${g.link_active ? '' : 'disabled'}>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec" data-copy="${esc(url)}">Copiar</button>
            <form class="inline" method="post" action="/grupos/${g.id}/enlace/${g.link_active ? 'desactivar' : 'activar'}"><button class="small ${g.link_active ? 'danger' : 'sec'}">${g.link_active ? 'Desactivar enlace' : 'Activar enlace'}</button></form>
            <form class="inline" method="post" action="/grupos/${g.id}/enlace/nuevo"><button class="small sec">Generar enlace nuevo</button></form>
            <span class="muted">${g.uses} envíos${g.last_used_at ? '' : ' · sin uso'}</span></p></div>
        ${chronological.length > 1 ? `<div class="card"><h3>Asistencia por reunión</h3>${charts.lineChart(chronological.map((x) => short(x.d).slice(0, 5)), [{ name: 'Asistentes', values: chronological.map((x) => x.attendance) }, { name: 'Invitados', values: chronological.map((x) => x.guests_count) }], { title: `Asistencia de ${g.name}` })}</div>` : ''}
        <h2>Reportes</h2>
        <div class="table-scroll"><table><tr><th>Fecha</th><th>Asistentes</th><th>Ofrenda</th><th>Detalle</th></tr>${history || '<tr><td colspan="4" class="muted">Este grupo todavía no ha reportado.</td></tr>'}</table></div>
        <h2>Datos del grupo</h2>${groupForm(g, `/grupos/${g.id}/editar`)}
        <form method="post" action="/grupos/${g.id}/${g.active ? 'desactivar' : 'activar'}" style="margin-top:10px"><button class="small ${g.active ? 'danger' : 'sec'}">${g.active ? 'Desactivar grupo' : 'Reactivar grupo'}</button>
          <span class="muted">Un grupo inactivo conserva su historial y deja de aparecer como pendiente.</span></form>
        <script>document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copy');(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='¡Copiado!';},function(){b.closest('.card').querySelector('input').select();b.textContent='Selecciona y copia';});});});</script>`
      );
    })
  );

  r.post(
    '/grupos/:id(\\d{1,9})/editar',
    ah(async (req, res) => {
      const g = await loadGroup(+req.params.id);
      if (!g) return go(res, '/grupos', { err: 'Ese grupo no existe.' });
      const { value, errors } = cg.parseGroup(req.body, config.defaultCountryCode);
      if (errors.length) return page(req, res, g.name, `<p><a href="/grupos/${g.id}">← Volver</a></p><h1>${esc(g.name)}</h1>${groupForm(req.body, `/grupos/${g.id}/editar`, errors)}`);
      await db.query(
        `UPDATE care_groups SET name=$2, leader_name=$3, leader_phone=$4, leader_email=$5, advisor_name=$6, belongs_to=$7, congregation=$8, address=$9, place=$10, meeting_day=$11, meeting_time=$12, stage=$13 WHERE id=$1`,
        [g.id, value.name, value.leader_name, value.leader_phone, value.leader_email, value.advisor_name, value.belongs_to, value.congregation, value.address, value.place, value.meeting_day, value.meeting_time, value.stage]
      );
      go(res, `/grupos/${g.id}`, { ok: 'Datos guardados.' });
    })
  );

  r.post(
    '/grupos/:id(\\d{1,9})/:accion(activar|desactivar)',
    ah(async (req, res) => {
      await db.query('UPDATE care_groups SET active = $2 WHERE id = $1', [+req.params.id, req.params.accion === 'activar']);
      go(res, `/grupos/${+req.params.id}`, { ok: req.params.accion === 'activar' ? 'Grupo reactivado.' : 'Grupo desactivado.' });
    })
  );

  r.post(
    '/grupos/:id(\\d{1,9})/enlace/:accion(activar|desactivar|nuevo)',
    ah(async (req, res) => {
      const id = +req.params.id;
      if (req.params.accion === 'nuevo') {
        await db.query('UPDATE care_groups SET token = $2, link_active = TRUE WHERE id = $1', [id, cg.newToken()]);
        return go(res, `/grupos/${id}`, { ok: 'Enlace nuevo generado. El anterior ya no funciona.' });
      }
      await db.query('UPDATE care_groups SET link_active = $2 WHERE id = $1', [id, req.params.accion === 'activar']);
      go(res, `/grupos/${id}`, { ok: req.params.accion === 'activar' ? 'Enlace activado.' : 'Enlace desactivado.' });
    })
  );

  return r;
}

module.exports = { careGroupsRouter };
