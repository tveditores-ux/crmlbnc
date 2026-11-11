'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const { parseReport, STAGES: cgStages } = require('../care-groups');
const crl = require('../care-report-link');
const { CSS } = require('./care-remote');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Remoto de reporte SEMANAL, aparte del enlace de cada grupo (`/g/<token>`): un solo enlace para todos los
 * líderes (`/reportes/<token>`, token en care_settings), sin sesión y sin pestañas — solo el reporte.
 * El líder escribe su nombre (se le queda guardado en su teléfono) y envía; el mismo enlace sirve cada semana.
 */
function reporteComunRouter(ctx) {
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

  function form(token, v = {}, errors = []) {
    const num = (key, label) =>
      `<div><label for="${key}">${label}</label><input id="${key}" type="number" min="0" step="1" inputmode="numeric" name="${key}" value="${esc(v[key] ?? '')}"></div>`;
    const area = (key, label, hint = '') =>
      `<label for="${key}">${label}</label><textarea id="${key}" name="${key}" placeholder="${esc(hint)}">${esc(v[key] || '')}</textarea>`;
    return `<h1>Reporte semanal</h1>
      <p class="sub" style="margin:0">Grupo de cuidado · ${esc(config.churchName)}</p>
      <p class="muted" style="font-size:14px">Escribe tu nombre una vez y este teléfono lo recuerda. Este mismo enlace te sirve cada semana: guárdalo en tu pantalla de inicio como «Reporte».</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">${honey}
        <label for="leader_name">Tu nombre y apellido</label>
        <input id="leader_name" type="text" name="leader_name" maxlength="80" required value="${esc(v.leader_name || '')}" placeholder="Ej.: María Pérez">
        <label for="meeting_date">Fecha de la reunión</label>
        <input id="meeting_date" type="date" name="meeting_date" required value="${esc(v.meeting_date || today())}">
        <div class="pair">
          <div><label for="start_time">Hora de entrada</label><input id="start_time" type="time" name="start_time" value="${esc(v.start_time || '')}"></div>
          <div><label for="end_time">Hora de salida</label><input id="end_time" type="time" name="end_time" value="${esc(v.end_time || '')}"></div></div>
        <div class="pair">
          <div><label for="stage">Etapa del grupo</label><select id="stage" name="stage" style="font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)"><option value="">Sin definir</option>${cgStages.map((s) => `<option ${v.stage === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
          ${num('stage_week', 'Semana de la etapa')}</div>
        <h2>Resumen</h2>
        <div class="pair">${num('members_count', 'Miembros')}${num('guests_count', 'Invitados')}</div>
        <div class="pair">${num('attendance', 'Total de asistentes')}${num('recent_guests', 'Invitados de las últimas 3 semanas')}</div>
        <h2>Ofrendas</h2>
        <div class="pair">
          <div><label for="offering">En bolívares</label><input id="offering" type="text" inputmode="decimal" name="offering" value="${esc(v.offering ?? '')}" placeholder="0.00"></div>
          <div><label for="offering_fx">En divisas</label><input id="offering_fx" type="text" inputmode="decimal" name="offering_fx" value="${esc(v.offering_fx ?? '')}" placeholder="0.00"></div></div>
        <label for="payment_ref">Pago móvil o transferencia: últimos 4 números de la referencia</label>
        <input id="payment_ref" type="text" inputmode="numeric" name="payment_ref" maxlength="4" pattern="\\d{0,4}" value="${esc(v.payment_ref || '')}" placeholder="0000">
        <h2>La reunión</h2>
        ${area('snack', 'Tiempo de refrigerio')}
        ${area('dynamics', 'Dinámicas')}
        ${area('testimonies', 'Testimonios (resumen)')}
        ${area('songs', 'Canciones')}
        ${area('key_element', 'Elemento clave')}
        <h2>Cierre</h2>
        ${area('followup', 'Seguimiento', 'Personas que necesitan una llamada o una visita')}
        ${area('notes', 'Notas')}
        <label class="check"><input type="checkbox" name="advisor_visit" value="1" ${v.advisor_visit ? 'checked' : ''}> Nos visitó el líder asesor</label>
        <h2>El líder en los servicios</h2>
        <div class="pair">${[['leader_wed', 'Asistió el miércoles'], ['leader_sun', 'Asistió el domingo']].map(([k, l]) => `<div><label for="${k}">${l}</label><select id="${k}" name="${k}" style="font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)"><option value="">—</option><option value="si" ${v[k] === 'si' || v[k] === true ? 'selected' : ''}>Sí</option><option value="no" ${v[k] === 'no' || v[k] === false ? 'selected' : ''}>No</option></select></div>`).join('')}</div>
        <button class="go">Enviar reporte</button>
      </form>
      <script>
        var n = document.getElementById('leader_name');
        try {
          if (!n.value) n.value = localStorage.getItem('reporte_nombre') || '';
          document.querySelector('form').addEventListener('submit', function(){ try { localStorage.setItem('reporte_nombre', n.value); } catch (e) {} });
        } catch (e) {}
        document.querySelectorAll('input[type=number]').forEach(function(i){ i.addEventListener('focus', function(){ i.select(); }); });
      </script>`;
  }

  r.get(
    '/reportes/:token',
    ah(async (req, res) => {
      if (!(await crl.linkIsValid(db, req.params.token))) return send(res, invalid());
      send(res, shell('Reporte semanal', form(req.params.token)));
    })
  );

  r.post(
    '/reportes/:token',
    ah(async (req, res) => {
      if (!(await crl.linkIsValid(db, req.params.token))) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>'));
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const name = crl.parseLeaderName(req.body.leader_name);
      const { value, errors } = parseReport(req.body, today());
      if (name.error) errors.unshift(name.error);
      if (errors.length) return send(res, shell('Reporte semanal', form(req.params.token, { ...req.body, leader_name: req.body.leader_name }, errors), 400));
      const out = await crl.saveCommonReport(db, name.value, value);
      if (out.applied) {
        await db.query('UPDATE care_groups SET uses = uses + 1, last_used_at = now() WHERE id = $1', [out.group.id]);
        return send(
          res,
          shell(
            'Reporte enviado',
            `<h1>¡Gracias, ${esc(name.value.split(' ')[0])}!</h1>
            <div class="ok"><strong>${out.created ? 'Reporte recibido' : 'Reporte corregido'}</strong><br>
              ${esc(out.group.name)} · ${esc(value.meeting_date)}<br>
              Asistentes: ${value.attendance ?? '—'}${value.guests_count ? ` · Invitados: ${value.guests_count}` : ''}</div>
            <p class="muted">Si te equivocaste, vuelve a enviar la misma fecha y se corrige. Este mismo enlace te sirve la próxima semana.</p>
            <a class="btn go" style="display:block;text-align:center;box-sizing:border-box" href="/reportes/${esc(req.params.token)}">Enviar otro reporte</a>`
          )
        );
      }
      send(
        res,
        shell(
          'Reporte enviado',
          `<h1>¡Gracias, ${esc(name.value.split(' ')[0])}!</h1>
          <div class="ok"><strong>Reporte recibido</strong><br>${esc(value.meeting_date)} · Asistentes: ${value.attendance ?? '—'}</div>
          <p class="muted">Tu reporte llegó. Como tu nombre no coincide con un solo grupo, Administración lo asigna al tuyo en el panel; no tienes que enviarlo otra vez.</p>`
        )
      );
    })
  );

  return r;
}

module.exports = { reporteComunRouter };
