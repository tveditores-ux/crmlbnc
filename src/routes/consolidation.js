'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const charts = require('../views/charts');
const { esc } = require('../util');
const { displayPhone, normalizePhone } = require('../phone');
const { toCsv } = require('../csv');
const { tx } = require('../db');
const { classify } = require('../consolidation/match');
const { STAGES, STATUSES, LOST_REASONS, CALL_RESULTS, parseDate, currentStage } = require('../consolidation/stages');
const store = require('../consolidation/store');
const importer = require('../consolidation/importer');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STATUS_BADGE = { activo: 'b-ok', en_pausa: 'b-warn', perdido: 'b-bad' };

/** Consolidación de nuevos creyentes: tablero, ficha, registro de decisiones e importación. */
function consolidationRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/consolidacion', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const badge = (status, reason) =>
    `<span class="badge ${STATUS_BADGE[status] || 'b-muted'}">${esc(STATUSES[status] || status)}</span>${reason ? `<div class="muted" style="font-size:12px">${esc(LOST_REASONS[reason] || reason)}</div>` : ''}`;
  const options = (items, sel, empty) =>
    `${empty !== undefined ? `<option value="">${esc(empty)}</option>` : ''}${items
      .map((i) => `<option value="${esc(i.value)}" ${String(sel) === String(i.value) ? 'selected' : ''}>${esc(i.label)}</option>`)
      .join('')}`;

  /* ------------------------------ Tablero ------------------------------ */
  r.get(
    '/consolidacion',
    ah(async (req, res) => {
      const f = {
        sede: String(req.query.sede || ''),
        status: String(req.query.estado || ''),
        responsable: String(req.query.responsable || ''),
        mes: String(req.query.mes || ''),
      };
      const etapa = STAGES.some((s) => s.key === req.query.etapa) ? req.query.etapa : '';
      const [fun, rowsAll, opts] = await Promise.all([store.funnel(db, f), store.list(db, f), store.filterOptions(db)]);
      const rows = etapa ? rowsAll.filter((x) => currentStage(x).key === etapa) : rowsAll;
      const total = fun[0].count;
      const kpi = { activo: 0, en_pausa: 0, perdido: 0 };
      rowsAll.forEach((x) => kpi[x.status]++);
      const funnelRows = fun
        .map((s) => `<tr><td>${esc(s.label)}</td><td>${s.count}</td><td>${total ? Math.round((s.count / total) * 100) : 0}%</td></tr>`)
        .join('');
      const list = rows
        .map(
          (x) => `<tr>
          <td><a href="/consolidacion/${x.id}">${esc(x.full_name)}</a><div class="muted" style="font-size:12px">${esc(displayPhone(x.phone) || 'sin teléfono')}</div></td>
          <td>${esc(dmy(x.decision_iso))}<div class="muted" style="font-size:12px">hace ${x.days} días</div></td>
          <td>${esc(x.sede)}</td>
          <td><span class="chip">${esc(currentStage(x).label)}</span></td>
          <td>${esc(x.responsible_name || '—')}</td>
          <td>${badge(x.status, x.lost_reason)}</td>
          <td><a class="btn sec small" href="/consolidacion/${x.id}">Ver</a></td></tr>`
        )
        .join('');
      const sel = (name, items, current, empty) => `<select name="${name}">${options(items, current, empty)}</select>`;
      page(
        req,
        res,
        'Consolidación',
        `<h1>Consolidación de nuevos creyentes</h1>
        <p class="sub">Seguimiento de cada persona desde que decide seguir a Cristo hasta que queda conectada con un grupo y con el riel.</p>
        <div class="actions"><a class="btn" href="/consolidacion/nueva">Registrar decisión</a>
          <a class="btn sec" href="/consolidacion/importar">Importar lista de Nueva Vida</a></div>
        <div class="grid">
          <div class="card"><div class="stat">${total}</div><div class="stat-label">personas en esta vista</div></div>
          <div class="card"><div class="stat" style="color:var(--ok)">${kpi.activo}</div><div class="stat-label">activas</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${kpi.en_pausa}</div><div class="stat-label">en pausa</div></div>
          <div class="card"><div class="stat" style="color:var(--bad)">${kpi.perdido}</div><div class="stat-label">perdidas</div></div>
        </div>
        <form class="toolbar" method="get">
          <div><label>Etapa actual</label>${sel('etapa', STAGES.map((s) => ({ value: s.key, label: s.label })), etapa, 'Todas')}</div>
          <div><label>Sede</label>${sel('sede', opts.sedes.map((s) => ({ value: s, label: s })), f.sede, 'Todas')}</div>
          <div><label>Responsable</label>${sel('responsable', opts.responsibles.map((x) => ({ value: x.id, label: x.full_name })), f.responsable, 'Todos')}</div>
          <div><label>Estado</label>${sel('estado', Object.entries(STATUSES).map(([k, v]) => ({ value: k, label: v })), f.status, 'Todos')}</div>
          <div><label>Mes de la decisión</label>${sel('mes', opts.months.map((m) => ({ value: m, label: m })), f.mes, 'Todos')}</div>
          <button class="sec">Filtrar</button></form>
        <div class="charts">
          <div class="card wide"><h3 style="margin-top:0">Embudo: cuántas personas llegaron a cada etapa</h3>${charts.hBarChart(
            fun.map((s) => ({ label: s.label, value: s.count })),
            { title: 'Personas que llegaron a cada etapa del proceso', color: '#2f5d62' }
          )}
            <div class="table-scroll" style="margin-top:12px"><table><tr><th>Etapa</th><th>Personas</th><th>Del total que decidió</th></tr>${funnelRows}</table></div></div>
        </div>
        <h2>Personas (${rows.length})</h2>
        <div class="table-scroll"><table><tr><th>Persona</th><th>Decisión</th><th>Sede</th><th>Etapa actual</th><th>Responsable</th><th>Estado</th><th></th></tr>${
          list || '<tr><td colspan="7" class="muted">Todavía no hay nadie en consolidación. Registra una decisión o importa la lista de Nueva Vida.</td></tr>'
        }</table></div>`
      );
    })
  );

  /* -------------------------- Registrar una decisión -------------------------- */
  async function decisionForm(v = {}, errors = []) {
    const vols = await store.nuevaVidaPeople(db);
    const sedes = (await db.query(`SELECT DISTINCT sede FROM service_attendance WHERE sede NOT LIKE '%,%' ORDER BY sede`)).rows.map((x) => x.sede);
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" action="/consolidacion/nueva" class="card">
        <div class="row">
          <div><label>Nombre completo</label><input type="text" name="name" required value="${esc(v.name || '')}"></div>
          <div><label>WhatsApp</label><input type="tel" name="phone" value="${esc(v.phone || '')}" placeholder="0414-1234567"></div>
        </div>
        <div class="row">
          <div><label>Fecha de la decisión</label><input type="date" name="decision_date" required max="${esc(today())}" value="${esc(v.decision_date || today())}"></div>
          <div><label>Sede</label><input type="text" name="sede" list="sedes" value="${esc(v.sede || '')}" placeholder="Las Mercedes"><datalist id="sedes">${sedes.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
        </div>
        <div class="row">
          <div><label>Quién la invitó (opcional)</label><input type="text" name="invited_by" value="${esc(v.invited_by || '')}"></div>
          <div><label>Responsable de Nueva Vida</label><select name="assigned_to">${options(vols.map((x) => ({ value: x.id, label: x.full_name })), v.assigned_to, 'Sin asignar')}</select></div>
        </div>
        <p class="muted" style="font-size:13px">Registrarla aquí no la activa para recibir mensajes: su consentimiento sigue igual.</p>
        <div class="actions"><button>Guardar</button><a class="btn sec" href="/consolidacion">Cancelar</a></div>
      </form>`;
  }

  r.get('/consolidacion/nueva', ah(async (req, res) => page(req, res, 'Registrar decisión', `<h1>Registrar decisión</h1>${await decisionForm()}`)));

  r.post(
    '/consolidacion/nueva',
    ah(async (req, res) => {
      const b = req.body;
      const { value, errors } = importer.validateRow({
        name: b.name, phone: b.phone, decision_date: b.decision_date, sede: b.sede, invited_by: b.invited_by,
      });
      if (value.decision_date && value.decision_date > today()) errors.push('La fecha de la decisión no puede ser futura.');
      const assigned = /^\d+$/.test(b.assigned_to || '') ? +b.assigned_to : null;
      if (errors.length) return page(req, res, 'Registrar decisión', `<h1>Registrar decisión</h1>${await decisionForm(b, errors)}`);

      const people = (await db.query('SELECT id, full_name, phone FROM people')).rows;
      const cls = classify({ name: value.name, phone: value.phone }, people, config.defaultCountryCode);
      const phone = normalizePhone(value.phone, config.defaultCountryCode);
      let personId;
      if (cls.group === 'existe') {
        personId = cls.person.id;
      } else if (cls.group === 'posible') {
        const choice = String(b.choice || '');
        if (!choice) {
          // Sin confirmación no se une a nadie: se pregunta.
          const cand = cls.candidates
            .map(
              (c, i) => `<label class="check"><input type="radio" name="choice" value="${c.person.id}" ${i === 0 ? 'required' : ''}> Es ${esc(c.person.full_name)}
                <span class="muted">${esc(displayPhone(c.person.phone) || 'sin teléfono')}</span></label>`
            )
            .join('');
          const hidden = ['name', 'phone', 'decision_date', 'sede', 'invited_by', 'assigned_to'].map((k) => `<input type="hidden" name="${k}" value="${esc(b[k] || '')}">`).join('');
          return page(
            req,
            res,
            'Confirmar persona',
            `<h1>¿Ya la tenemos registrada?</h1>
            <p class="sub">Hay personas con un nombre parecido a «${esc(value.name)}». Confirma si es alguna de ellas o si es una persona nueva.</p>
            <form method="post" action="/consolidacion/nueva" class="card">${hidden}${cand}
              <label class="check"><input type="radio" name="choice" value="nueva"> Es una persona nueva</label>
              <div class="actions"><button>Continuar</button><a class="btn sec" href="/consolidacion/nueva">Volver</a></div></form>`
          );
        }
        if (choice === 'nueva') personId = await importer.createPerson(db, value, phone);
        else if (cls.candidates.some((c) => String(c.person.id) === choice)) personId = +choice;
        else return go(res, '/consolidacion/nueva', { err: 'Elección no válida.' });
      } else {
        personId = await importer.createPerson(db, value, phone);
      }
      const dup = (await db.query('SELECT id FROM consolidation WHERE person_id = $1', [personId])).rows[0];
      if (dup) return go(res, `/consolidacion/${dup.id}`, { err: 'Esa persona ya estaba en consolidación. Aquí está su ficha.' });
      const out = await store.upsertConsolidation(db, personId, { ...value, assigned_to: assigned });
      go(res, `/consolidacion/${out.id}`, { ok: 'Decisión registrada.' });
    })
  );

  /* ------------------------------ Importar ------------------------------ */
  r.get('/consolidacion/plantilla.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-consolidacion.csv"');
    res.send(
      toCsv([
        importer.TEMPLATE_HEADERS,
        ['Persona de ejemplo', '0414-1234567', '2026-10-05', 'Las Mercedes', 'Una amiga', 'Nombre del voluntario', '2026-10-07', '', '', '', '', '', '', '', '', ''],
      ])
    );
  });

  function importPage(csvText, extra = '') {
    return `<h1>Importar lista de Nueva Vida</h1>
      <p class="sub">Sube el archivo, revisa a quién coincide con personas que ya existen y luego guarda. Nada se guarda hasta el final.
        Columnas obligatorias: <span class="mono">nombre, fecha_decision</span>. Opcionales: <span class="mono">${esc(importer.TEMPLATE_HEADERS.filter((h) => !['nombre', 'fecha_decision'].includes(h)).join(', '))}</span>.
        Las fechas van como 2026-10-05 o 5/10/2026.</p>
      <div class="actions"><a class="btn sec small" href="/consolidacion/plantilla.csv">Descargar plantilla</a></div>
      <form method="post" class="card" id="imp">
        <label>Archivo CSV</label><input type="file" accept=".csv,text/csv" id="file">
        <label>O pega el contenido aquí</label>
        <textarea name="csv" id="csv" style="min-height:160px" class="mono">${esc(csvText || '')}</textarea>
        <div class="actions"><button name="accion" value="revisar">Revisar</button><a class="btn sec" href="/consolidacion">Cancelar</a></div>
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

  r.get('/consolidacion/importar', (req, res) => page(req, res, 'Importar', importPage('')));

  function previewHtml(prep, text) {
    const errs = prep.fileErrors.map((e) => `Archivo: ${e}`).concat(prep.records.flatMap((x) => x.errors.map((e) => `Línea ${x.line}: ${e}`)));
    const grp = (g) => prep.records.filter((x) => x.group === g && !x.errors.length);
    const existe = grp('existe');
    const posible = grp('posible');
    const nueva = grp('nueva');
    const warn = (x) => (x.warnings.length ? `<div class="muted" style="font-size:12px">${x.warnings.map(esc).join('<br>')}</div>` : '');
    const summary = `<div class="grid">
      <div class="card"><div class="stat">${existe.length}</div><div class="stat-label">ya existen (mismo teléfono)</div></div>
      <div class="card"><div class="stat" style="color:var(--warn)">${posible.length}</div><div class="stat-label">posible coincidencia: confirmar</div></div>
      <div class="card"><div class="stat">${nueva.length}</div><div class="stat-label">personas nuevas</div></div></div>`;
    if (errs.length) {
      return `${summary}<div class="flash err"><strong>No se puede guardar todavía.</strong> Corrige esto en el archivo y vuelve a revisar:<br>${errs.slice(0, 40).map(esc).join('<br>')}${errs.length > 40 ? `<br>… y ${errs.length - 40} más.` : ''}</div>`;
    }
    const tExiste = existe.length
      ? `<h2>Ya existen (mismo teléfono)</h2><p class="muted">Se usará la ficha que ya existe. No se crea a nadie.</p><div class="table-scroll"><table><tr><th>Línea</th><th>En el archivo</th><th>Ya registrada como</th></tr>${existe
          .map((x) => `<tr><td>${x.line}</td><td>${esc(x.value.name)}${warn(x)}</td><td>${esc(x.person.full_name)}<div class="muted" style="font-size:12px">${esc(displayPhone(x.person.phone))}</div></td></tr>`)
          .join('')}</table></div>`
      : '';
    const tPosible = posible.length
      ? `<h2>Posible coincidencia: confirma cada una</h2><p class="muted">El nombre se parece al de alguien que ya está registrada. Elige si es la misma persona o si es nueva. No se une a nadie sin que lo confirmes.</p><div class="table-scroll"><table><tr><th>Línea</th><th>En el archivo</th><th>Elige</th></tr>${posible
          .map(
            (x) => `<tr><td>${x.line}</td><td>${esc(x.value.name)}<div class="muted" style="font-size:12px">${esc(displayPhone(x.value.phone) || 'sin teléfono')}</div>${warn(x)}</td><td>${x.candidates
              .map((c, i) => `<label class="check"><input type="radio" name="d_${x.line}" value="${c.person.id}" ${i === 0 ? 'required' : ''}> Es ${esc(c.person.full_name)} <span class="muted">${esc(displayPhone(c.person.phone) || 'sin teléfono')}</span></label>`)
              .join('')}<label class="check"><input type="radio" name="d_${x.line}" value="nueva"> Es una persona nueva</label></td></tr>`
          )
          .join('')}</table></div>`
      : '';
    const tNueva = nueva.length
      ? `<h2>Personas nuevas</h2><p class="muted">Se crean sin consentimiento para mensajes.</p><div class="table-scroll"><table><tr><th>Línea</th><th>Nombre</th><th>Teléfono</th><th>Decisión</th><th>Sede</th></tr>${nueva
          .map((x) => `<tr><td>${x.line}</td><td>${esc(x.value.name)}${warn(x)}</td><td>${esc(displayPhone(x.phone) || '—')}</td><td>${esc(dmy(x.value.decision_date))}</td><td>${esc(x.value.sede)}</td></tr>`)
          .join('')}</table></div>`
      : '';
    return `${summary}<form method="post">
      <textarea name="csv" hidden>${esc(text)}</textarea>
      ${tExiste}${tPosible}${tNueva}
      <div class="actions"><button name="accion" value="guardar">Guardar todo</button></div></form>`;
  }

  r.post(
    '/consolidacion/importar',
    ah(async (req, res) => {
      const text = String(req.body.csv || '');
      const prep = await importer.prepare(db, text, config.defaultCountryCode);
      if (req.body.accion === 'guardar') {
        const decisions = {};
        for (const [k, v] of Object.entries(req.body)) if (/^d_\d+$/.test(k)) decisions[k.slice(2)] = String(v);
        try {
          const s = await importer.apply(db, prep, decisions);
          return go(res, '/consolidacion', {
            ok: `Importación lista: ${s.created} personas nuevas en consolidación, ${s.updated} actualizadas (${s.newPeople} fichas nuevas, ${s.linked} ya existían).`,
          });
        } catch (err) {
          return page(req, res, 'Importar', importPage(text, `<div class="flash err">No se guardó nada: ${esc(err.message)}</div>${previewHtml(prep, text)}`));
        }
      }
      page(req, res, 'Importar', importPage(text, previewHtml(prep, text)));
    })
  );

  /* ------------------------------ Ficha ------------------------------ */
  r.get(
    '/consolidacion/:id(\\d+)',
    ah(async (req, res) => {
      const id = +req.params.id;
      const c = await store.get(db, id);
      if (!c) return go(res, '/consolidacion', { err: 'No existe esa persona en consolidación.' });
      const [calls, log, vols] = await Promise.all([store.callsOf(db, id), store.statusLogOf(db, id), store.nuevaVidaPeople(db)]);
      const volOpts = vols.map((x) => ({ value: x.id, label: x.full_name }));
      const cur = currentStage(c);
      const t = today();

      const steps = STAGES.map((s) => {
        if (!s.by) {
          return `<div class="card" style="margin-bottom:10px"><strong>${esc(s.label)}</strong> <span class="badge b-ok">${esc(dmy(c.decision_iso))}</span>
            <div class="muted" style="font-size:13px">${esc(c.sede || 'sin sede')}${c.invited_by ? ` · Invitada por ${esc(c.invited_by)}` : ''}</div></div>`;
        }
        const iso = c[`${s.date}_iso`];
        const by = c[`${s.by}_name`];
        if (iso) {
          return `<div class="card" style="margin-bottom:10px"><strong>${esc(s.label)}</strong> <span class="badge b-ok">${esc(dmy(iso))}</span>
            <div class="muted" style="font-size:13px">${by ? `Responsable: ${esc(by)}` : 'Sin responsable'}${s.key === 'grupo' && c.group_name ? ` · ${esc(c.group_name)}` : ''}</div>
            <form class="inline" method="post" action="/consolidacion/${id}/etapa/quitar" onsubmit="return confirm('¿Quitar esta etapa?')"><input type="hidden" name="stage" value="${s.key}"><button class="small sec">Quitar</button></form></div>`;
        }
        return `<div class="card" style="margin-bottom:10px"><strong>${esc(s.label)}</strong> <span class="badge b-muted">Pendiente${s.optional ? ' (opcional)' : ''}</span>
          <form method="post" action="/consolidacion/${id}/etapa" class="toolbar" style="margin:8px 0 0">
            <input type="hidden" name="stage" value="${s.key}">
            <div><label>Fecha</label><input type="date" name="date" required min="${esc(c.decision_iso)}" max="${esc(t)}" value="${esc(t)}"></div>
            <div><label>Responsable</label><select name="by">${options(volOpts, c.assigned_to, 'Sin responsable')}</select></div>
            ${s.key === 'grupo' ? '<div><label>Grupo de cuidado</label><input type="text" name="group_name" placeholder="Nombre del grupo"></div>' : ''}
            <button class="small">Marcar</button></form></div>`;
      }).join('');

      const callRows = calls
        .map((k) => `<tr><td>${esc(new Date(k.called_at).toLocaleDateString('es-VE', { timeZone: config.timezone }))}</td><td>${esc(CALL_RESULTS[k.result])}</td><td>${esc(k.by_name || '—')}</td><td>${esc(k.note)}</td></tr>`)
        .join('');
      const logRows = log
        .map((l) => `<tr><td>${esc(dmy(l.d))}</td><td>${badge(l.status, l.reason)}</td></tr>`)
        .join('');

      page(
        req,
        res,
        c.full_name,
        `<h1>${esc(c.full_name)} ${badge(c.status, c.lost_reason)}</h1>
        <p class="sub">${esc(displayPhone(c.phone) || 'Sin teléfono')} · Etapa actual: <strong>${esc(cur.label)}</strong> · Decidió hace ${c.days} días ·
          <a href="/personas/${c.person_id}">Ver ficha de la persona</a>${c.do_not_call ? ' · <span class="badge b-bad">Pidió no ser llamada</span>' : ''}</p>
        <div class="charts">
          <div>
            <h2 style="margin-top:0">Etapas</h2>${steps}
          </div>
          <div>
            <h2 style="margin-top:0">Llamadas</h2>
            <form method="post" action="/consolidacion/${id}/llamada" class="card toolbar">
              <div><label>Resultado</label><select name="result" required>${options(Object.entries(CALL_RESULTS).map(([k, v]) => ({ value: k, label: v })), '', 'Elige…')}</select></div>
              <div><label>Quién llamó</label><select name="by">${options(volOpts, c.assigned_to, 'Sin indicar')}</select></div>
              <div style="flex-basis:100%"><label>Nota corta (la ven solo el responsable y los administradores)</label><input type="text" name="note" maxlength="1000"></div>
              <button>Registrar llamada</button></form>
            <p class="muted" style="font-size:13px">Si contestó y la etapa «Llamada» estaba vacía, se marca con la fecha de hoy.</p>
            <div class="table-scroll"><table><tr><th>Fecha</th><th>Resultado</th><th>Llamó</th><th>Nota</th></tr>${callRows || '<tr><td colspan="4" class="muted">Sin llamadas todavía.</td></tr>'}</table></div>
            <h2>Estado</h2>
            <form method="post" action="/consolidacion/${id}/estado" class="card toolbar">
              <div><label>Estado</label><select name="status">${options(Object.entries(STATUSES).map(([k, v]) => ({ value: k, label: v })), c.status)}</select></div>
              <div><label>Motivo (si se perdió)</label><select name="reason">${options(Object.entries(LOST_REASONS).map(([k, v]) => ({ value: k, label: v })), c.lost_reason, 'Sin motivo')}</select></div>
              <div><label>Desde</label><input type="date" name="date" min="${esc(c.decision_iso)}" max="${esc(t)}" value="${esc(t)}"></div>
              <button class="sec">Cambiar estado</button></form>
            <div class="table-scroll"><table><tr><th>Desde</th><th>Estado</th></tr>${logRows}</table></div>
          </div>
        </div>
        <h2>Datos</h2>
        <form method="post" action="/consolidacion/${id}/datos" class="card">
          <div class="row">
            <div><label>Fecha de la decisión</label><input type="date" name="decision_date" required max="${esc(t)}" value="${esc(c.decision_iso)}"></div>
            <div><label>Sede</label><input type="text" name="sede" value="${esc(c.sede)}"></div>
            <div><label>Responsable de Nueva Vida</label><select name="assigned_to">${options(volOpts, c.assigned_to, 'Sin asignar')}</select></div>
          </div>
          <div class="row">
            <div><label>Quién la invitó</label><input type="text" name="invited_by" value="${esc(c.invited_by)}"></div>
            <div><label>Vista por última vez en un servicio (opcional)</label><input type="date" name="last_seen" max="${esc(t)}" value="${esc(c.seen_iso || '')}"></div>
          </div>
          <div class="actions"><button>Guardar datos</button></div>
        </form>
        <form method="post" action="/consolidacion/${id}/eliminar" onsubmit="return confirm('¿Quitar a esta persona de consolidación? Su ficha de persona no se borra.')">
          <button class="danger small">Quitar de consolidación</button></form>`
      );
    })
  );

  const back = (res, id, err) => go(res, `/consolidacion/${id}`, err ? { err } : { ok: 'Guardado.' });
  const byId = (v) => (/^\d+$/.test(String(v || '')) ? +v : null);

  r.post(
    '/consolidacion/:id(\\d+)/etapa',
    ah(async (req, res) => {
      const date = parseDate(req.body.date);
      if (!date) return back(res, req.params.id, 'Escribe una fecha válida.');
      back(res, req.params.id, await store.setStage(db, +req.params.id, String(req.body.stage), date, byId(req.body.by), { groupName: req.body.group_name }));
    })
  );
  r.post('/consolidacion/:id(\\d+)/etapa/quitar', ah(async (req, res) => back(res, req.params.id, await store.clearStage(db, +req.params.id, String(req.body.stage)))));
  r.post(
    '/consolidacion/:id(\\d+)/estado',
    ah(async (req, res) => back(res, req.params.id, await store.setStatus(db, +req.params.id, String(req.body.status), String(req.body.reason || ''), parseDate(req.body.date))))
  );
  r.post(
    '/consolidacion/:id(\\d+)/llamada',
    ah(async (req, res) => back(res, req.params.id, await store.logCall(db, +req.params.id, { calledBy: byId(req.body.by), result: String(req.body.result || ''), note: req.body.note })))
  );
  r.post(
    '/consolidacion/:id(\\d+)/datos',
    ah(async (req, res) => {
      const decisionDate = parseDate(req.body.decision_date);
      if (!decisionDate) return back(res, req.params.id, 'Escribe una fecha de decisión válida.');
      back(
        res,
        req.params.id,
        await store.updateData(db, +req.params.id, {
          decisionDate, sede: req.body.sede, invitedBy: req.body.invited_by, assignedTo: byId(req.body.assigned_to), lastSeen: parseDate(req.body.last_seen),
        })
      );
    })
  );
  r.post(
    '/consolidacion/:id(\\d+)/eliminar',
    ah(async (req, res) => {
      await tx(db, (c) => store.remove(c, +req.params.id));
      go(res, '/consolidacion', { ok: 'Quitada de consolidación. Su ficha de persona sigue en la lista.' });
    })
  );

  return r;
}

module.exports = { consolidationRouter };
