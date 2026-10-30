'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const bz = require('../bautizados/store');
const charts = require('../views/charts');

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
  const PRINTER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>';
  const filters = (q) => ({
    q: String(q.q || '').slice(0, 80), anio: String(q.anio || ''), fecha: String(q.fecha || ''),
    sede: String(q.sede || '').slice(0, 80), desde: String(q.desde || ''), hasta: String(q.hasta || ''),
  });
  const qs = (f) => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const opt = (items, cur, empty) => `<option value="">${esc(empty)}</option>${items.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;

  /** Gráficas de los bautizados que se están viendo: por mes, por sede y (si hay varios) por año. */
  function chartsBlock(rows) {
    const dated = rows.filter((x) => x.d);
    const tally = (key, list) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
    let months = [];
    if (dated.length) {
      const byMonth = tally((x) => x.d.slice(0, 7), dated);
      const keys = [...byMonth.keys()].sort();
      // Todos los meses entre el primero y el último (los vacíos en cero), hasta 24 meses.
      let [y, m] = keys[keys.length - 1].split('-').map(Number);
      for (let i = 0; i < 24; i++) {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        months.unshift({ label: charts.monthLabel(ym), value: byMonth.get(ym) || 0 });
        if (ym <= keys[0]) break;
        if (--m === 0) [y, m] = [y - 1, 12];
      }
    }
    const sedes = [...tally((x) => x.sede || 'Sin sede', rows)].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
    const years = [...tally((x) => x.d.slice(0, 4), dated)].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, value]) => ({ label, value }));
    return `<div class="charts">
        <div class="card wide"><h3>Bautizados por mes</h3>${charts.barChart(months, { title: 'Bautizados por mes', height: 220 })}</div>
        <div class="card"><h3>Por sede</h3>${charts.hBarChart(sedes, { title: 'Bautizados por sede', color: charts.PALETTE[1] })}</div>
        ${years.length > 1 ? `<div class="card"><h3>Por año</h3>${charts.barChart(years, { title: 'Bautizados por año', color: charts.PALETTE[3], height: 200 })}</div>` : ''}
      </div>`;
  }

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
      const f = filters(req.query);
      const year = +today().slice(0, 4);
      const [rows, st, ys, ss] = await Promise.all([bz.list(db, f), bz.stats(db, year), bz.years(db), bz.sedes(db)]);
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
        <div class="actions"><a class="btn" href="/bautizados/importar">Cargar una lista</a>
          <a class="btn sec" href="/bautizados/reporte${qs(f) ? `?${esc(qs(f))}` : ''}">${PRINTER}Imprimir reporte</a>
          ${st.total > st.with_phone ? `<a class="btn sec" href="/bautizados/telefonos">Completar teléfonos (${st.total - st.with_phone} sin teléfono)</a>` : ''}</div>
        <div class="grid">
          <div class="card"><div class="stat">${st.total}</div><div class="stat-label">bautizados registrados</div></div>
          <div class="card"><div class="stat" style="color:var(--ok)">${st.this_year}</div><div class="stat-label">bautizados en ${year}</div></div>
          <div class="card"><div class="stat">${st.with_phone}</div><div class="stat-label">con teléfono</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${st.no_date}</div><div class="stat-label">sin fecha</div></div>
        </div>
        ${rows.length ? chartsBlock(rows) : ''}
        <h2>Agregar un bautizado</h2>
        ${form({ baptism_date: today() }, '/bautizados', [], { submit: 'Agregar', cancel: '' })}
        <form class="toolbar" method="get">
          <div><label>Buscar</label><input type="search" name="q" value="${esc(f.q)}" placeholder="Nombre o teléfono"></div>
          <div><label>Año</label><select name="anio">${opt(ys.map((y) => [y, y]), f.anio, 'Todos')}</select></div>
          <div><label>Sede</label><select name="sede">${opt(ss.map((s) => [s, s]), f.sede, 'Todas')}</select></div>
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

  /* ------------------------------ Reporte para imprimir ------------------------------ */
  r.get(
    '/bautizados/reporte',
    ah(async (req, res) => {
      const f = filters(req.query);
      const [rows, ys, ss] = await Promise.all([bz.list(db, f, 3000), bz.years(db), bz.sedes(db)]);
      rows.sort((a, b) => (a.d || '') === (b.d || '') ? a.full_name.localeCompare(b.full_name, 'es') : (a.d || '') < (b.d || '') ? 1 : -1);
      const period = f.desde || f.hasta
        ? `Del ${f.desde ? dmy(bz.parseDate(f.desde) || '') : 'inicio'} al ${f.hasta ? dmy(bz.parseDate(f.hasta) || '') : dmy(today())}`
        : f.anio ? `Año ${f.anio}` : f.fecha === 'sin' ? 'Sin fecha de bautismo' : 'Todos los registros';
      const scope = [period, f.sede && `Sede: ${f.sede}`, f.q && `Búsqueda: "${f.q}"`].filter(Boolean).join(' · ');
      const count = (key) => Object.entries(rows.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {}));
      const byDate = count((x) => x.d || '').sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const summary = (title, items, label) => `<div class="card"><h3 style="margin:0 0 6px;font-size:14px">${title}</h3>
          <table>${items.map(([k, n]) => `<tr><td>${esc(label(k))}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${n}</td></tr>`).join('')}</table></div>`;
      const list = rows
        .map((x, i) => `<tr><td style="font-variant-numeric:tabular-nums">${i + 1}</td><td>${esc(x.full_name)}</td><td style="white-space:nowrap">${esc(displayPhone(x.phone) || '—')}</td><td style="white-space:nowrap">${esc(dmy(x.d))}</td><td>${esc(x.sede || '—')}</td><td>${esc(x.minister || '—')}</td></tr>`)
        .join('');
      page(
        req,
        res,
        'Reporte de bautizados',
        `<style>@media print{.flash{display:none}main .wrap{max-width:none}table{font-size:12px}tr{break-inside:avoid}a{color:inherit;text-decoration:none}.print-head{margin-top:0}}</style>
        <p class="no-print"><a href="/bautizados${qs(f) ? `?${esc(qs(f))}` : ''}">← Bautizados</a></p>
        <form class="toolbar no-print" method="get">
          <div><label>Desde</label><input type="date" name="desde" value="${esc(bz.parseDate(f.desde) || '')}"></div>
          <div><label>Hasta</label><input type="date" name="hasta" value="${esc(bz.parseDate(f.hasta) || '')}"></div>
          <div><label>Año</label><select name="anio">${opt(ys.map((y) => [y, y]), f.anio, 'Todos')}</select></div>
          <div><label>Sede</label><select name="sede">${opt(ss.map((s) => [s, s]), f.sede, 'Todas')}</select></div>
          <button class="sec">Ver</button>
          <button type="button" onclick="window.print()">${PRINTER}Imprimir</button></form>
        <h1 class="print-head">Reporte de bautizados</h1>
        <p class="sub">${esc(config.churchName)} · ${esc(scope)} · Impreso el ${esc(dmy(today()))}</p>
        <div class="grid">
          <div class="card"><div class="stat">${rows.length}</div><div class="stat-label">bautizados</div></div>
          <div class="card"><div class="stat">${rows.filter((x) => x.phone).length}</div><div class="stat-label">con teléfono</div></div>
        </div>
        ${rows.length ? chartsBlock(rows) : ''}
        ${rows.length ? `<div class="grid">${summary('Por fecha de bautismo', byDate, (k) => (k ? dmy(k) : 'Sin fecha'))}</div>` : ''}
        <div class="table-scroll"><table><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Bautismo</th><th>Sede</th><th>Bautizado por</th></tr>${
          list || '<tr><td colspan="6" class="muted">No hay bautizados con esos filtros.</td></tr>'
        }</table></div>`
      );
    })
  );

  /* ------------------------------ Completar teléfonos ------------------------------ */
  r.get(
    '/bautizados/telefonos',
    ah(async (req, res) => {
      const [sugg, missing] = await Promise.all([bz.phoneSuggestions(db), db.query('SELECT count(*)::int AS n FROM bautizados WHERE phone IS NULL')]);
      const n = missing.rows[0].n;
      const label = (sc) => (sc === 1 ? 'mismo nombre' : 'nombre parecido');
      const blocks = sugg
        .map(
          (b) => `<fieldset class="card" style="margin:0 0 12px">
            <legend style="font-weight:600;padding:0 4px">${esc(b.full_name)} <span class="muted" style="font-weight:400">· bautismo ${esc(dmy(b.d))}</span></legend>
            ${b.candidates
              .map(
                (c) => `<label class="check"><input type="radio" name="b_${b.id}" value="${esc(c.key)}">
                  <span><strong>${esc(c.name)}</strong> · <span style="white-space:nowrap">${esc(displayPhone(c.phone))}</span><br><span class="muted">${esc(c.source)}, ${label(c.score)}</span></span></label>`
              )
              .join('')}
            <label class="check"><input type="radio" name="b_${b.id}" value="" checked> <span>Ninguno: no es la misma persona o no estoy seguro</span></label>
          </fieldset>`
        )
        .join('');
      page(
        req,
        res,
        'Completar teléfonos',
        `<p><a href="/bautizados">← Bautizados</a></p><h1>Completar teléfonos</h1>
        <p class="sub">Hay ${n} bautizado${n === 1 ? '' : 's'} sin teléfono. Aquí salen solo los que tienen a alguien con el mismo nombre, o uno muy parecido, en <a href="/personas">Personas</a> o en <a href="/nueva-vida">Nueva Vida</a> (un apellido suelto no cuenta). Nada se guarda solo: elige el teléfono únicamente si estás seguro de que es la misma persona. Por defecto queda en "Ninguno".</p>
        ${
          sugg.length
            ? `<form method="post" action="/bautizados/telefonos">${blocks}<div class="actions"><button>Guardar los teléfonos elegidos</button><a class="btn sec" href="/bautizados">Cancelar</a></div></form>`
            : `<div class="flash ok">No hay sugerencias: nadie en Personas ni en Nueva Vida tiene el mismo nombre que los bautizados sin teléfono. Puedes agregarlos a mano desde la ficha de cada uno.</div>`
        }`
      );
    })
  );

  r.post(
    '/bautizados/telefonos',
    ah(async (req, res) => {
      const choices = {};
      for (const [k, v] of Object.entries(req.body)) {
        const m = /^b_(\d{1,9})$/.exec(k);
        if (m && /^[pn]:\d{1,9}$/.test(String(v))) choices[m[1]] = String(v);
      }
      if (!Object.keys(choices).length) return go(res, '/bautizados/telefonos', { err: 'No elegiste ningún teléfono.' });
      const out = await bz.applyPhones(db, choices);
      go(res, '/bautizados', { ok: `Teléfonos guardados: ${out.saved}.${out.ignored ? ` ${out.ignored} no se guardaron porque la sugerencia ya no era válida.` : ''}` });
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
