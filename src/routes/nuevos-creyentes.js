'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const { CIVIL_STATUS } = require('../member-intake');
const nb = require('../new-believer-intake');
const { CSS } = require('./care-remote');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Remoto del registro de nuevos creyentes (`/nuevos-creyentes/<token>`): un solo enlace para
 * llenar EL DÍA de la conversión, en el momento de la decisión. Sin sesión. Lo enviado entra a
 * la lista de Nueva Vida marcado por revisar (fuente «Enlace del día de conversión»).
 */
function nuevosCreyentesRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 30 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(o.status).send(o.html);
  };
  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a quien administra el panel.</p></div>', 404);
  const honey = '<div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>';
  const selStyle = 'style="font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)"';

  function form(token, v = {}, errors = [], sedes = []) {
    const sel = (key, label, options, required) =>
      `<label for="${key}">${label}${required ? '' : ' (opcional)'}</label>
       <select id="${key}" name="${key}" ${selStyle} ${required ? 'required' : ''}>
         <option value="">Elige…</option>
         ${options.map((o) => `<option ${v[key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
       </select>`;
    const sedeField = sedes.length
      ? sel('sede', 'Sede donde se convirtió', sedes, true)
      : `<label for="sede">Sede donde se convirtió</label><input id="sede" type="text" name="sede" required value="${esc(v.sede || '')}" placeholder="Ej.: Cabudare">`;
    return `<h1>Registro de nuevo creyente</h1>
      <p class="sub" style="margin:0">Nueva Vida · ${esc(config.churchName)}</p>
      <p class="muted" style="font-size:14px">Para llenar el día de su conversión, en el momento de la decisión. Queda registrado en Nueva Vida para su seguimiento y consolidación.</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off" onsubmit="var b=this.querySelector('button.go');if(b){b.disabled=true;b.textContent='Registrando…'}">${honey}
        <label for="full_name">Nombre y apellido del nuevo creyente</label>
        <input id="full_name" type="text" name="full_name" maxlength="120" required value="${esc(v.full_name || '')}" placeholder="Ej.: María Pérez">
        <label for="phone">Su número de WhatsApp</label>
        <input id="phone" type="tel" name="phone" required value="${esc(v.phone || '')}" placeholder="Ej.: 0414 123 4567">
        <p class="muted" style="font-size:13px;margin:2px 0 0">Es el medio para llamarlo en el seguimiento de Nueva Vida.</p>
        <label for="decision_date">Fecha de la decisión</label>
        <input id="decision_date" type="date" name="decision_date" required max="${today()}" value="${esc(v.decision_date || today())}">
        ${sedeField}
        ${sel('service', '¿En qué servicio se convirtió?', nb.SERVICES, true)}
        ${sel('first_time', '¿Es tu primera vez en la iglesia?', nb.FIRST_TIME, true)}
        ${sel('decision_type', '¿Fue conversión o reconciliación?', nb.DECISION_TYPES, true)}
        ${sel('how_arrived', '¿Cómo llegó a la iglesia?', nb.HOW_ARRIVED, true)}
        <h2>Si los tienes a mano (opcional)</h2>
        <div class="pair">
          <div><label for="age">Edad</label><input id="age" type="number" min="0" max="120" inputmode="numeric" name="age" value="${esc(v.age ?? '')}"></div>
          <div>${sel('civil_status', 'Estado civil', CIVIL_STATUS, false)}</div>
        </div>
        <label for="email">Correo (opcional)</label>
        <input id="email" type="email" name="email" value="${esc(v.email || '')}">
        <label for="address">Dirección (opcional)</label>
        <input id="address" type="text" name="address" maxlength="300" value="${esc(v.address || '')}">
        <button class="go">Registrar su decisión</button>
      </form>`;
  }

  function duplicate(token, v) {
    const fecha = v.decision_date ? v.decision_date.split('-').reverse().join('/') : '';
    return `<div class="card" style="text-align:center">
      <h1>Ya quedó registrado hoy ✅</h1>
      <p><strong>${esc(v.full_name || '')}</strong> ya tiene su registro${fecha ? ` con fecha <strong>${esc(fecha)}</strong>` : ''} en Nueva Vida, así que <strong>no se creó otro</strong> para no duplicarlo.</p>
      <p class="muted">Si algún dato quedó mal, el equipo lo corrige desde el panel de Nueva Vida.</p>
      <p><a class="btn" href="/nuevos-creyentes/${esc(token)}">Registrar a otro nuevo creyente</a></p>
    </div>`;
  }

  function success(token, v) {
    const first = esc(String(v.full_name || '').split(' ')[0]);
    const fecha = v.decision_date ? v.decision_date.split('-').reverse().join('/') : '';
    return `<div class="card" style="text-align:center">
      <h1>¡Bienvenido${first ? `, ${first}` : ''}, a la familia de Dios! 🎉</h1>
      <p>La decisión de <strong>${esc(v.full_name || '')}</strong> quedó registrada${fecha ? ` con fecha <strong>${esc(fecha)}</strong>` : ''} en Nueva Vida.</p>
      <p class="muted">El equipo de Nueva Vida lo estará llamando para acompañarlo en sus primeros pasos.</p>
      <p><a class="btn" href="/nuevos-creyentes/${esc(token)}">Registrar a otro nuevo creyente</a></p>
    </div>`;
  }

  r.get(
    '/nuevos-creyentes/:token',
    ah(async (req, res) => {
      if (!(await nb.linkIsValid(db, req.params.token))) return send(res, invalid());
      const sedes = await nb.listSedes(db);
      send(res, shell('Registro de nuevo creyente', form(req.params.token, {}, [], sedes)));
    })
  );

  r.post(
    '/nuevos-creyentes/:token',
    ah(async (req, res) => {
      if (!(await nb.linkIsValid(db, req.params.token))) return send(res, invalid());
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de registrar a otro.</p></div>', 429));
      }
      const body = req.body || {};
      if (String(body.web || '').trim()) return send(res, shell('Registro de nuevo creyente', success(req.params.token, { full_name: body.full_name, decision_date: today() }))); // señuelo antirobots
      const { value, errors } = nb.parseSubmission(body, config.defaultCountryCode, today());
      if (errors.length) {
        const sedes = await nb.listSedes(db);
        const back = { full_name: body.full_name, phone: body.phone, email: body.email, decision_date: body.decision_date, sede: body.sede, service: body.service, first_time: body.first_time, decision_type: body.decision_type, age: body.age, civil_status: body.civil_status, address: body.address, how_arrived: body.how_arrived };
        return send(res, shell('Registro de nuevo creyente', form(req.params.token, back, errors, sedes)));
      }
      const dup = await nb.findSameDay(db, value);
      if (dup) return send(res, shell('Ya quedó registrado', duplicate(req.params.token, value)));
      await nb.submit(db, value);
      send(res, shell('Registro de nuevo creyente', success(req.params.token, value)));
    })
  );

  return r;
}

module.exports = { nuevosCreyentesRouter };
