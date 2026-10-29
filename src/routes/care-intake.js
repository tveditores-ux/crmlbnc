'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const { STAGES, DAYS, CONGREGATIONS } = require('../care-groups');
const intake = require('../care-intake');
const { leaderFields, PHOTO_SCRIPT } = require('../views/care-leader-form');
const { CSS } = require('./care-remote');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Enlace común para todos los líderes: eligen su grupo, llenan sus datos y envían. Sin sesión; el enlace es el secreto. */
function careIntakeRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 20 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(o.status).send(o.html);
  };
  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a quien administra el panel.</p></div>', 404);

  const activeGroups = async () => (await db.query('SELECT id, name, leader_phone, congregation FROM care_groups WHERE active')).rows;

  function form(v = {}, errors = []) {
    const options = CONGREGATIONS.map((c) => `<option ${v.congregation === c ? 'selected' : ''}>${esc(c)}</option>`).join('');
    return `<h1>Datos de mi grupo de cuidado</h1>
      <p class="muted" style="font-size:14px">Llena esta planilla una sola vez y envíala. La información llega directo a la iglesia. Toma unos dos minutos.</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        <h2>Mi congregación</h2>
        <label for="congregation">¿Cuál es tu congregación?</label>
        <select id="congregation" name="congregation" required style="font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)">
          <option value="">Elige…</option>${options}
        </select>
        <label for="group_name">Nombre de tu grupo (opcional)</label>
        <input id="group_name" type="text" name="group_name" maxlength="120" value="${esc(v.group_name || '')}">
        <p class="muted" style="font-size:13px;margin:4px 0 0">Si lideras más de un grupo, escribe aquí a cuál te refieres.</p>
        ${leaderFields(v, { today: today(), stages: STAGES, days: DAYS, congregations: CONGREGATIONS, skipCongregation: true })}
        <button class="go">Enviar mis datos</button>
      </form>${PHOTO_SCRIPT}`;
  }

  r.get(
    '/registro/:token',
    ah(async (req, res) => {
      if (!(await intake.tokenIsValid(db, req.params.token))) return send(res, invalid());
      send(res, shell('Datos de mi grupo', form()));
    })
  );

  r.post(
    '/registro/:token',
    ah(async (req, res) => {
      if (!(await intake.tokenIsValid(db, req.params.token))) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const groups = await activeGroups();
      const sub = intake.parseSubmission(req.body, groups, config.defaultCountryCode, today());
      if (sub.errors.length) {
        const keep = sub.photo.error ? {} : { photo_data: req.body.photo_data };
        return send(res, shell('Datos de mi grupo', form({ ...req.body, ...keep, leader_phone_input: req.body.leader_phone }, sub.errors), 400));
      }
      const out = await intake.submit(db, sub);
      send(
        res,
        shell(
          'Recibido',
          `<h1>¡Gracias!</h1>
          <div class="ok">${out.applied ? '<strong>Tus datos ya quedaron actualizados.</strong>' : '<strong>Recibimos tus datos.</strong> La iglesia los revisará y los guardará.'}</div>
          <p class="muted">Si algo cambia o te equivocaste, vuelve a abrir este enlace y envíalos otra vez.</p>`
        )
      );
    })
  );

  return r;
}

module.exports = { careIntakeRouter };
