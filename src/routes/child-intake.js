'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const intake = require('../child-intake');
const phoneGuard = require('../phone-guard');
const { birthRoll } = require('../views/care-leader-form');
const { CSS } = require('./care-remote');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Registro de niños y adolescentes: un enlace para los padres y representantes. Sin sesión; el enlace es el secreto. */
function childIntakeRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 20 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales, y de menores
    res.status(o.status).send(o.html);
  };
  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a la iglesia.</p></div>', 404);

  const photoBlock = (prefix, dataName, titulo, v) => `
        <div style="margin-top:14px">
          <label>${titulo}</label>
          <img id="${prefix}_prev" alt="" src="${esc(v[dataName] || '')}" style="${v[dataName] ? '' : 'display:none;'}max-width:180px;border-radius:10px;margin:8px 0">
          <div>
            <label class="btn sec">Tomar foto<input id="${prefix}_cam" type="file" accept="image/*" capture="environment" hidden></label>
            <label class="btn sec">Elegir de la galería<input id="${prefix}_gal" type="file" accept="image/*" hidden></label>
          </div>
          <p id="${prefix}_msg" class="muted" style="font-size:13px;margin:6px 0 0"></p>
          <input type="hidden" id="${prefix}_data" name="${dataName}" value="${esc(v[dataName] || '')}">
        </div>`;

  const TWO_PHOTOS_SCRIPT = `<script>
        (function () {
          function foto(prefix, dataId) {
            var data = document.getElementById(dataId), prev = document.getElementById(prefix + '_prev'), msg = document.getElementById(prefix + '_msg');
            function take(file) {
              if (!file) return;
              msg.textContent = 'Preparando la foto…';
              var url = URL.createObjectURL(file), img = new Image();
              img.onload = function () {
                var s = Math.min(1, 900 / Math.max(img.width, img.height)), c = document.createElement('canvas');
                c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                data.value = c.toDataURL('image/jpeg', 0.82);
                prev.src = data.value; prev.style.display = 'block';
                msg.textContent = 'Foto lista. Se enviará al registrar.';
                URL.revokeObjectURL(url);
              };
              img.onerror = function () { msg.textContent = 'No pude leer esa foto. Prueba con otra.'; URL.revokeObjectURL(url); };
              img.src = url;
            }
            [prefix + '_cam', prefix + '_gal'].forEach(function (id) { document.getElementById(id).addEventListener('change', function (e) { take(e.target.files[0]); }); });
            return { ok: function () { return !!(data.value || prev.getAttribute('src')); }, falta: function () { msg.textContent = 'Falta esta foto para completar el registro.'; msg.style.color = 'var(--bad)'; prev.scrollIntoView({ block: 'center' }); } };
          }
          var nino = foto('pc', 'photo_child_data'), padre = foto('pp', 'photo_parent_data');
          document.querySelector('form').addEventListener('submit', function (e) {
            if (!nino.ok()) { e.preventDefault(); nino.falta(); return; }
            if (!padre.ok()) { e.preventDefault(); padre.falta(); }
          });
        })();
      </script>`;

  function form(v = {}, errors = []) {
    const st = 'font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)';
    const t = (name, label, extra = '') => `<label for="${name}">${label}</label><input id="${name}" type="text" name="${name}" value="${esc(v[name] || '')}" ${extra}>`;
    return `<h1>Registro de niños y adolescentes</h1>
      <p class="muted" style="font-size:14px">Si tu hijo asiste a nuestra congregación de <strong>niños, preadolescentes o adolescentes</strong>, regístralo acá. La congregación se asigna según su edad (Niños de 3 a 10 años, Preadolescentes de 11 a 13, Adolescentes de 14 a 17). Tus datos y las fotos solo los ve el equipo de la iglesia.</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        <h2>El niño o adolescente</h2>
        ${t('child_name', 'Nombre y apellido del niño o adolescente', 'maxlength="120" required placeholder="Nombre y apellido"')}
        ${birthRoll(v, today(), 'Fecha de nacimiento del niño o adolescente')}
        ${photoBlock('pc', 'photo_child_data', 'Foto del niño o adolescente', v)}
        <h2>El papá, la mamá o el representante</h2>
        ${t('parent_name', 'Tu nombre y apellido', 'maxlength="120" required placeholder="Nombre y apellido"')}
        <label for="parent_relation">¿Quién registra al niño?</label>
        <select id="parent_relation" name="parent_relation" required style="${st}"><option value="">Elige…</option>${intake.RELATIONS.map(
          (o) => `<option ${v.parent_relation === o ? 'selected' : ''}>${esc(o)}</option>`
        ).join('')}</select>
        <label for="parent_phone">Tu teléfono (WhatsApp)</label><input id="parent_phone" type="tel" inputmode="tel" name="parent_phone" required value="${esc(v.parent_phone || '')}" placeholder="0414-000.00.00">
        ${photoBlock('pp', 'photo_parent_data', 'Tu foto (la del papá, la mamá o el representante)', v)}
        <button class="go" style="margin-top:16px">Registrar</button>
      </form>${TWO_PHOTOS_SCRIPT}`;
  }

  const confirmHtml = (body, v) => `<h1>Ya está registrado</h1>
  <div class="card"><p><strong>${esc(v.child_name)}</strong> ya tiene un registro. Si lo que quieres es <strong>actualizar sus datos</strong> con la información que acabas de enviar, confírmalo aquí:</p>
  <form method="post">${phoneGuard.hiddenFields(body)}<input type="hidden" name="es_actualizacion" value="1"><button class="go">Sí, actualizar sus datos</button></form>
  <p class="muted" style="margin-top:10px">Si no quieres cambiar nada, cierra esta página: no se guardó ningún cambio.</p></div>`;

  r.get(
    '/ninos/:token',
    ah(async (req, res) => {
      if (!(await intake.linkIsValid(db, req.params.token))) return send(res, invalid());
      send(res, shell('Registro de niños y adolescentes', form()));
    })
  );

  r.post(
    '/ninos/:token',
    ah(async (req, res) => {
      if (!(await intake.linkIsValid(db, req.params.token))) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const sub = intake.parseSubmission(req.body, config.defaultCountryCode, today());
      if (sub.errors.length) {
        const keep = {};
        if (!sub.photoChild.error && req.body.photo_child_data) keep.photo_child_data = req.body.photo_child_data;
        if (!sub.photoParent.error && req.body.photo_parent_data) keep.photo_parent_data = req.body.photo_parent_data;
        return send(res, shell('Registro de niños y adolescentes', form({ ...req.body, ...keep }, sub.errors), 400));
      }
      // el mismo niño (nombre + fecha de nacimiento) ya registrado: se pregunta si es una actualización
      const ya = await intake.findRegistered(db, sub.value);
      if (ya && req.body.es_actualizacion !== '1') {
        return send(res, shell('Ya está registrado', confirmHtml(req.body, sub.value)));
      }
      await intake.submit(db, sub);
      send(
        res,
        shell(
          'Recibido',
          `<h1>¡Gracias!</h1>
          <div class="ok"><strong>Registramos a ${esc(sub.value.child_name)}.</strong> Quedó en la congregación de <strong>${esc(sub.value.congregation)}</strong>. La iglesia revisará el registro y lo guardará en su ficha.</div>
          <p class="muted">Si algo cambia o te equivocaste, vuelve a abrir este enlace y envíalo otra vez.</p>`
        )
      );
    })
  );

  return r;
}

module.exports = { childIntakeRouter };
