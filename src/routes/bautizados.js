'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const bz = require('../bautizados/store');
const charts = require('../views/charts');
const { parsePhoto } = require('../care-groups');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Reduce una imagen a JPEG de 900 px como máximo en el navegador (así no viaja la ubicación ni pesa de más). */
const REDUCE_JS = `function reduceImage(file, done) {
  var url = URL.createObjectURL(file), img = new Image();
  img.onload = function () {
    var s = Math.min(1, 900 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    done(null, c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = function () { URL.revokeObjectURL(url); done(new Error('No pude leer esa imagen.')); };
  img.src = url;
}`;

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
            <td>${x.photo_v ? `<img src="/bautizados/${x.id}/foto?v=${x.photo_v}" alt="" loading="lazy" width="36" height="36" style="float:left;margin:0 8px 0 0;border-radius:50%;object-fit:cover">` : ''}<a href="/bautizados/${x.id}">${esc(x.full_name)}</a></td>
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
          <a class="btn sec" href="/bautizados/fotos">Subir fotos</a>
          ${st.total > st.with_phone ? `<a class="btn sec" href="/bautizados/telefonos">Completar teléfonos (${st.total - st.with_phone} sin teléfono)</a>` : ''}</div>
        <div class="grid">
          <div class="card"><div class="stat">${st.total}</div><div class="stat-label">bautizados registrados</div></div>
          <div class="card"><div class="stat" style="color:var(--ok)">${st.this_year}</div><div class="stat-label">bautizados en ${year}</div></div>
          <div class="card"><div class="stat">${st.with_phone}</div><div class="stat-label">con teléfono</div></div>
          <div class="card"><div class="stat">${st.with_photo}</div><div class="stat-label">con foto</div></div>
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

  /* ------------------------------ Fotos ------------------------------ */
  function photoCard(x) {
    const src = x.photo_v ? `/bautizados/${x.id}/foto?v=${x.photo_v}` : '';
    return `<div class="card">
        <h3 style="margin:0 0 8px">Foto</h3>
        <img id="bz_prev" alt="Foto de ${esc(x.full_name)}" ${src ? `src="${src}"` : 'hidden'} style="display:block;width:100%;max-width:260px;aspect-ratio:1/1;object-fit:cover;border-radius:12px;border:1px solid var(--line);margin:0 0 10px">
        ${src ? '' : '<p class="muted" id="bz_none" style="margin:0 0 8px">Todavía no tiene foto.</p>'}
        <form method="post" action="/bautizados/${x.id}/foto" id="bz_form">
          <input type="hidden" name="photo_data" id="bz_data">
          <div class="actions" style="margin:0">
            <label class="btn sec" style="margin:0;cursor:pointer">Tomar foto<input id="bz_cam" type="file" accept="image/*" capture="environment" hidden></label>
            <label class="btn sec" style="margin:0;cursor:pointer">Elegir archivo<input id="bz_gal" type="file" accept="image/*" hidden></label>
            <button id="bz_save" hidden>Guardar foto</button>
          </div>
          <p id="bz_msg" class="muted" style="font-size:13px;margin:6px 0 0"></p>
        </form>
        ${src ? `<form method="post" action="/bautizados/${x.id}/foto/eliminar" onsubmit="return confirm('¿Quitar la foto de ${esc(x.full_name).replace(/'/g, '&#39;')}?')"><button class="danger small">Quitar foto</button></form>` : ''}
      </div>
      <script>
        ${REDUCE_JS}
        (function () {
          var data = document.getElementById('bz_data'), prev = document.getElementById('bz_prev'), msg = document.getElementById('bz_msg'), save = document.getElementById('bz_save');
          ['bz_cam', 'bz_gal'].forEach(function (id) {
            document.getElementById(id).addEventListener('change', function (e) {
              var f = e.target.files[0]; if (!f) return;
              msg.textContent = 'Preparando la foto…';
              reduceImage(f, function (err, url) {
                if (err) { msg.textContent = err.message; return; }
                data.value = url; prev.src = url; prev.hidden = false;
                var none = document.getElementById('bz_none'); if (none) none.hidden = true;
                save.hidden = false; msg.textContent = 'Revisa la foto y pulsa "Guardar foto".';
              });
            });
          });
        })();
      </script>`;
  }

  r.get(
    '/bautizados/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const buf = await bz.getPhoto(db, +req.params.id);
      if (!buf) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(buf);
    })
  );

  r.post(
    '/bautizados/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const id = +req.params.id;
      const json = String(req.get('accept') || '').includes('application/json');
      const reply = (status, out) => (json ? res.status(status).json(out) : go(res, `/bautizados/${id}`, out.ok ? { ok: out.ok } : { err: out.error }));
      const photo = parsePhoto(req.body.photo_data);
      if (photo.error) return reply(400, { error: photo.error });
      if (!photo.buffer) return reply(400, { error: 'No llegó ninguna foto.' });
      if (!(await bz.savePhoto(db, id, photo.buffer))) return reply(404, { error: 'No existe ese registro.' });
      reply(200, { ok: 'Foto guardada.' });
    })
  );

  r.post(
    '/bautizados/:id(\\d{1,9})/foto/eliminar',
    ah(async (req, res) => {
      await bz.deletePhoto(db, +req.params.id);
      go(res, `/bautizados/${+req.params.id}`, { ok: 'Foto quitada.' });
    })
  );

  /** Subir varias fotos a la vez: se emparejan por el nombre del archivo y se confirman antes de subir. */
  r.get(
    '/bautizados/fotos',
    ah(async (req, res) => {
      const targets = await bz.photoTargets(db);
      const json = JSON.stringify(targets.map((t) => ({ ...t, label: `${t.name}${t.d ? ` · ${dmy(t.d)}` : ''}${t.has ? ' (ya tiene foto)' : ''}` }))).replace(/</g, '\\u003c');
      page(
        req,
        res,
        'Subir fotos',
        `<p><a href="/bautizados">← Bautizados</a></p><h1>Subir fotos de bautizados</h1>
        <p class="sub">Elige varias fotos a la vez. Si cada archivo tiene el nombre de la persona (por ejemplo <span class="mono">Ana Torres.jpg</span>), se emparejan solos; si no, elige a quién corresponde cada una. Revisa la lista y pulsa "Subir". Las fotos se reducen en tu equipo antes de subir y solo se ven dentro del panel.</p>
        ${targets.length ? '' : '<div class="flash err">Primero registra a los bautizados: todavía no hay nadie a quien ponerle foto.</div>'}
        <div class="card">
          <label for="bz_files">Fotos</label><input id="bz_files" type="file" accept="image/*" multiple>
          <p id="bz_sum" class="muted" style="margin:8px 0 0"></p>
        </div>
        <div class="table-scroll"><table id="bz_tbl" hidden><thead><tr><th>Foto</th><th>Archivo</th><th>Es de</th><th>Estado</th></tr></thead><tbody></tbody></table></div>
        <div class="actions"><button id="bz_up" hidden>Subir fotos</button></div>
        <script type="application/json" id="bz_targets">${json}</script>
        <script>
          ${REDUCE_JS}
          (function () {
            var targets = JSON.parse(document.getElementById('bz_targets').textContent);
            var STOP = ${JSON.stringify(['de', 'del', 'la', 'las', 'los', 'y', 'img', 'foto', 'jpg', 'jpeg', 'png', 'heic', 'whatsapp', 'image', 'pm', 'am', 'at'])};
            function key(s) {
              return String(s).toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ')
                .split(' ').filter(function (t) { return t && !/^\\d+$/.test(t) && STOP.indexOf(t) < 0; }).join(' ');
            }
            var tbody = document.querySelector('#bz_tbl tbody'), up = document.getElementById('bz_up'), sum = document.getElementById('bz_sum'), rows = [];
            function options(sel) {
              return '<option value="">Elige a quién corresponde…</option>' + targets.map(function (t) {
                return '<option value="' + t.id + '"' + (String(t.id) === String(sel) ? ' selected' : '') + '>' + t.label.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</option>';
              }).join('');
            }
            function refresh() {
              var chosen = rows.filter(function (r) { return r.data && r.sel.value && !r.done; });
              var seen = {}, dup = false;
              rows.forEach(function (r) { if (r.sel.value && !r.done) { if (seen[r.sel.value]) dup = true; seen[r.sel.value] = 1; } });
              up.hidden = !chosen.length; up.disabled = dup;
              up.textContent = 'Subir ' + chosen.length + ' foto' + (chosen.length === 1 ? '' : 's');
              sum.textContent = dup ? 'Hay dos fotos asignadas a la misma persona: deja solo una.' : rows.length ? rows.length + ' archivo(s); ' + chosen.length + ' listo(s) para subir.' : '';
            }
            document.getElementById('bz_files').addEventListener('change', function (e) {
              Array.prototype.forEach.call(e.target.files, function (f) {
                var k = key(f.name.replace(/\\.[^.]+$/, '')), hits = targets.filter(function (t) { return t.key === k; });
                var tr = document.createElement('tr'), r = { data: null, done: false };
                tr.innerHTML = '<td><img alt="" width="56" height="56" style="border-radius:8px;object-fit:cover;background:var(--line)"></td><td class="mono" style="word-break:break-all"></td><td><select style="min-width:200px">' + options(hits.length === 1 ? hits[0].id : '') + '</select></td><td class="muted">Preparando…</td>';
                tr.children[1].textContent = f.name;
                r.sel = tr.querySelector('select'); r.img = tr.querySelector('img'); r.st = tr.children[3];
                r.sel.addEventListener('change', refresh);
                tbody.appendChild(tr); rows.push(r);
                reduceImage(f, function (err, url) {
                  if (err) { r.st.textContent = err.message; return; }
                  r.data = url; r.img.src = url;
                  r.st.textContent = hits.length === 1 ? 'Emparejada por el nombre del archivo' : hits.length > 1 ? 'Hay varias personas con ese nombre: elige' : 'Elige a quién corresponde';
                  refresh();
                });
              });
              document.getElementById('bz_tbl').hidden = false; e.target.value = ''; refresh();
            });
            up.addEventListener('click', async function () {
              up.disabled = true;
              for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (!r.data || !r.sel.value || r.done) continue;
                r.st.textContent = 'Subiendo…';
                try {
                  var resp = await fetch('/bautizados/' + r.sel.value + '/foto', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ photo_data: r.data }) });
                  var out = await resp.json().catch(function () { return {}; });
                  if (resp.ok) { r.done = true; r.sel.disabled = true; r.st.textContent = '✓ Guardada'; r.st.style.color = 'var(--ok)'; }
                  else { r.st.textContent = out.error || 'No se pudo subir.'; r.st.style.color = 'var(--bad)'; }
                } catch (err) { r.st.textContent = 'Sin conexión: vuelve a intentar.'; r.st.style.color = 'var(--bad)'; }
              }
              refresh();
              var left = rows.filter(function (r) { return r.data && r.sel.value && !r.done; }).length;
              sum.textContent = left ? 'Quedaron ' + left + ' sin subir: revisa el estado y vuelve a pulsar.' : 'Listo: todas las fotos elegidas quedaron guardadas.';
            });
          })();
        </script>`
      );
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
        ${photoCard(x)}
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
