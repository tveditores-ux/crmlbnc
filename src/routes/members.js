'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const { toCsv } = require('../csv');
const members = require('../members');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const TIPO_BADGE = { miembro: 'b-ok', amigo: 'b-warn' };

/** Pestaña "Miembros y amigos": clasificar a las personas y cargar la lista del grupo oficial de WhatsApp. */
function membersRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/miembros', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/miembros', body, config, query: req.query }));

  /** Filtro y búsqueda que se conservan al volver a la lista. Solo valores conocidos: nunca se copia una URL cruda. */
  const view = (src) => ({
    tipo: Object.hasOwn(members.FILTERS, src.tipo) && src.tipo !== 'todos' ? src.tipo : 'todos',
    q: String(src.q || '').trim().slice(0, 80),
  });
  const qs = (v, extra = {}) => {
    const p = new URLSearchParams();
    if (v.tipo !== 'todos') p.set('tipo', v.tipo);
    if (v.q) p.set('q', v.q);
    for (const [k, x] of Object.entries(extra)) p.set(k, x);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const back = (res, v, flash) => res.redirect(303, `/miembros${qs(v, flash)}`);

  /* ------------------------------ Lista ------------------------------ */
  r.get(
    '/miembros',
    ah(async (req, res) => {
      const v = view(req.query);
      const [rows, c] = await Promise.all([members.list(db, v), members.counts(db)]);
      const pills = Object.entries(members.FILTERS)
        .map(([k, label]) => {
          const n = c[k];
          return `<a class="btn ${v.tipo === k ? '' : 'sec'} small" href="/miembros${qs({ tipo: k, q: v.q })}">${esc(label)} <strong>${n}</strong></a>`;
        })
        .join(' ');
      const btn = (x, tipo) =>
        `<form class="inline" method="post" action="/miembros/${x.id}/tipo">
          <input type="hidden" name="tipo" value="${tipo}"><input type="hidden" name="filtro" value="${esc(v.tipo)}"><input type="hidden" name="q" value="${esc(v.q)}">
          <button class="small ${x.membership === tipo ? '' : 'sec'}" ${x.membership === tipo ? 'aria-pressed="true"' : ''}>${esc(members.TIPOS[tipo])}</button></form>`;
      const list = rows
        .map(
          (x) => `<tr style="${x.active ? '' : 'opacity:.55'}">
          <td><a href="/personas/${x.id}">${esc(x.full_name)}</a>${x.whatsapp_name && x.whatsapp_name !== x.full_name ? `<div class="muted" style="font-size:12px">WhatsApp: ${esc(x.whatsapp_name)}</div>` : ''}</td>
          <td>${esc(displayPhone(x.phone) || '—')}</td>
          <td><span class="badge ${TIPO_BADGE[x.membership] || 'b-muted'}">${esc(members.tipoLabel(x.membership))}</span></td>
          <td>${x.in_official_group ? 'Sí' : 'No'}</td>
          <td style="white-space:nowrap">${btn(x, 'miembro')} ${btn(x, 'amigo')} <a class="btn sec small" href="/personas/${x.id}">Ficha</a></td></tr>`
        )
        .join('');
      page(
        req,
        res,
        'Miembros y amigos',
        `<h1>Miembros y amigos</h1>
        <p class="sub">Clasifica a cada persona como miembro o amigo de la iglesia. Estar en el grupo de WhatsApp no significa haber aceptado recordatorios.</p>
        <div class="actions"><a class="btn" href="/miembros/importar">Importar lista del grupo</a>
          <a class="btn sec" href="/miembros/exportar.csv${qs(v)}">Descargar lista</a></div>
        <div class="grid">
          <div class="card"><div class="stat" style="color:var(--ok)">${c.miembro}</div><div class="stat-label">miembros</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${c.amigo}</div><div class="stat-label">amigos</div></div>
          <div class="card"><div class="stat">${c.sin}</div><div class="stat-label">por clasificar</div></div>
          <div class="card"><div class="stat">${c.grupo}</div><div class="stat-label">en el grupo oficial</div></div>
        </div>
        <div class="actions" style="margin-bottom:6px">${pills}</div>
        <form class="toolbar" method="get" action="/miembros">
          ${v.tipo !== 'todos' ? `<input type="hidden" name="tipo" value="${esc(v.tipo)}">` : ''}
          <div><label>Buscar por nombre o teléfono</label><input type="search" name="q" value="${esc(v.q)}" placeholder="Nombre o teléfono"></div>
          <button class="sec">Buscar</button></form>
        <h2>${rows.length} ${rows.length === 1 ? 'persona' : 'personas'}${rows.length >= 1000 ? ' (se muestran las primeras 1000: usa los filtros)' : ''}</h2>
        <div class="table-scroll"><table><tr><th>Nombre</th><th>Teléfono</th><th>Tipo</th><th>Grupo oficial</th><th></th></tr>${
          list || '<tr><td colspan="5" class="muted">No hay nadie con ese filtro.</td></tr>'
        }</table></div>`
      );
    })
  );

  /* ------------------------------ Cambiar el tipo ------------------------------ */
  r.post(
    '/miembros/:id(\\d{1,9})/tipo',
    ah(async (req, res) => {
      const v = view({ tipo: req.body.filtro, q: req.body.q });
      const err = await members.setMembership(db, +req.params.id, String(req.body.tipo ?? ''));
      if (err) return back(res, v, { err });
      const { rows } = await db.query('SELECT full_name FROM people WHERE id = $1', [+req.params.id]);
      back(res, v, { ok: `${rows[0].full_name}: ${members.tipoLabel(String(req.body.tipo ?? ''))}` });
    })
  );

  /* ------------------------------ Descargar ------------------------------ */
  r.get(
    '/miembros/exportar.csv',
    ah(async (req, res) => {
      const rows = await members.list(db, view(req.query), 5000);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="miembros-y-amigos.csv"');
      res.send(
        toCsv([
          ['Nombre', 'Teléfono', 'Tipo', 'En el grupo oficial'],
          ...rows.map((x) => [x.full_name, displayPhone(x.phone), members.tipoLabel(x.membership), x.in_official_group ? 'Sí' : 'No']),
        ])
      );
    })
  );

  /* ------------------------------ Importar la lista del grupo ------------------------------ */
  function importPage(csvText, reportHtml) {
    return `<h1>Importar la lista del grupo</h1>
      <p class="sub">Columnas: <span class="mono">Nombre, Teléfono, Admin, Origen del nombre</span> (y, si quieres, <span class="mono">Tipo</span> con miembro o amigo).
        El teléfono es la clave: quien ya existe se actualiza sin cambiar su nombre, su correo ni si aceptó recordatorios. Las personas nuevas se crean sin consentimiento.</p>
      <form method="post" class="card" id="imp">
        <label>Archivo CSV (desde Excel o Google Sheets: Archivo → Descargar → CSV)</label>
        <input type="file" accept=".csv,text/csv" id="file">
        <label>O pega el contenido aquí</label>
        <textarea name="csv" id="csv" style="min-height:180px" class="mono">${esc(csvText || '')}</textarea>
        <div class="actions"><button name="accion" value="revisar" class="sec">Revisar sin guardar</button>
        <button name="accion" value="importar">Importar</button><a class="btn sec" href="/miembros">Cancelar</a></div>
      </form>
      ${reportHtml || ''}
      <script>
        document.getElementById('file').addEventListener('change', function(e){
          var f = e.target.files[0]; if(!f) return;
          var rd = new FileReader();
          rd.onload = function(){ document.getElementById('csv').value = rd.result; };
          rd.readAsText(f, 'UTF-8');
        });
      </script>`;
  }

  r.get('/miembros/importar', (req, res) => page(req, res, 'Importar lista del grupo', importPage('')));

  r.post(
    '/miembros/importar',
    ah(async (req, res) => {
      const text = String(req.body.csv || '');
      const dryRun = req.body.accion !== 'importar';
      const report = await members.importGroup(db, text, config.defaultCountryCode, { dryRun });
      const unk = report.unknownHeaders.length ? `<p class="muted">Columnas ignoradas: ${report.unknownHeaders.map(esc).join(', ')}</p>` : '';
      let html;
      if (report.errors.length) {
        const rows = report.errors
          .slice(0, 80)
          .map((e) => `<tr><td>${esc(e.line)}</td><td>${esc(e.name || '')}</td><td>${e.errors.map(esc).join('<br>')}</td></tr>`)
          .join('');
        html = `<div class="flash err">Hay ${report.errors.length} fila(s) con problemas. No se guardó nada; corrígelas y vuelve a intentar.</div>${unk}
          <div class="table-scroll"><table><tr><th>Línea</th><th>Nombre</th><th>Problema</th></tr>${rows}</table></div>
          ${report.errors.length > 80 ? `<p class="muted">… y ${report.errors.length - 80} más.</p>` : ''}`;
      } else if (dryRun) {
        html = `<div class="flash ok">Todo correcto: ${report.created} personas nuevas y ${report.updated} por actualizar. Pulsa "Importar" para guardar.</div>${unk}`;
      } else {
        return res.redirect(303, `/miembros?${new URLSearchParams({ ok: `Importación lista: ${report.created} nuevas, ${report.updated} actualizadas.` })}`);
      }
      page(req, res, 'Importar lista del grupo', importPage(text, html));
    })
  );

  return r;
}

module.exports = { membersRouter };
