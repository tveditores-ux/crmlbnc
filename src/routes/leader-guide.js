'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const lg = require('../leader-guide');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Pantalla Guía del líder: aquí se escriben, corrigen y confirman las respuestas que ven los líderes y el asistente. */
function leaderGuideRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/guia', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);

  const select = (name, options, cur) =>
    `<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const catOptions = lg.CATEGORIES.map((c) => [c, c]);
  const statusOptions = Object.entries(lg.STATUSES);

  const fields = (e) => `<div class="row">
      <div><label>Categoría</label>${select('category', catOptions, e.category)}</div>
      <div><label>Estado</label>${select('status', statusOptions, e.status)}</div>
      <div><label>Revisar antes de (opcional)</label><input type="date" name="review_by" value="${esc(e.review_by || '')}"></div></div>
    <label>Pregunta del líder</label><input type="text" name="question" maxlength="${lg.MAX.question}" value="${esc(e.question || '')}" required>
    <label>Respuesta aprobada</label><textarea name="answer" maxlength="${lg.MAX.answer}" required style="min-height:100px">${esc(e.answer || '')}</textarea>
    <div class="row">
      <div><label>A quién escribir (opcional)</label><input type="text" name="contact" maxlength="${lg.MAX.contact}" value="${esc(e.contact || '')}"></div>
      <div><label>De dónde sale (opcional)</label><input type="text" name="source" maxlength="${lg.MAX.source}" value="${esc(e.source || '')}"></div></div>`;

  r.get(
    '/guia',
    ah(async (req, res) => {
      const t = today();
      const all = (await db.query('SELECT * FROM leader_guide ORDER BY sort, id')).rows;
      const filter = ['confirmada', 'por_confirmar'].includes(req.query.estado) ? req.query.estado : '';
      const list = filter ? all.filter((e) => e.status === filter) : all;
      const toConfirm = all.filter((e) => e.status === 'por_confirmar').length;
      const due = all.filter((e) => e.review_by && e.review_by <= t).length;
      const pills = [['', 'Todas', all.length], ['por_confirmar', 'Por confirmar', toConfirm], ['confirmada', 'Confirmadas', all.length - toConfirm]]
        .map(([k, l, n]) => `<a class="btn ${filter === k ? '' : 'sec'} small" href="/guia${k ? `?estado=${k}` : ''}">${l} <strong>${n}</strong></a>`)
        .join(' ');
      const cards = lg
        .groupByCategory(list)
        .map(
          (g) => `<h2>${esc(g.category)}</h2>${g.entries
            .map(
              (e) => `<form method="post" action="/guia/${e.id}" class="card" style="${e.active ? '' : 'opacity:.55'}">
                <p style="margin:0 0 6px">${e.status === 'confirmada' ? '<span class="badge b-ok">Confirmada</span>' : '<span class="badge b-warn">Por confirmar</span>'}
                  ${e.review_by && e.review_by <= t ? '<span class="badge b-bad">Toca revisarla</span>' : ''}${e.active ? '' : ' <span class="badge b-muted">Oculta</span>'}</p>
                ${fields(e)}
                <div class="actions"><label class="check" style="margin:0"><input type="checkbox" name="active" value="1" ${e.active ? 'checked' : ''}> Visible para los líderes</label>
                  <button class="small">Guardar</button>
                  ${e.status === 'por_confirmar' ? `<button class="small" style="background:var(--ok)" formaction="/guia/${e.id}/confirmar">Guardar y confirmar</button>` : ''}
                  <button class="small danger" formaction="/guia/${e.id}/eliminar" onclick="return confirm('¿Borrar esta respuesta?')">Borrar</button></div></form>`
            )
            .join('')}`
        )
        .join('');
      page(
        req,
        res,
        'Guía del líder',
        `<h1>Guía del líder</h1>
        <p class="sub">Las respuestas a las dudas operativas de los líderes. Los líderes las ven en la pestaña <strong>Guía</strong> de su enlace y el asistente de WhatsApp las usa solo con ellos. <strong>Solo se muestra lo confirmado</strong>: lo "por confirmar" es un borrador que solo ves tú.</p>
        ${toConfirm ? `<div class="flash err">${toConfirm} respuesta${toConfirm === 1 ? '' : 's'} por confirmar. Revisa cada una (muchas vienen de documentos de 2017 y 2022) y confírmala cuando siga vigente.</div>` : ''}
        ${due ? `<div class="flash err">${due} respuesta${due === 1 ? '' : 's'} con la fecha de revisión vencida.</div>` : ''}
        <p class="toolbar">${pills}</p>
        ${cards || '<p class="muted">No hay respuestas con ese filtro.</p>'}
        <h2>Agregar una respuesta</h2>
        <form method="post" action="/guia" class="card">${fields({ category: lg.CATEGORIES[1], status: 'por_confirmar' })}
          <div class="actions"><button>Agregar</button></div></form>`
      );
    })
  );

  const save = async (req, res, confirm) => {
    const { value, errors } = lg.parseEntry({ ...req.body, ...(confirm ? { status: 'confirmada' } : {}) }, today());
    if (errors.length) return go(res, '/guia', { err: errors.join(' ') });
    return value;
  };

  r.post(
    '/guia',
    ah(async (req, res) => {
      const v = await save(req, res, false);
      if (res.headersSent) return;
      const n = (await db.query('SELECT coalesce(max(sort), -1) + 1 AS n FROM leader_guide')).rows[0].n;
      await db.query('INSERT INTO leader_guide (category, question, answer, contact, source, status, review_by, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)', [v.category, v.question, v.answer, v.contact, v.source, v.status, v.review_by, n]);
      go(res, '/guia', { ok: 'Respuesta agregada.' });
    })
  );
  const update = (confirm) =>
    ah(async (req, res) => {
      const v = await save(req, res, confirm);
      if (res.headersSent) return;
      await db.query('UPDATE leader_guide SET category=$2, question=$3, answer=$4, contact=$5, source=$6, status=$7, review_by=$8, active=$9, updated_at=now() WHERE id=$1', [+req.params.id, v.category, v.question, v.answer, v.contact, v.source, v.status, v.review_by, v.active]);
      go(res, '/guia', { ok: confirm ? 'Respuesta confirmada: ya la ven los líderes.' : 'Respuesta guardada.' });
    });
  r.post('/guia/:id(\\d{1,9})', update(false));
  r.post('/guia/:id(\\d{1,9})/confirmar', update(true));
  r.post(
    '/guia/:id(\\d{1,9})/eliminar',
    ah(async (req, res) => {
      await db.query('DELETE FROM leader_guide WHERE id = $1', [+req.params.id]);
      go(res, '/guia', { ok: 'Respuesta borrada.' });
    })
  );

  return r;
}

module.exports = { leaderGuideRouter };
