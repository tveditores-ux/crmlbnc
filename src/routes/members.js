'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const members = require('../members');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Miembros y amigos ya no es una pestaña aparte: es la misma tabla `people`, dentro de Personas.
 * Este router conserva lo que no cabe en la lista de Personas:
 *  - el cambio rápido de tipo (POST), con el que se clasifica desde la lista,
 *  - la importación de la lista del grupo oficial de WhatsApp (/personas/importar-grupo),
 *  - las redirecciones de /miembros, para no romper enlaces guardados.
 */
function membersRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use(['/miembros', '/personas/importar-grupo'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/personas', body, config, query: req.query }));

  /* ------------------------- Redirecciones desde /miembros ------------------------- */
  // 302 (temporal): si algún día cambia el destino, los navegadores no se quedan con el viejo.
  const toPersonas = (path, extra) => (req, res) => res.redirect(302, `${path}${members.viewQuery(members.parseView(req.query), extra)}`);
  r.get('/miembros', toPersonas('/personas'));
  r.get('/miembros/exportar.csv', toPersonas('/personas/exportar.csv'));
  r.get('/miembros/importar', (req, res) => res.redirect(302, '/personas/importar-grupo'));
  r.post('/miembros/importar', (req, res) => res.redirect(307, '/personas/importar-grupo')); // 307 conserva el envío (por si había una pestaña abierta)

  /* ------------------------- Cambio rápido de tipo ------------------------- */
  const setTipo = ah(async (req, res) => {
    const v = members.parseView({ tipo: req.body.filtro, grupo: req.body.grupo, q: req.body.q, m: req.body.m });
    const back = (flash) => res.redirect(303, `/personas${members.viewQuery(v, flash)}`);
    const tipo = String(req.body.tipo ?? '');
    const err = await members.setMembership(db, +req.params.id, tipo);
    if (err) return back({ err });
    const { rows } = await db.query('SELECT full_name FROM people WHERE id = $1', [+req.params.id]);
    back({ ok: `${rows[0].full_name}: ${members.tipoLabel(tipo)}` });
  });
  r.post('/personas/:id(\\d{1,9})/tipo', setTipo);
  r.post('/miembros/:id(\\d{1,9})/tipo', setTipo); // por si había una pestaña vieja abierta

  /* ------------------------- Importar la lista del grupo ------------------------- */
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
        <button name="accion" value="importar">Importar</button><a class="btn sec" href="/personas">Cancelar</a></div>
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

  r.get('/personas/importar-grupo', (req, res) => page(req, res, 'Importar lista del grupo', importPage('')));

  r.post(
    '/personas/importar-grupo',
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
        return res.redirect(303, `/personas?${new URLSearchParams({ ok: `Importación lista: ${report.created} nuevas, ${report.updated} actualizadas.` })}`);
      }
      page(req, res, 'Importar lista del grupo', importPage(text, html));
    })
  );

  return r;
}

module.exports = { membersRouter };
