'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const pw = require('../people-wipe');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const CONFIRM = 'BORRAR TODAS';

/** Borrar toda la lista de personas: muestra lo que se llevaría y pide escribir una frase para confirmar. */
function peopleWipeRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/personas/borrar-todas', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/personas', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  r.get(
    '/personas/borrar-todas',
    ah(async (req, res) => {
      const i = await pw.wipeImpact(db);
      const effect = (e) => {
        const what = e.rule === 'cascade' ? '<span class="badge b-bad">Se borran</span>' : e.rule === 'null' ? '<span class="badge b-warn">Se conservan, sin la persona</span>' : '<span class="badge b-bad">Impide el borrado</span>';
        return `<tr><td>${esc(e.label)}</td><td>${e.rows}</td><td>${what}</td></tr>`;
      };
      page(
        req,
        res,
        'Borrar toda la lista de personas',
        `<p><a href="/personas">← Personas</a></p><h1>Borrar toda la lista de personas</h1>
        <div class="flash err"><strong>Esto no se puede deshacer.</strong> Se borrarán <strong>${plural(i.toDelete, 'persona', 'personas')}</strong> de las ${i.total} que hay, junto con lo que depende de ellas.</div>
        <div class="card"><h3 style="margin:0 0 6px">1. Antes de borrar, descarga una copia</h3>
          <p class="muted" style="margin:0 0 8px">Un archivo CSV con toda la lista (nombre, teléfono, correo, ministerios, tipo...). Sin una copia no hay forma de recuperarla.</p>
          <a class="btn sec" href="/personas/exportar.csv">Descargar copia de la lista (CSV)</a></div>
        <div class="card"><h3 style="margin:0 0 6px">2. Esto es lo que se llevaría el borrado</h3>
          <div class="table-scroll"><table><tr><th>Dato</th><th>Cantidad</th><th>Qué pasa</th></tr>
            <tr><td><strong>Personas</strong></td><td>${i.toDelete}</td><td><span class="badge b-bad">Se borran</span></td></tr>${i.effects.map(effect).join('')}</table></div>
          <p class="muted" style="font-size:13px;margin:8px 0 0">No se tocan los grupos de cuidado, los eventos, los ministerios, la asistencia ni los bautizados.</p></div>
        <div class="card"><h3 style="margin:0 0 6px">${plural(i.keep, 'persona se conserva', 'personas se conservan')}</h3>
          <p class="muted" style="margin:0">Quienes tienen <strong>acceso al panel</strong> (administradores y coordinadores que entran con Google) no se borran, para que nadie se quede sin poder entrar.${i.keepNames.length ? ` Son: ${i.keepNames.map(esc).join(', ')}.` : ''}</p></div>
        ${i.toDelete === 0 ? '<p class="muted">No hay personas para borrar.</p>' : `<form method="post" action="/personas/borrar-todas" class="card">
          <h3 style="margin:0 0 6px">3. Confirma</h3>
          <label>Para confirmar, escribe <strong>${CONFIRM}</strong></label>
          <input type="text" name="confirmar" autocomplete="off" required style="max-width:280px">
          <div class="actions"><button class="danger">Borrar toda la lista</button><a class="btn sec" href="/personas">Cancelar</a></div></form>`}`
      );
    })
  );

  r.post(
    '/personas/borrar-todas',
    ah(async (req, res) => {
      if (String(req.body.confirmar || '').trim() !== CONFIRM) return go(res, '/personas/borrar-todas', { err: `No se borró nada: tienes que escribir ${CONFIRM}.` });
      let out;
      try {
        out = await pw.wipePeople(db);
      } catch (err) {
        if (/impide el borrado/.test(err.message)) return go(res, '/personas/borrar-todas', { err: err.message });
        throw err;
      }
      go(res, '/personas', { ok: `Listo: se borraron ${plural(out.toDelete, 'persona', 'personas')}${out.keep ? ` y se conservaron ${plural(out.keep, 'persona', 'personas')} con acceso al panel` : ''}.` });
    })
  );

  return r;
}

module.exports = { peopleWipeRouter, CONFIRM };
