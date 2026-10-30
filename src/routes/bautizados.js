'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const bz = require('../bautizados/store');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Pestaña Bautizados: lista, registro uno por uno y carga de listas. */
function bautizadosRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/bautizados', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    next();
  });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/bautizados', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

  /** Formulario de una persona (el mismo para registrar y para corregir). */
  function form(v, action, errors = [], { submit = 'Guardar', cancel = '/bautizados' } = {}) {
    const t = (name, label, type = 'text', extra = '') => `<div><label>${label}</label><input type="${type}" name="${name}" value="${esc(v[name] ?? '')}" ${extra}></div>`;
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" action="${action}" class="card">
        <div class="row">${t('name', 'Nombre y apellido', 'text', 'required maxlength="120"')}${t('phone', 'Teléfono (opcional)', 'tel', 'placeholder="0414-000.00.00"')}</div>
        <div class="row">${t('baptism_date', 'Fecha del bautismo', 'date', `max="${esc(today())}"`)}${t('sede', 'Sede')}${t('minister', 'Bautizado por')}</div>
        <label>Nota</label><textarea name="note" style="min-height:60px">${esc(v.note || '')}</textarea>
        <div class="actions"><button>${submit}</button>${cancel ? `<a class="btn sec" href="${cancel}">Cancelar</a>` : ''}</div>
      </form>`;
  }

  /* ------------------------------ Lista ------------------------------ */
  r.get(
    '/bautizados',
    ah(async (req, res) => {
      const f = { q: String(req.query.q || ''), anio: String(req.query.anio || ''), fecha: String(req.query.fecha || '') };
      const year = +today().slice(0, 4);
      const [rows, st, ys] = await Promise.all([bz.list(db, f), bz.stats(db, year), bz.years(db)]);
      const opt = (items, cur, empty) => `<option value="">${esc(empty)}</option>${items.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
      const list = rows
        .map(
          (x) => `<tr>
            <td><a href="/bautizados/${x.id}">${esc(x.full_name)}</a></td>
            <td>${esc(displayPhone(x.phone) || '—')}</td>
            <td>${esc(dmy(x.d))}</td>
            <td>${esc(x.sede || '—')}</td>
            <td class="muted">${esc(x.source)}</td>
            <td><a class="btn sec small" href="/bautizados/${x.id}">Abrir</a></td></tr>`
        )
        .join('');
      page(
        req,
        res,
        'Bautizados',
        `<h1>Bautizados</h1>
        <p class="sub">Registro de las personas bautizadas. Puedes agregarlas una por una aquí abajo o cargar una lista completa. Si alguien ya estaba (mismo teléfono, o mismo nombre y fecha), no se duplica. Registrar aquí no crea personas ni las suscribe a mensajes.</p>
        <div class="actions"><a class="btn" href="/bautizados/importar">Cargar una lista</a></div>
        <div class="grid">
          <div class="card"><div class="stat">${st.total}</div><div class="stat-label">bautizados registrados</div></div>
          <div class="card"><div class="stat" style="color:var(--ok)">${st.this_year}</div><div class="stat-label">bautizados en ${year}</div></div>
          <div class="card"><div class="stat">${st.with_phone}</div><div class="stat-label">con teléfono</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${st.no_date}</div><div class="stat-label">sin fecha</div></div>
        </div>
        <h2>Agregar un bautizado</h2>
        ${form({ baptism_date: today() }, '/bautizados', [], { submit: 'Agregar', cancel: '' })}
        <form class="toolbar" method="get">
          <div><label>Buscar</label><input type="search" name="q" value="${esc(f.q)}" placeholder="Nombre o teléfono"></div>
          <div><label>Año</label><select name="anio">${opt(ys.map((y) => [y, y]), f.anio, 'Todos')}</select></div>
          <div><label>Fecha</label><select name="fecha">${opt([['sin', 'Sin fecha']], f.fecha, 'Todas')}</select></div>
          <button class="sec">Filtrar</button></form>
        <h2>Personas (${rows.length})</h2>
        <div class="table-scroll"><table><tr><th>Nombre</th><th>Teléfono</th><th>Bautismo</th><th>Sede</th><th>Fuente</th><th></th></tr>${
          list || '<tr><td colspan="6" class="muted">Todavía no hay nadie con esos filtros.</td></tr>'
        }</table></div>`
      );
    })
  );

  r.post(
    '/bautizados',
    ah(async (req, res) => {
      const out = await bz.save(db, null, req.body, config.defaultCountryCode, today());
      if (out.errors) return page(req, res, 'Agregar un bautizado', `<h1>Agregar un bautizado</h1>${form(req.body, '/bautizados', out.errors, { submit: 'Agregar' })}`);
      if (out.duplicate) return go(res, `/bautizados/${out.id}`, { err: 'Esa persona ya estaba registrada: no se duplicó. Aquí está su registro.' });
      go(res, '/bautizados', { ok: `Agregado: ${String(req.body.name || '').trim()}.` });
    })
  );

  /* ------------------------------ Cargar una lista ------------------------------ */
  function importPage(b, extra = '') {
    const t = (name, label, type = 'text', more = '') => `<div><label>${label}</label><input type="${type}" name="${name}" value="${esc(b[name] || '')}" ${more}></div>`;
    return `<p><a href="/bautizados">← Bautizados</a></p><h1>Cargar una lista de bautizados</h1>
      <p class="sub">Primero se revisa, y nada se guarda hasta que pulses "Guardar". Puedes:</p>
      <ul class="sub">
        <li><strong>Pegar una lista simple:</strong> un nombre por línea (si quieres, con su teléfono después de una coma: <span class="mono">Ana Torres, 0414-111.22.33</span>).</li>
        <li><strong>Subir un archivo CSV</strong> (Excel o Google Sheets → Descargar como CSV) con estas columnas: <span class="mono">${esc(bz.TEMPLATE_HEADERS.join(', '))}</span>. Solo hace falta <span class="mono">nombre</span>.</li>
      </ul>
      <form method="post" class="card">
        <label>Archivo CSV</label><input type="file" accept=".csv,.txt,text/csv,text/plain" id="file">
        <label>O pega la lista aquí</label>
        <textarea name="csv" id="csv" style="min-height:160px" class="mono">${esc(b.csv || '')}</textarea>
        <p class="muted" style="font-size:13px;margin:10px 0 0">Para toda la lista (se usa cuando una fila no trae ese dato):</p>
        <div class="row">${t('baptism_date', 'Fecha del bautismo', 'date', `max="${esc(today())}"`)}${t('sede', 'Sede')}${t('minister', 'Bautizado por')}${t('source', 'Nombre de la lista', 'text', 'placeholder="Ej.: Bautizos agosto 2026"')}</div>
        <div class="actions"><button name="accion" value="revisar">Revisar</button><a class="btn sec" href="/bautizados">Cancelar</a></div>
      </form>${extra}
      <script>
        document.getElementById('file').addEventListener('change', function(e){
          var f = e.target.files[0]; if(!f) return;
          var rd = new FileReader();
          rd.onload = function(){ document.getElementById('csv').value = rd.result; };
          rd.readAsText(f, 'UTF-8');
        });
      </script>`;
  }

  r.get('/bautizados/importar', (req, res) => page(req, res, 'Cargar una lista', importPage({})));

  r.post(
    '/bautizados/importar',
    ah(async (req, res) => {
      const b = {};
      for (const k of ['csv', 'baptism_date', 'sede', 'minister', 'source']) b[k] = String(req.body[k] || '');
      const defaults = { baptism_date: b.baptism_date, sede: b.sede, minister: b.minister, source: b.source.trim() || 'Lista cargada' };
      const prep = await bz.prepareImport(db, b.csv, { countryCode: config.defaultCountryCode, today: today(), defaults });
      const errs = prep.fileErrors.concat(prep.records.flatMap((x) => x.errors.map((e) => `Línea ${x.line}: ${e}`)));
      if (req.body.accion === 'guardar' && !errs.length) {
        const s = await bz.applyImport(db, prep);
        return go(res, '/bautizados', { ok: `Lista cargada: ${s.saved} bautizados nuevos${s.skipped ? `, ${s.skipped} omitidos porque ya estaban o venían repetidos` : ''}.` });
      }
      const by = (st) => prep.records.filter((x) => x.status === st);
      const nuevos = by('nueva');
      const preview = nuevos
        .slice(0, 300)
        .map((x) => `<tr><td>${esc(x.value.full_name || '—')}</td><td>${esc(displayPhone(x.value.phone) || '—')}</td><td>${esc(dmy(x.value.baptism_date))}</td><td>${esc(x.value.sede || '—')}</td></tr>`)
        .join('');
      const summary = `<div class="grid">
        <div class="card"><div class="stat">${nuevos.length}</div><div class="stat-label">bautizados nuevos</div></div>
        <div class="card"><div class="stat">${by('ya_estaba').length + by('repetida').length}</div><div class="stat-label">se omiten (ya estaban o repetidos)</div></div></div>
        <p class="muted">${prep.mode === 'csv' ? 'Se leyó como archivo con columnas.' : 'Se leyó como lista simple: un nombre por línea.'}${prep.unknown.length ? ` Columnas ignoradas: ${esc(prep.unknown.join(', '))}.` : ''}</p>`;
      const hidden = Object.entries(b).map(([k, v]) => (k === 'csv' ? `<textarea name="csv" hidden>${esc(v)}</textarea>` : `<input type="hidden" name="${k}" value="${esc(v)}">`)).join('');
      const body = errs.length
        ? `${summary}<div class="flash err"><strong>No se puede guardar todavía.</strong> Corrige esto y vuelve a revisar:<br>${errs.slice(0, 40).map(esc).join('<br>')}${errs.length > 40 ? `<br>… y ${errs.length - 40} más.` : ''}</div>`
        : `${summary}${nuevos.length ? `<div class="table-scroll"><table><tr><th>Nombre</th><th>Teléfono</th><th>Bautismo</th><th>Sede</th></tr>${preview}</table></div>${nuevos.length > 300 ? `<p class="muted">… y ${nuevos.length - 300} más.</p>` : ''}
           <form method="post">${hidden}<div class="actions"><button name="accion" value="guardar">Guardar ${nuevos.length} bautizados</button></div></form>` : '<div class="flash ok">No hay nadie nuevo para guardar.</div>'}`;
      page(req, res, 'Cargar una lista', importPage(b, body));
    })
  );

  /* ------------------------------ Ficha ------------------------------ */
  const fromRecord = (x) => ({ name: x.full_name, phone: x.phone ? displayPhone(x.phone) : '', baptism_date: x.d, sede: x.sede, minister: x.minister, note: x.note });

  r.get(
    '/bautizados/:id(\\d{1,9})',
    ah(async (req, res) => {
      const x = await bz.get(db, +req.params.id);
      if (!x) return go(res, '/bautizados', { err: 'No existe ese registro.' });
      page(
        req,
        res,
        x.full_name,
        `<p><a href="/bautizados">← Bautizados</a></p><h1>${esc(x.full_name)}</h1>
        <p class="sub">Fuente: ${esc(x.source)}</p>
        ${form(fromRecord(x), `/bautizados/${x.id}`)}
        <form method="post" action="/bautizados/${x.id}/eliminar" onsubmit="return confirm('¿Borrar este registro de bautizados? No se puede deshacer.')">
          <button class="danger small">Borrar este registro</button></form>`
      );
    })
  );
  r.post(
    '/bautizados/:id(\\d{1,9})',
    ah(async (req, res) => {
      const id = +req.params.id;
      const out = await bz.save(db, id, req.body, config.defaultCountryCode, today());
      if (out.errors) {
        const x = await bz.get(db, id);
        if (!x) return go(res, '/bautizados', { err: 'No existe ese registro.' });
        return page(req, res, x.full_name, `<h1>${esc(x.full_name)}</h1>${form(req.body, `/bautizados/${id}`, out.errors)}`);
      }
      go(res, `/bautizados/${id}`, { ok: 'Guardado.' });
    })
  );
  r.post(
    '/bautizados/:id(\\d{1,9})/eliminar',
    ah(async (req, res) => {
      await bz.remove(db, +req.params.id);
      go(res, '/bautizados', { ok: 'Registro borrado.' });
    })
  );

  return r;
}

module.exports = { bautizadosRouter };
