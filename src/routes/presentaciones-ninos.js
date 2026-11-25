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
        <p class="sub">Registro de los niños presentados al Señor. Puedes agregarlos uno por uno aquí abajo o cargar una lista que ya tengas. Registrar aquí no crea personas en Personas ni suscribe a nadie a mensajes.</p>
        <div class="actions"><a class="btn" href="/presentacion-ninos/importar">Cargar una lista</a></div>
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

  /* ------------------------------ Cargar una lista ------------------------------ */
  function importPage(b, extra = '') {
    const t = (name, label, type = 'text', more = '') => `<div><label>${label}</label><input type="${type}" name="${name}" value="${esc(b[name] || '')}" ${more}></div>`;
    const sedeOpts = `<option value="">—</option>${pn.SEDES.map((s) => `<option value="${esc(s)}" ${b.sede === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
    return `<p><a href="/presentacion-ninos">← Presentación de Niños</a></p><h1>Cargar una lista de niños presentados</h1>
      <p class="sub">Primero se revisa, y nada se guarda hasta que pulses "Guardar". Puedes:</p>
      <ul class="sub">
        <li><strong>Pegar una lista simple:</strong> un nombre por línea.</li>
        <li><strong>Subir un archivo CSV</strong> (Excel o Google Sheets → Descargar como CSV) con estas columnas: <span class="mono">${esc(pn.TEMPLATE_HEADERS.join(', '))}</span>. Solo hace falta <span class="mono">nombre</span>.</li>
      </ul>
      <form method="post" class="card">
        <label>Archivo CSV</label><input type="file" accept=".csv,.txt,text/csv,text/plain" id="file">
        <label>O pega la lista aquí</label>
        <textarea name="csv" id="csv" style="min-height:160px" class="mono">${esc(b.csv || '')}</textarea>
        <p class="muted" style="font-size:13px;margin:10px 0 0">Para toda la lista (se usa cuando una fila no trae ese dato):</p>
        <div class="row">${t('presentation_date', 'Fecha de presentación', 'date', `max="${esc(today())}"`)}<div><label>Sede</label><select name="sede">${sedeOpts}</select></div>${t('presented_by', 'Presentado por')}${t('source', 'Nombre de la lista', 'text', 'placeholder="Ej.: Presentaciones 2025"')}</div>
        <div class="actions"><button name="accion" value="revisar">Revisar</button><a class="btn sec" href="/presentacion-ninos">Cancelar</a></div>
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

  r.get('/presentacion-ninos/importar', (req, res) => page(req, res, 'Cargar una lista', importPage({})));

  r.post(
    '/presentacion-ninos/importar',
    ah(async (req, res) => {
      const b = {};
      for (const k of ['csv', 'presentation_date', 'sede', 'presented_by', 'source']) b[k] = String(req.body[k] || '');
      const defaults = { presentation_date: b.presentation_date, sede: b.sede, presented_by: b.presented_by, source: b.source.trim() || 'Lista cargada' };
      const prep = await pn.prepareImport(db, b.csv, { today: today(), defaults });
      const errs = prep.fileErrors.concat(prep.records.flatMap((x) => x.errors.map((e) => `Línea ${x.line}: ${e}`)));
      if (req.body.accion === 'guardar' && !errs.length) {
        const s = await pn.applyImport(db, prep);
        return res.redirect(303, '/presentacion-ninos?ok=' + encodeURIComponent(`Lista cargada: ${s.saved} niños nuevos${s.skipped ? `, ${s.skipped} omitidos porque ya estaban o venían repetidos` : ''}.`));
      }
      const by = (st) => prep.records.filter((x) => x.status === st);
      const nuevos = by('nueva');
      const preview = nuevos
        .slice(0, 300)
        .map((x) => `<tr><td>${esc(x.value.child_name || '—')}</td><td>${esc(dmy(x.value.birth_date))}</td><td>${esc(dmy(x.value.presentation_date))}</td><td>${esc(x.value.sede || '—')}</td><td>${esc(x.value.parents || '—')}</td></tr>`)
        .join('');
      const summary = `<div class="grid">
        <div class="card"><div class="stat">${nuevos.length}</div><div class="stat-label">niños nuevos</div></div>
        <div class="card"><div class="stat">${by('ya_estaba').length + by('repetida').length}</div><div class="stat-label">se omiten (ya estaban o repetidos)</div></div></div>
        <p class="muted">${prep.mode === 'csv' ? 'Se leyó como archivo con columnas.' : 'Se leyó como lista simple: un nombre por línea.'}${prep.unknown.length ? ` Columnas ignoradas: ${esc(prep.unknown.join(', '))}.` : ''}</p>`;
      const hidden = Object.entries(b).map(([k, v]) => (k === 'csv' ? `<textarea name="csv" hidden>${esc(v)}</textarea>` : `<input type="hidden" name="${k}" value="${esc(v)}">`)).join('');
      const body = errs.length
        ? `${summary}<div class="flash err"><strong>No se puede guardar todavía.</strong> Corrige esto y vuelve a revisar:<br>${errs.slice(0, 40).map(esc).join('<br>')}${errs.length > 40 ? `<br>… y ${errs.length - 40} más.` : ''}</div>`
        : `${summary}${nuevos.length ? `<div class="table-scroll"><table><tr><th>Niño</th><th>Nacimiento</th><th>Presentación</th><th>Sede</th><th>Padres</th></tr>${preview}</table></div>${nuevos.length > 300 ? `<p class="muted">… y ${nuevos.length - 300} más.</p>` : ''}
           <form method="post">${hidden}<div class="actions"><button name="accion" value="guardar">Guardar ${nuevos.length} niños</button></div></form>` : '<div class="flash ok">No hay ningún niño nuevo para guardar.</div>'}`;
      page(req, res, 'Cargar una lista', importPage(b, body));
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
