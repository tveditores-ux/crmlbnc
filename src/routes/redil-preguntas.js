'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const lib = require('../redil-libreta');
const { sheet, EXTRA_CSS } = require('../views/redil-libreta');
const { CSS } = require('./reunion-equipo');

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
      const ver = ['todas', 'persona'].includes(req.query.ver) ? req.query.ver : 'abiertas';
      const all = await lib.listAll(db, lib.ACTIVE);
      const open = all.filter((q) => q.status === 'abierta').length;
      const shown = ver === 'abiertas' ? all.filter((q) => q.status === 'abierta') : all;
      const byPoint = new Map();
      for (const q of shown) (byPoint.get(q.point) || byPoint.set(q.point, []).get(q.point)).push(q);
      const ptLabel = (q) => (q.point ? `Punto ${String(q.point).padStart(2, '0')}` : 'Pregunta general');
      const card = (q, byPerson = false) => `<div style="border-top:1px solid var(--line);padding:10px 0">
        <div><strong>${esc(byPerson ? ptLabel(q) : q.asker_name)}</strong> <span class="muted">${byPerson ? '' : `· ${esc(q.group_name)}${q.asker_phone ? ` · ${esc(displayPhone(q.asker_phone))}` : ''} `}· ${esc(when(q.created_at))}</span> ${q.status === 'atendida' ? '<span class="badge b-ok">Atendida</span>' : '<span class="badge b-warn">Abierta</span>'}</div>
        <p style="margin:6px 0">${esc(q.question).replace(/\n/g, '<br>')}</p>
        <form method="post" action="/redil/preguntas/${q.id}/respuesta" style="margin:0"><label style="font-size:13px">Respuesta para el líder (la ve en su libretica)</label>
          <textarea name="answer" style="min-height:60px">${esc(q.answer)}</textarea>
          <div class="actions" style="margin-top:6px"><button class="small">Guardar respuesta</button></div></form>
        <form method="post" action="/redil/preguntas/${q.id}/estado" style="margin:6px 0 0"><input type="hidden" name="status" value="${q.status === 'atendida' ? 'abierta' : 'atendida'}"><button class="small sec">${q.status === 'atendida' ? 'Reabrir' : 'Marcar como atendida sin responder'}</button></form></div>`;
      const block = (title, sub, list, byPerson = false) => `<div class="card"><h3 style="margin:0">${title}</h3>${sub ? `<p class="muted" style="margin:2px 0 4px">${esc(sub)}</p>` : ''}${list.map((q) => card(q, byPerson)).join('')}</div>`;
      const blocks = [];
      if (ver === 'persona') {
        const people = new Map();
        for (const q of shown) {
          const k = `${q.group_id ?? ''}|${q.asker_name}`;
          (people.get(k) || people.set(k, []).get(k)).push(q);
        }
        for (const list of people.values()) {
          const q0 = list[0];
          blocks.push(block(esc(q0.asker_name), `${q0.group_name}${q0.asker_phone ? ` · ${displayPhone(q0.asker_phone)}` : ''}`, list.sort((a, b) => (a.point ?? 999) - (b.point ?? 999)), true));
        }
      } else {
      for (const s of L.sections) for (const p of s.points) if (byPoint.has(p.n)) blocks.push(block(`Punto ${String(p.n).padStart(2, '0')} · ${esc(s.title)}`, p.text.join(' '), byPoint.get(p.n)));
      if (byPoint.has(null)) blocks.push(block('Preguntas generales', 'No son de un punto en particular.', byPoint.get(null)));
      }
      res.setHeader('Cache-Control', 'no-store');
      res.send(
        layout({
          title: 'Preguntas del REDIL',
          active: '/redil/preguntas',
          config,
          query: req.query,
          body: `<h1>Preguntas del REDIL</h1><p class="sub">${esc(L.title)} · ${esc(L.when)}. Lo que los líderes escribieron en su libretica, con su nombre y su grupo. <a href="/redil/libreta">Ver la libretica</a>.</p>
            <div class="cal-tools" style="display:flex;gap:8px;margin-bottom:12px"><a class="btn ${ver === 'abiertas' ? '' : 'sec'}" href="/redil/preguntas">Abiertas (${open})</a><a class="btn ${ver === 'todas' ? '' : 'sec'}" href="/redil/preguntas?ver=todas">Todas por punto (${all.length})</a><a class="btn ${ver === 'persona' ? '' : 'sec'}" href="/redil/preguntas?ver=persona">Por persona</a></div>
            ${blocks.join('') || `<div class="card muted">${all.length ? 'No hay preguntas abiertas.' : 'Todavía nadie ha escrito una pregunta.'}</div>`}`,
        })
      );
    })
  );

  // la libretica tal como la ven los líderes (sin cajas), para revisarla desde el panel
  r.get(
    '/redil/libreta',
    ah(async (req, res) => {
      const L = lib.getLibreta();
      const counts = new Map();
      for (const q of await lib.listAll(db, lib.ACTIVE)) counts.set(q.point, (counts.get(q.point) || 0) + 1);
      res.send(
        layout({
          title: 'Libretica del REDIL',
          active: '/redil/libreta',
          config,
          query: req.query,
          body: `<style>${CSS}${EXTRA_CSS}</style><h1>📖 Libretica del ${esc(L.title)}</h1><p class="sub"><strong>${esc(L.when)}</strong></p><p>${esc(L.intro)}</p>
            <p class="muted" style="font-size:14px">Así la leen los líderes en la pestaña REDIL de su enlace (<a href="/grupos">Grupos de cuidado</a> → ficha del grupo → "abrir como líder"). Allí cada punto tiene su caja de pregunta. <a href="/redil/preguntas">Ver las preguntas recibidas</a>.</p><div class="re">${sheet(L, { readOnly: true, counts })}</div>`,
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
