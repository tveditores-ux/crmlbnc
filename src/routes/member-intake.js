'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const { CONGREGATIONS } = require('../care-groups');
const intake = require('../member-intake');
const { birthRoll, photoScript } = require('../views/care-leader-form');
const { CSS } = require('./care-remote');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** "Mis datos": un enlace para todas las personas de la iglesia. Sin sesión; el enlace es el secreto. */
function memberIntakeRouter(ctx) {
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

  const groupNames = async () => (await db.query('SELECT name FROM care_groups WHERE active ORDER BY lower(name)')).rows.map((g) => g.name);

  function form(groups, v = {}, errors = []) {
    const st = 'font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)';
    const sel = (name, label, options, first, required = false) =>
      `<label for="${name}">${label}</label><select id="${name}" name="${name}" ${required ? 'required' : ''} style="${st}"><option value="">${first}</option>${options
        .map((o) => `<option ${v[name] === o ? 'selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`;
    const t = (name, label, extra = '') => `<label for="${name}">${label}</label><input id="${name}" type="text" name="${name}" value="${esc(v[name] || '')}" ${extra}>`;
    return `<h1>Mis datos</h1>
      <p class="muted" style="font-size:14px">Llena esta planilla una sola vez para actualizar tu ficha en <strong>${esc(config.churchName)}</strong>. Toma unos dos minutos. Tus datos solo los ve el equipo de la iglesia. Si eres menor de edad, pídele a tu papá o mamá que te ayude.</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        <h2>Tú</h2>
        ${t('full_name', 'Nombre y apellido', 'maxlength="120" required placeholder="Nombre y apellido"')}
        <label for="phone">Teléfono (WhatsApp)</label><input id="phone" type="tel" inputmode="tel" name="phone" required value="${esc(v.phone || '')}" placeholder="0414-000.00.00">
        ${birthRoll(v, today(), 'Fecha de nacimiento')}
        ${sel('congregation', '¿Cuál es tu congregación?', CONGREGATIONS, 'Elige…', true)}
        ${sel('care_group_name', 'Tu grupo de cuidado', [...groups, intake.NO_GROUP], 'Elige… (opcional)')}
        <h2>Más datos (opcionales)</h2>
        <label for="cedula">Cédula de identidad (C.I.)</label><input id="cedula" type="text" name="cedula" maxlength="14" autocapitalize="characters" value="${esc(v.cedula || '')}" placeholder="V-12345678">
        <label for="email">Correo</label><input id="email" type="email" inputmode="email" name="email" value="${esc(v.email || '')}">
        ${t('address', 'Dirección', 'maxlength="250"')}
        ${sel('civil_status', 'Estado civil', intake.CIVIL_STATUS, 'Elige…')}
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
        <button class="go">Enviar mis datos</button>
      </form>${photoScript({ required: false })}`;
  }

  r.get(
    '/mis-datos/:token',
    ah(async (req, res) => {
      if (!(await intake.tokenIsValid(db, req.params.token))) return send(res, invalid());
      send(res, shell('Mis datos', form(await groupNames())));
    })
  );

  r.post(
    '/mis-datos/:token',
    ah(async (req, res) => {
      if (!(await intake.tokenIsValid(db, req.params.token))) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const groups = await groupNames();
      const sub = intake.parseSubmission(req.body, groups, config.defaultCountryCode, today());
      if (sub.errors.length) {
        const keep = sub.photo.error ? {} : { photo_data: req.body.photo_data };
        return send(res, shell('Mis datos', form(groups, { ...req.body, ...keep }, sub.errors), 400));
      }
      const out = await intake.submit(db, sub);
      send(
        res,
        shell(
          'Recibido',
          `<h1>¡Gracias!</h1>
          <div class="ok">${out.applied ? '<strong>Tus datos quedaron guardados.</strong>' : '<strong>Recibimos tus datos.</strong> La iglesia los revisará y los guardará en tu ficha.'}</div>
          <p class="muted">Si algo cambia o te equivocaste, vuelve a abrir este enlace y envíalos otra vez.</p>`
        )
      );
    })
  );

  return r;
}

module.exports = { memberIntakeRouter };
