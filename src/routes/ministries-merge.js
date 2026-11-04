'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const mm = require('../ministries-merge');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Unir ministerios repetidos (por ejemplo "Anfitriones" dos veces) sin perder a nadie. */
function ministriesMergeRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const page = (req, res, title, body) => res.send(layout({ title, active: '/ministerios', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);

  r.get(
    '/ministerios/unir',
    ah(async (req, res) => {
      const all = await mm.listWithCounts(db);
      const groups = mm.duplicateGroups(all);
      const option = (m) => `<option value="${m.id}">${esc(m.name)} · ${m.members} persona${m.members === 1 ? '' : 's'}</option>`;
      const cards = groups
        .map((g) => {
          // se propone conservar el que tiene más personas (y, a igualdad, el más antiguo, que ya viene primero)
          const best = g.reduce((a, b) => (b.members > a.members ? b : a), g[0]);
          return `<form method="post" action="/ministerios/unir" class="card">
            <h3 style="margin:0 0 6px">Parece el mismo ministerio, ${g.length} veces</h3>
            ${g
              .map(
                (m) => `<label class="check" style="margin:4px 0"><input type="radio" name="keep" value="${m.id}" ${m.id === best.id ? 'checked' : ''}>
                  <span><strong>${esc(m.name)}</strong> <span class="muted">· ${m.members} persona${m.members === 1 ? '' : 's'}, ${m.events} evento${m.events === 1 ? '' : 's'}</span></span></label>
                  <input type="hidden" name="all" value="${m.id}">`
              )
              .join('')}
            <p class="muted" style="font-size:13px;margin:6px 0 0">Se conserva el elegido y los demás se unen a él: sus personas y eventos pasan al conservado, sin repetir y sin borrar a nadie.</p>
            <div class="actions"><button>Unir en uno</button></div></form>`;
        })
        .join('');
      page(
        req,
        res,
        'Unir ministerios',
        `<p><a href="/ministerios">← Ministerios</a></p><h1>Unir ministerios repetidos</h1>
        <p class="sub">Sirve cuando un ministerio quedó escrito dos veces (por ejemplo, con otra tilde o un espacio de más). Las personas y los eventos de uno pasan al otro y nadie se borra.</p>
        ${cards || '<p class="muted">No encontré ministerios que se llamen casi igual.</p>'}
        <h2>Unir dos a mano</h2>
        <p class="sub">Si se llaman distinto pero son el mismo, elígelos aquí.</p>
        <form method="post" action="/ministerios/unir" class="card toolbar">
          <div><label>Conservar</label><select name="keep" required><option value="">Elige…</option>${all.map(option).join('')}</select></div>
          <div><label>Unir a este y quitar el repetido</label><select name="all" required><option value="">Elige…</option>${all.map(option).join('')}</select></div>
          <button>Unir</button></form>`
      );
    })
  );

  r.post(
    '/ministerios/unir',
    ah(async (req, res) => {
      const keep = Number(req.body.keep);
      const ids = [...new Set((Array.isArray(req.body.all) ? req.body.all : [req.body.all]).map(Number))].filter((n) => Number.isInteger(n) && n > 0 && n !== keep);
      if (!Number.isInteger(keep) || keep < 1 || !ids.length) return go(res, '/ministerios/unir', { err: 'Elige el ministerio que se conserva y el que se une a él.' });
      try {
        let members = 0;
        let names = [];
        let keepName = '';
        for (const id of ids) {
          const out = await mm.mergeMinistries(db, keep, id); // una transacción por cada uno que se une
          members += out.members;
          names.push(out.removedName);
          keepName = out.keepName;
        }
        go(res, '/ministerios', { ok: `Listo: «${names.join('», «')}» se unió a «${keepName}». ${members} persona${members === 1 ? '' : 's'} pasaron al ministerio que se conserva.` });
      } catch (err) {
        if (err instanceof mm.MergeError) return go(res, '/ministerios/unir', { err: err.message });
        throw err;
      }
    })
  );

  return r;
}

module.exports = { ministriesMergeRouter };
