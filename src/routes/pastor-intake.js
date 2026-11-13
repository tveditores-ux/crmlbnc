'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const { CONGREGATIONS } = require('../care-groups');
const intake = require('../pastor-intake');
const { CIVIL_STATUS } = require('../member-intake');
const { birthRoll, photoScript } = require('../views/care-leader-form');
const { CSS } = require('./care-remote');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Registro ministerial: un enlace para pastores y servidores de los ministerios. Sin sesión; el enlace es el secreto. */
function pastorIntakeRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 20 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    res.status(o.status).send(o.html);
  };
  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a la iglesia.</p></div>', 404);

  function form(v = {}, errors = [], funciones = intake.FUNCIONES) {
    const st = 'font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)';
    const sel = (name, label, options, first, required = false) =>
      `<label for="${name}">${label}</label><select id="${name}" name="${name}" ${required ? 'required' : ''} style="${st}"><option value="">${first}</option>${options
        .map((o) => `<option ${v[name] === o ? 'selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`;
    const t = (name, label, extra = '') => `<label for="${name}">${label}</label><input id="${name}" type="text" name="${name}" value="${esc(v[name] || '')}" ${extra}>`;
    return `<h1>Registro ministerial</h1>
      <p class="muted" style="font-size:14px">Llena esta planilla una sola vez para registrar tu ficha ministerial en <strong>${esc(config.churchName)}</strong>. Toma unos dos minutos. Tus datos solo los ve el equipo de la iglesia.</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        <h2>Tu función</h2>
        ${sel('funcion', '¿Cuál es tu función o ministerio?', funciones, 'Elige…', true)}
        <h2>Tus datos</h2>
        ${t('full_name', 'Nombre y apellido', 'maxlength="120" required placeholder="Nombre y apellido"')}
        <label for="phone">Teléfono (WhatsApp)</label><input id="phone" type="tel" inputmode="tel" name="phone" required value="${esc(v.phone || '')}" placeholder="0414-000.00.00">
        ${birthRoll(v, today(), 'Fecha de nacimiento')}
        <label for="cedula">Cédula de identidad (C.I.)</label><input id="cedula" type="text" name="cedula" required maxlength="14" autocapitalize="characters" value="${esc(v.cedula || '')}" placeholder="V-12345678">
        ${t('address', 'Dirección', 'maxlength="250" required')}
        ${sel('civil_status', 'Estado civil', CIVIL_STATUS, 'Elige…', true)}
        ${sel('congregation', '¿Cuál es tu congregación?', CONGREGATIONS, 'Elige…', true)}
        <label for="email">Correo</label><input id="email" type="email" inputmode="email" name="email" value="${esc(v.email || '')}">
        <h2>Foto (opcional)</h2>
        <div class="photo-box">
          <img id="photo_prev" alt="Vista previa de la foto" ${v.photo_data ? `src="${esc(v.photo_data)}"` : 'style="display:none"'}>
          <div class="quick">
            <label class="btn sec photo-btn">Tomar foto<input id="photo_cam" type="file" accept="image/*" capture="user" hidden></label>
            <label class="btn sec photo-btn">Elegir de la galería<input id="photo_gal" type="file" accept="image/*" hidden></label>
          </div>
          <p id="photo_msg" class="muted" style="font-size:13px;margin:6px 0 0"></p>
          <input type="hidden" id="photo_data" name="photo_data" value="${esc(v.photo_data || '')}">
        </div>
        <label class="check"><input type="checkbox" name="wants_messages" value="1" ${v.wants_messages === '1' ? 'checked' : ''}> Quiero recibir recordatorios de la iglesia por WhatsApp</label>
        <p class="muted" style="font-size:13px;margin:4px 0 0">Es opcional. La iglesia te lo confirmará antes de escribirte.</p>
        <button class="go">Enviar mi registro</button>
      </form>${photoScript({ required: false })}`;
  }

  r.get(
    '/pastores/:token',
    ah(async (req, res) => {
      if (!(await intake.tokenIsValid(db, req.params.token))) return send(res, invalid());
      send(res, shell('Registro ministerial', form({}, [], await intake.functionOptions(db))));
    })
  );

  r.post(
    '/pastores/:token',
    ah(async (req, res) => {
      if (!(await intake.tokenIsValid(db, req.params.token))) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const funciones = await intake.functionOptions(db);
      const sub = intake.parseSubmission(req.body, config.defaultCountryCode, today(), funciones);
      if (sub.errors.length) {
        const keep = sub.photo.error ? {} : { photo_data: req.body.photo_data };
        return send(res, shell('Registro ministerial', form({ ...req.body, ...keep }, sub.errors, funciones), 400));
      }
      const out = await intake.submit(db, sub);
      send(
        res,
        shell(
          'Recibido',
          `<h1>¡Gracias!</h1>
          <div class="ok">${out.applied ? '<strong>Tu registro quedó guardado.</strong>' : '<strong>Recibimos tu registro.</strong> La iglesia lo revisará y lo guardará en tu ficha.'}</div>
          <p class="muted">Si algo cambia o te equivocaste, vuelve a abrir este enlace y envíalo otra vez.</p>`
        )
      );
    })
  );

  return r;
}

module.exports = { pastorIntakeRouter };
