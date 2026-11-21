'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const intake = require('../child-intake');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const short = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');
const shortDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');

/** Registro de niños y adolescentes: compartir su enlace y revisar lo que llega. */
function childRequestsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use(['/ninos'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos de menores
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/personas', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const jpeg = (res, buf) => {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(buf));
  };

  const DEFAULT_ASK = `Hola, la paz del Señor. Si tu hijo asiste a la congregación de niños, preadolescentes o adolescentes de ${config.churchName || 'la iglesia'}, regístralo acá, por favor: {enlace} Se llena desde tu teléfono con la fecha de nacimiento del niño y una foto suya y una tuya. ¡Gracias!`;

  r.get(
    '/ninos',
    ah(async (req, res) => {
      const link = await intake.ensureLink(db);
      const url = `${config.publicUrl}/ninos/${link.token}`;
      const ask = DEFAULT_ASK.replace('{enlace}', url);
      const pending = await intake.listPending(db);
      const recent = (await db.query("SELECT id, child_name, congregation, person_id, resolved_at FROM child_submissions WHERE status = 'aplicada' ORDER BY resolved_at DESC LIMIT 20")).rows;
      page(
        req,
        res,
        'Registro de niños y adolescentes',
        `<h1>Registro de niños y adolescentes <a class="btn sec" href="/registros">← Registros</a></h1>
      <div class="card"><h3 style="margin-top:0">Enlace para los padres y representantes ${link.active ? '<span class="badge b-ok">Encendido</span>' : '<span class="badge b-warn">Apagado</span>'}</h3>
        <p class="sub">Un solo enlace para registrar a los niños de 3 a 10 años, los preadolescentes de 11 a 13 y los adolescentes de 14 a 17: la congregación se asigna por la fecha de nacimiento. Compártelo con los padres; cada registro espera tu revisión aquí abajo antes de entrar en Personas.</p>
        <div class="row"><input id="lnk" type="text" readonly value="${esc(url)}" style="flex:1;min-width:260px"><button class="btn sec" type="button" data-copy="#lnk">Copiar enlace</button>
        <a class="btn sec" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(ask)}">Compartir por WhatsApp</a></div>
        <div class="row" style="margin-top:8px"><form method="post" action="/ninos/enlace/nuevo"><button class="btn sec">Generar enlace nuevo</button></form>
        <form method="post" action="/ninos/enlace/${link.active ? 'apagar' : 'encender'}"><button class="btn sec">${link.active ? 'Apagar el enlace' : 'Encender el enlace'}</button></form></div>
      </div>
      <div class="card"><h3 style="margin-top:0">Las congregaciones</h3>
        <p class="sub">Al guardar un registro, el niño queda en Personas con su congregación según su edad. Desde aquí ves cada una por separado:</p>
        <div class="row"><a class="btn sec" href="/personas?c=${encodeURIComponent('Niños')}">Niños (3 a 10)</a>
        <a class="btn sec" href="/personas?c=${encodeURIComponent('Preadolescentes')}">Preadolescentes (11 a 13)</a>
        <a class="btn sec" href="/personas?c=${encodeURIComponent('Adolescentes')}">Adolescentes (14 a 17)</a></div>
      </div>
      <h2>Por revisar (${pending.length})</h2>
      ${
        pending.length
          ? pending
              .map(
                (s) => `<div class="card"><div class="row" style="align-items:flex-start;gap:16px">
          <div style="text-align:center">${s.has_child_photo ? `<img src="/ninos/respuestas/${s.id}/foto-hijo" alt="Foto del niño" style="width:110px;height:110px;object-fit:cover;border-radius:10px">` : '<span class="sub">Sin foto</span>'}<div class="sub">El niño</div></div>
          <div style="text-align:center">${s.has_parent_photo ? `<img src="/ninos/respuestas/${s.id}/foto-representante" alt="Foto del representante" style="width:110px;height:110px;object-fit:cover;border-radius:10px">` : '<span class="sub">Sin foto</span>'}<div class="sub">El representante</div></div>
          <div style="flex:1;min-width:240px"><strong>${esc(s.child_name)}</strong> <span class="badge b-info">${esc(s.congregation)}</span>
            <div class="sub">Nació el ${shortDate(s.birth_date)} · Llegó el ${short(s.created_at)}</div>
            ${s.food_allergy ? `<div style="margin-top:6px">🍽️ <strong>Alergias o alimentos que no puede comer:</strong> ${esc(s.food_allergy)}</div>` : ''}
            <div style="margin-top:6px">Representante: <strong>${esc(s.parent_name)}</strong> (${esc(s.parent_relation)}) · ${esc(displayPhone(s.parent_phone))}</div>
            <div class="row" style="margin-top:10px"><form method="post" action="/ninos/respuestas/${s.id}/aplicar"><button>Guardar en Personas</button></form>
            <form method="post" action="/ninos/respuestas/${s.id}/descartar" onsubmit="return confirm('¿Descartar este registro? Se borran las fotos y no se puede deshacer.')"><button class="btn danger">Descartar</button></form></div>
          </div></div></div>`
              )
              .join('')
          : '<div class="card"><p class="sub">Nada por revisar. Cuando un representante registre a su hijo, aparecerá aquí.</p></div>'
      }
      ${
        recent.length
          ? `<h2>Guardados recientemente</h2><div class="card"><ul>${recent
              .map((s) => `<li>${esc(s.child_name)} — ${esc(s.congregation)}${s.person_id ? ` · <a href="/personas/${s.person_id}">ver su ficha</a>` : ''}</li>`)
              .join('')}</ul></div>`
          : ''
      }`
      );
    })
  );

  r.post(
    '/ninos/enlace/:accion',
    ah(async (req, res) => {
      const a = req.params.accion;
      if (a === 'nuevo') await intake.regenerateLink(db);
      else if (a === 'encender') await intake.setLinkActive(db, true);
      else if (a === 'apagar') await intake.setLinkActive(db, false);
      go(res, '/ninos', { ok: 'Enlace actualizado.' });
    })
  );

  r.post(
    '/ninos/respuestas/:id/aplicar',
    ah(async (req, res) => {
      const out = await intake.apply(db, Number(req.params.id));
      if (out.error) return go(res, '/ninos', { err: out.error });
      go(res, '/ninos', { ok: 'Registro guardado en Personas.' });
    })
  );

  r.post(
    '/ninos/respuestas/:id/descartar',
    ah(async (req, res) => {
      const okDone = await intake.discard(db, Number(req.params.id));
      go(res, '/ninos', okDone ? { ok: 'Registro descartado.' } : { err: 'Ese registro ya fue atendido.' });
    })
  );

  const photo = (col) =>
    ah(async (req, res) => {
      const row = (await db.query(`SELECT ${col} AS data FROM child_submissions WHERE id = $1`, [Number(req.params.id)])).rows[0];
      if (!row || !row.data) return res.status(404).send('Sin foto');
      jpeg(res, row.data);
    });
  r.get('/ninos/respuestas/:id/foto-hijo', photo('photo_child'));
  r.get('/ninos/respuestas/:id/foto-representante', photo('photo_parent'));

  return r;
}

module.exports = { childRequestsRouter };
