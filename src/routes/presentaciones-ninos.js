'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const pn = require('../presentaciones-ninos');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Pestaña Presentación de Niños: registro de los niños presentados al Señor (grupo Seguimiento, junto a Bautizados). */
function presentacionesNinosRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/presentacion-ninos', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos de menores
    next();
  });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/presentacion-ninos', body, config, query: req.query }));
  const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

  function form(v, errors = []) {
    const t = (name, label, type = 'text', extra = '') => `<div><label>${label}</label><input type="${type}" name="${name}" value="${esc(v[name] ?? '')}" ${extra}></div>`;
    const sedeOpts = `<option value="">—</option>${pn.SEDES.map((s) => `<option value="${esc(s)}" ${v.sede === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" action="/presentacion-ninos" class="card">
        <div class="row">${t('name', 'Nombre del niño', 'text', 'required maxlength="120"')}${t('birth_date', 'Fecha de nacimiento', 'date', `max="${esc(today())}"`)}</div>
        <div class="row">${t('presentation_date', 'Fecha de presentación', 'date', `max="${esc(today())}"`)}<div><label>Sede</label><select name="sede">${sedeOpts}</select></div>${t('presented_by', 'Presentado por')}</div>
        <div class="row">${t('parents', 'Padres o representantes')}</div>
        <label>Nota</label><textarea name="note" style="min-height:60px">${esc(v.note || '')}</textarea>
        <div class="actions"><button>Agregar</button></div>
      </form>`;
  }

  r.get(
    '/presentacion-ninos',
    ah(async (req, res) => {
      const q = String(req.query.q || '').slice(0, 80);
      const year = +today().slice(0, 4);
      const [rows, st] = await Promise.all([pn.list(db, { q }), pn.stats(db, year)]);
      const list = rows
        .map(
          (x) => `<tr>
            <td>${esc(x.child_name)}</td>
            <td>${esc(dmy(x.birth_date))}</td>
            <td>${esc(dmy(x.presentation_date))}</td>
            <td>${esc(x.sede || '—')}</td>
            <td>${esc(x.parents || '—')}</td>
            <td>${esc(x.presented_by || '—')}</td>
            <td><form method="post" action="/presentacion-ninos/${x.id}/borrar" onsubmit="return confirm('¿Borrar el registro de ${esc(x.child_name).replace(/'/g, '')}?')"><button class="danger small">Borrar</button></form></td></tr>`
        )
        .join('');
      page(
        req,
        res,
        'Presentación de Niños',
        `<h1>Presentación de Niños</h1>
        <p class="sub">Registro de los niños presentados al Señor. Registrar aquí no crea personas en Personas ni suscribe a nadie a mensajes.</p>
        <div class="grid">
          <div class="card"><div class="stat">${st.total}</div><div class="stat-label">niños presentados</div></div>
          <div class="card"><div class="stat" style="color:var(--ok)">${st.this_year}</div><div class="stat-label">presentados en ${year}</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${st.no_date}</div><div class="stat-label">sin fecha</div></div>
        </div>
        <h2>Registrar una presentación</h2>
        ${form({ presentation_date: today() })}
        <form class="toolbar" method="get">
          <div><label>Buscar</label><input type="search" name="q" value="${esc(q)}" placeholder="Nombre del niño o de los padres"></div>
          <button class="sec">Filtrar</button></form>
        <h2>Niños presentados (${rows.length})</h2>
        <div class="table-scroll"><table><tr><th>Niño</th><th>Nacimiento</th><th>Presentación</th><th>Sede</th><th>Padres o representantes</th><th>Presentado por</th><th></th></tr>${
          list || '<tr><td colspan="7" class="muted">Todavía no hay ninguna presentación registrada.</td></tr>'
        }</table></div>`
      );
    })
  );

  r.post(
    '/presentacion-ninos',
    ah(async (req, res) => {
      const out = await pn.add(db, req.body || {}, today());
      if (out.errors) {
        const q = '';
        const year = +today().slice(0, 4);
        const [rows, st] = await Promise.all([pn.list(db, { q }), pn.stats(db, year)]);
        return page(
          req,
          res,
          'Presentación de Niños',
          `<h1>Presentación de Niños</h1><h2>Registrar una presentación</h2>${form(req.body || {}, out.errors)}
           <p class="sub">Hay ${st.total} niños presentados registrados; revisa los datos y vuelve a intentar.</p>
           <p><a href="/presentacion-ninos">← Volver a la lista (${rows.length})</a></p>`
        );
      }
      res.redirect(303, '/presentacion-ninos?ok=' + encodeURIComponent('Presentación registrada.'));
    })
  );

  r.post(
    '/presentacion-ninos/:id/borrar',
    ah(async (req, res) => {
      const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
      const ok = id && (await pn.remove(db, id));
      res.redirect(303, '/presentacion-ninos?' + (ok ? 'ok=' + encodeURIComponent('Registro borrado.') : 'err=' + encodeURIComponent('No se encontró ese registro.')));
    })
  );

  return r;
}

module.exports = { presentacionesNinosRouter };
