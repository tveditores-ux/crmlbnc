'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const lib = require('../redil-libreta');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const go = (res, path, flash) => res.redirect(303, flash ? `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(flash).toString()}` : path);

/** Panel: las preguntas que los líderes escribieron en la libretica del REDIL, por punto y con el nombre de quien preguntó. */
function redilPreguntasRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const tz = config.timezone;
  const when = (d) => new Date(d).toLocaleString('es-VE', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  r.get(
    '/redil/preguntas',
    ah(async (req, res) => {
      const L = lib.getLibreta();
      const ver = req.query.ver === 'todas' ? 'todas' : 'abiertas';
      const all = await lib.listAll(db, lib.ACTIVE);
      const open = all.filter((q) => q.status === 'abierta').length;
      const shown = ver === 'todas' ? all : all.filter((q) => q.status === 'abierta');
      const byPoint = new Map();
      for (const q of shown) (byPoint.get(q.point) || byPoint.set(q.point, []).get(q.point)).push(q);
      const card = (q) => `<div style="border-top:1px solid var(--line);padding:10px 0">
        <div><strong>${esc(q.asker_name)}</strong> <span class="muted">· ${esc(q.group_name)}${q.asker_phone ? ` · ${esc(displayPhone(q.asker_phone))}` : ''} · ${esc(when(q.created_at))}</span> ${q.status === 'atendida' ? '<span class="badge b-ok">Atendida</span>' : '<span class="badge b-warn">Abierta</span>'}</div>
        <p style="margin:6px 0">${esc(q.question).replace(/\n/g, '<br>')}</p>
        <form method="post" action="/redil/preguntas/${q.id}/respuesta" style="margin:0"><label style="font-size:13px">Respuesta para el líder (la ve en su libretica)</label>
          <textarea name="answer" style="min-height:60px">${esc(q.answer)}</textarea>
          <div class="actions" style="margin-top:6px"><button class="small">Guardar respuesta</button></div></form>
        <form method="post" action="/redil/preguntas/${q.id}/estado" style="margin:6px 0 0"><input type="hidden" name="status" value="${q.status === 'atendida' ? 'abierta' : 'atendida'}"><button class="small sec">${q.status === 'atendida' ? 'Reabrir' : 'Marcar como atendida sin responder'}</button></form></div>`;
      const block = (title, sub, list) => `<div class="card"><h3 style="margin:0">${title}</h3>${sub ? `<p class="muted" style="margin:2px 0 4px">${esc(sub)}</p>` : ''}${list.map(card).join('')}</div>`;
      const blocks = [];
      for (const s of L.sections) for (const p of s.points) if (byPoint.has(p.n)) blocks.push(block(`Punto ${String(p.n).padStart(2, '0')} · ${esc(s.title)}`, p.text.join(' '), byPoint.get(p.n)));
      if (byPoint.has(null)) blocks.push(block('Preguntas generales', 'No son de un punto en particular.', byPoint.get(null)));
      res.setHeader('Cache-Control', 'no-store');
      res.send(
        layout({
          title: 'Preguntas del REDIL',
          active: '/redil/preguntas',
          config,
          query: req.query,
          body: `<h1>Preguntas del REDIL</h1><p class="sub">${esc(L.title)} · ${esc(L.when)}. Lo que los líderes escribieron en su libretica, con su nombre y su grupo.</p>
            <div class="cal-tools" style="display:flex;gap:8px;margin-bottom:12px"><a class="btn ${ver === 'abiertas' ? '' : 'sec'}" href="/redil/preguntas">Abiertas (${open})</a><a class="btn ${ver === 'todas' ? '' : 'sec'}" href="/redil/preguntas?ver=todas">Todas (${all.length})</a></div>
            ${blocks.join('') || `<div class="card muted">${all.length ? 'No hay preguntas abiertas.' : 'Todavía nadie ha escrito una pregunta.'}</div>`}`,
        })
      );
    })
  );

  r.post(
    '/redil/preguntas/:id(\\d+)/respuesta',
    ah(async (req, res) => {
      const ok = await lib.answer(db, +req.params.id, req.body.answer);
      go(res, '/redil/preguntas', ok ? { ok: 'Respuesta guardada.' } : { err: 'No encontré esa pregunta.' });
    })
  );
  r.post(
    '/redil/preguntas/:id(\\d+)/estado',
    ah(async (req, res) => {
      const ok = await lib.setStatus(db, +req.params.id, req.body.status);
      go(res, '/redil/preguntas?ver=todas', ok ? { ok: 'Listo.' } : { err: 'No pude cambiarla.' });
    })
  );
  return r;
}

module.exports = { redilPreguntasRouter };
