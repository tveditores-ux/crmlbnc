'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const nv = require('../nuevavida/store');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Pestaña Nueva Vida: lista de nuevos creyentes, con carga de archivos y conexión a consolidación. */
function nuevaVidaRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/nueva-vida', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    next();
  });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/nueva-vida', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const idList = (v) => [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String).filter((x) => /^\d{1,9}$/.test(x)).map(Number))].slice(0, 500);

  /* ------------------------------ Lista ------------------------------ */
  r.get(
    '/nueva-vida',
    ah(async (req, res) => {
      const f = {
        fuente: String(req.query.fuente || ''), conexion: String(req.query.conexion || ''), revisar: String(req.query.revisar || ''),
        telefono: String(req.query.telefono || ''), mes: String(req.query.mes || ''), q: String(req.query.q || ''),
      };
      const [rows, st, opts] = await Promise.all([nv.list(db, f), nv.stats(db), nv.filterOptions(db)]);
      const opt = (items, cur, empty) => `<option value="">${esc(empty)}</option>${items.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
      const list = rows
        .map((x) => {
          const state = x.consolidation_id
            ? `<a class="badge b-ok" href="/consolidacion/${x.consolidation_id}">En consolidación${x.historical ? ' (histórica)' : ''}</a>`
            : '<span class="badge b-muted">Sin conectar</span>';
          return `<tr>
            <td>${x.consolidation_id ? '' : `<input type="checkbox" name="ids" value="${x.id}" aria-label="Elegir a ${esc(x.full_name)}">`}</td>
            <td><a href="/nueva-vida/${x.id}">${esc(x.full_name)}</a>${x.needs_review ? ' <span class="badge b-warn" title="' + esc(x.review_note) + '">Revisar</span>' : ''}</td>
            <td>${esc(displayPhone(x.phone) || '—')}</td>
            <td>${esc(dmy(x.d))}${x.date_note ? ` <span class="muted" title="${esc(x.date_note)}">ⓘ</span>` : ''}</td>
            <td class="muted">${esc(x.source)}</td>
            <td>${state}</td>
            <td><a class="btn sec small" href="/nueva-vida/${x.id}">Abrir</a></td></tr>`;
        })
        .join('');
      page(
        req,
        res,
        'Nueva Vida',
        `<h1>Nueva Vida</h1>
        <p class="sub">Lista de nuevos creyentes. Desde aquí se conecta cada persona con <a href="/consolidacion">Consolidación</a> cuando se quiera darle seguimiento. Contiene datos personales: solo la ven los administradores.</p>
        <div class="actions"><a class="btn" href="/nueva-vida/nueva">Registrar nuevo creyente</a>
          <a class="btn sec" href="/nueva-vida/importar">Cargar un archivo</a></div>
        <div class="grid">
          <div class="card"><div class="stat">${st.total}</div><div class="stat-label">personas registradas</div></div>
          <div class="card"><div class="stat">${st.with_phone}</div><div class="stat-label">con teléfono</div></div>
          <div class="card"><div class="stat" style="color:var(--ok)">${st.connected}</div><div class="stat-label">conectadas a consolidación</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${st.review}</div><div class="stat-label">por revisar</div></div>
        </div>
        <form class="toolbar" method="get">
          <div><label>Buscar</label><input type="search" name="q" value="${esc(f.q)}" placeholder="Nombre o teléfono"></div>
          <div><label>Fuente</label><select name="fuente">${opt(opts.sources.map((s) => [s, s]), f.fuente, 'Todas')}</select></div>
          <div><label>Mes</label><select name="mes">${opt(opts.months.map((m) => [m, m]), f.mes, 'Todos')}</select></div>
          <div><label>Conexión</label><select name="conexion">${opt([['sin_conectar', 'Sin conectar'], ['conectada', 'Conectadas']], f.conexion, 'Todas')}</select></div>
          <div><label>Revisión</label><select name="revisar">${opt([['si', 'Por revisar']], f.revisar, 'Todas')}</select></div>
          <div><label>Teléfono</label><select name="telefono">${opt([['sin', 'Sin teléfono']], f.telefono, 'Todos')}</select></div>
          <button class="sec">Filtrar</button></form>
        <form method="post" action="/nueva-vida/conectar">
          <div class="card toolbar" style="align-items:center">
            <label class="check" style="margin:0"><input type="checkbox" id="all"> Elegir todas las de la lista</label>
            <label class="check" style="margin:0"><input type="checkbox" name="historical" value="1" checked> Conectar como históricas (sin etapas confiables; no cuentan en el embudo)</label>
            <button>Conectar las elegidas a consolidación</button></div>
          <p class="muted" style="font-size:13px">Las que tengan un nombre parecido al de alguien ya registrado, o no tengan fecha o nombre legible, no se conectan en bloque: ábrelas una por una.</p>
          <h2>Personas (${rows.length})</h2>
          <div class="table-scroll"><table><tr><th></th><th>Nombre</th><th>Teléfono</th><th>Decisión</th><th>Fuente</th><th>Estado</th><th></th></tr>${
            list || '<tr><td colspan="7" class="muted">No hay nadie con esos filtros.</td></tr>'
          }</table></div>
        </form>
        <script>document.getElementById('all').addEventListener('change',function(e){document.querySelectorAll('input[name=ids]').forEach(function(c){c.checked=e.target.checked;});});</script>`
      );
    })
  );

  r.post(
    '/nueva-vida/conectar',
    ah(async (req, res) => {
      const ids = idList(req.body.ids);
      if (!ids.length) return go(res, '/nueva-vida', { err: 'Elige al menos una persona.' });
      const s = await nv.connectMany(db, ids, { historical: req.body.historical === '1', countryCode: config.defaultCountryCode });
      const parts = [`${s.conectada} conectadas`];
      if (s.confirmar) parts.push(`${s.confirmar} piden confirmar el nombre (ábrelas una por una)`);
      if (s.sin_fecha) parts.push(`${s.sin_fecha} sin fecha`);
      if (s.sin_nombre) parts.push(`${s.sin_nombre} sin nombre legible`);
      if (s.ya_conectada) parts.push(`${s.ya_conectada} ya estaban conectadas`);
      go(res, '/nueva-vida', { ok: parts.join(', ') + '.' });
    })
  );

  /* ------------------------------ Cargar archivo ------------------------------ */
  function importPage(text, extra = '') {
    return `<h1>Cargar un archivo a Nueva Vida</h1>
      <p class="sub">Primero se revisa, y nada se guarda hasta el final. Las personas que ya estaban (mismo teléfono, o mismo nombre y fecha) se omiten.
        Columnas: <span class="mono">${esc(nv.TEMPLATE_HEADERS.join(', '))}</span>. Solo hace falta <span class="mono">nombre</span>.</p>
      <form method="post" class="card" id="imp">
        <label>Archivo CSV</label><input type="file" accept=".csv,text/csv" id="file">
        <label>O pega el contenido aquí</label>
        <textarea name="csv" id="csv" style="min-height:140px" class="mono">${esc(text || '')}</textarea>
        <div class="actions"><button name="accion" value="revisar">Revisar</button><a class="btn sec" href="/nueva-vida">Cancelar</a></div>
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

  r.get('/nueva-vida/importar', (req, res) => page(req, res, 'Cargar archivo', importPage('')));

  r.post(
    '/nueva-vida/importar',
    ah(async (req, res) => {
      const text = String(req.body.csv || '');
      const prep = await nv.prepareImport(db, text, config.defaultCountryCode, today());
      const errs = prep.fileErrors.map((e) => `Archivo: ${e}`).concat(prep.records.flatMap((x) => x.errors.map((e) => `Línea ${x.line}: ${e}`)));
      if (req.body.accion === 'guardar' && !errs.length) {
        const s = await nv.applyImport(db, prep);
        return go(res, '/nueva-vida', { ok: `Carga lista: ${s.saved} personas nuevas${s.skipped ? `, ${s.skipped} omitidas porque ya estaban o venían repetidas` : ''}.` });
      }
      const by = (st) => prep.records.filter((x) => x.status === st);
      const review = by('nueva').filter((x) => x.value.needs_review).length;
      const summary = `<div class="grid">
        <div class="card"><div class="stat">${by('nueva').length}</div><div class="stat-label">personas nuevas</div></div>
        <div class="card"><div class="stat">${by('ya_estaba').length + by('repetida').length}</div><div class="stat-label">se omiten (ya estaban o repetidas)</div></div>
        <div class="card"><div class="stat" style="color:var(--warn)">${review}</div><div class="stat-label">quedarán marcadas para revisar</div></div></div>`;
      const body = errs.length
        ? `${summary}<div class="flash err"><strong>No se puede guardar todavía.</strong> Corrige esto en el archivo y vuelve a revisar:<br>${errs.slice(0, 40).map(esc).join('<br>')}${errs.length > 40 ? `<br>… y ${errs.length - 40} más.` : ''}</div>`
        : `${summary}${prep.unknown.length ? `<p class="muted">Columnas ignoradas: ${esc(prep.unknown.join(', '))}.</p>` : ''}
           <form method="post"><textarea name="csv" hidden>${esc(text)}</textarea><div class="actions"><button name="accion" value="guardar">Guardar ${by('nueva').length} personas</button></div></form>`;
      page(req, res, 'Cargar archivo', importPage(text, body));
    })
  );

  /* ------------------------------ Ficha ------------------------------ */
  function form(v, action, errors = []) {
    const t = (name, label, type = 'text', extra = '') => `<div><label>${label}</label><input type="${type}" name="${name}" value="${esc(v[name] ?? '')}" ${extra}></div>`;
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" action="${action}" class="card">
        <div class="row">${t('name', 'Nombre completo', 'text', 'required')}${t('phone', 'WhatsApp', 'tel')}${t('email', 'Correo', 'email')}</div>
        <div class="row">${t('decision_date', 'Fecha de la decisión', 'date', `max="${esc(today())}"`)}${t('sede', 'Sede')}${t('age', 'Edad', 'number', 'min="0" max="120"')}${t('civil_status', 'Estado civil')}</div>
        <div class="row">${t('address', 'Dirección (dato sensible)')}${t('how_arrived', 'Cómo llegó a la congregación')}</div>
        <label>Seguimiento</label><textarea name="followup">${esc(v.followup || '')}</textarea>
        <label>Nota</label><textarea name="note">${esc(v.note || '')}</textarea>
        <label class="check"><input type="checkbox" name="needs_review" value="si" ${v.needs_review ? 'checked' : ''}> Marcar para revisar</label>
        <div class="row">${t('review_note', 'Qué hay que revisar')}</div>
        <div class="actions"><button>Guardar</button><a class="btn sec" href="/nueva-vida">Cancelar</a></div>
      </form>`;
  }
  const fromRecord = (x) => ({ name: x.full_name === nv.PLACEHOLDER ? '' : x.full_name, phone: x.phone ? displayPhone(x.phone) : '', email: x.email, decision_date: x.d, sede: x.sede, age: x.age, civil_status: x.civil_status, address: x.address, how_arrived: x.how_arrived, followup: x.followup, note: x.note, needs_review: x.needs_review, review_note: x.review_note });

  r.get('/nueva-vida/nueva', (req, res) => page(req, res, 'Registrar nuevo creyente', `<h1>Registrar nuevo creyente</h1>${form({ decision_date: today() }, '/nueva-vida')}`));
  r.post(
    '/nueva-vida',
    ah(async (req, res) => {
      const out = await nv.save(db, null, req.body, config.defaultCountryCode, today());
      if (out.errors) return page(req, res, 'Registrar nuevo creyente', `<h1>Registrar nuevo creyente</h1>${form(req.body, '/nueva-vida', out.errors)}`);
      go(res, `/nueva-vida/${out.id}`, { ok: 'Registrado.' });
    })
  );

  r.get(
    '/nueva-vida/:id(\\d{1,9})',
    ah(async (req, res) => {
      const x = await nv.get(db, +req.params.id);
      if (!x) return go(res, '/nueva-vida', { err: 'No existe ese registro.' });
      const connect = x.consolidation_id
        ? `<div class="card"><strong>En consolidación${x.historical ? ' (histórica)' : ''}</strong> · <a href="/consolidacion/${x.consolidation_id}">Abrir su ficha de consolidación</a>${x.person_name ? ` · Persona: ${esc(x.person_name)}` : ''}</div>`
        : `<form method="post" action="/nueva-vida/${x.id}/conectar" class="card">
            <strong>Conectar con consolidación</strong>
            <p class="muted" style="margin:4px 0">Busca si la persona ya está registrada en el CRM (por teléfono) y, si no, la crea sin consentimiento para mensajes.${x.full_name === nv.PLACEHOLDER ? ' <strong>Primero corrige el nombre.</strong>' : ''}${x.d ? '' : ' <strong>Primero escribe la fecha de la decisión.</strong>'}</p>
            <label class="check"><input type="checkbox" name="historical" value="1" checked> Histórica (sin etapas confiables; no cuenta en el embudo)</label>
            <div class="actions"><button>Conectar a consolidación</button></div></form>`;
      page(
        req,
        res,
        x.full_name,
        `<h1>${esc(x.full_name)} ${x.needs_review ? '<span class="badge b-warn">Por revisar</span>' : ''}</h1>
        <p class="sub">Fuente: ${esc(x.source)}${x.date_note ? ` · ${esc(x.date_note)}` : ''}${x.age !== null && x.age < 18 ? ' · <span class="badge b-warn">Menor de edad: tratar con especial cuidado</span>' : ''}</p>
        ${connect}
        ${x.raw_text ? `<details class="card"><summary>Texto original de la lista</summary><pre>${esc(x.raw_text)}</pre></details>` : ''}
        ${form(fromRecord(x), `/nueva-vida/${x.id}`)}
        <form method="post" action="/nueva-vida/${x.id}/eliminar" onsubmit="return confirm('¿Borrar este registro de Nueva Vida? Si ya estaba conectada, su consolidación y su ficha de persona no se borran. No se puede deshacer.')">
          <button class="danger small">Borrar este registro</button></form>`
      );
    })
  );
  r.post(
    '/nueva-vida/:id(\\d{1,9})',
    ah(async (req, res) => {
      const id = +req.params.id;
      const out = await nv.save(db, id, req.body, config.defaultCountryCode, today());
      if (out.errors) {
        const x = await nv.get(db, id);
        if (!x) return go(res, '/nueva-vida', { err: 'No existe ese registro.' });
        return page(req, res, x.full_name, `<h1>${esc(x.full_name)}</h1>${form(req.body, `/nueva-vida/${id}`, out.errors)}`);
      }
      go(res, `/nueva-vida/${id}`, { ok: 'Guardado.' });
    })
  );
  r.post(
    '/nueva-vida/:id(\\d{1,9})/eliminar',
    ah(async (req, res) => {
      await nv.remove(db, +req.params.id);
      go(res, '/nueva-vida', { ok: 'Registro borrado.' });
    })
  );

  const MSG = {
    ya_conectada: 'Esa persona ya estaba conectada a consolidación.',
    sin_fecha: 'Falta la fecha de la decisión: escríbela y vuelve a intentar.',
    sin_nombre: 'No se pudo leer el nombre: corrígelo y vuelve a intentar.',
    no_existe: 'No existe ese registro.',
    eleccion_no_valida: 'Elección no válida.',
  };
  r.post(
    '/nueva-vida/:id(\\d{1,9})/conectar',
    ah(async (req, res) => {
      const id = +req.params.id;
      const historical = req.body.historical === '1';
      const out = await nv.connectOne(db, id, { historical, choice: String(req.body.choice || ''), countryCode: config.defaultCountryCode });
      if (out.status === 'conectada') return go(res, `/consolidacion/${out.consolidationId}`, { ok: 'Conectada a consolidación.' });
      if (out.status === 'confirmar') {
        const cand = out.candidates
          .map((c, i) => `<label class="check"><input type="radio" name="choice" value="${c.id}" ${i === 0 ? 'required' : ''}> Es ${esc(c.full_name)} <span class="muted">${esc(displayPhone(c.phone) || 'sin teléfono')}</span></label>`)
          .join('');
        return page(
          req,
          res,
          'Confirmar persona',
          `<h1>¿Ya la tenemos registrada?</h1>
          <p class="sub">Hay personas con un nombre parecido. Confirma si es alguna de ellas o si es una persona nueva. No se une a nadie sin que lo confirmes.</p>
          <form method="post" action="/nueva-vida/${id}/conectar" class="card">
            ${historical ? '<input type="hidden" name="historical" value="1">' : ''}${cand}
            <label class="check"><input type="radio" name="choice" value="nueva"> Es una persona nueva</label>
            <div class="actions"><button>Continuar</button><a class="btn sec" href="/nueva-vida/${id}">Volver</a></div></form>`
        );
      }
      go(res, `/nueva-vida/${id}`, { err: MSG[out.status] || 'No se pudo conectar.' });
    })
  );

  return r;
}

module.exports = { nuevaVidaRouter };
