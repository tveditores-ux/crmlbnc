'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { createRateLimiter } = require('../attendance-store');
const { parseReport, upsertReport } = require('../care-groups');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CSS = `<style>
.remote{max-width:520px;margin:0 auto}
.remote h1{font-size:22px;margin:4px 0 2px}
.remote label{font-weight:600;margin-top:14px;display:block}
.remote input,.remote textarea{font-size:20px;padding:12px;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;background:#fff}
.remote textarea{font-size:16px;min-height:80px}
.remote .pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.remote .pair>div{min-width:0}
.remote input[type=date]{min-width:0;max-width:100%;font-size:18px;-webkit-appearance:none;appearance:none;min-height:54px}
.remote .pair label{font-size:13px}
.remote .check{display:flex;gap:10px;align-items:center;font-weight:600;margin-top:18px}
.remote .check input{width:26px;height:26px;flex:none}
.remote .go{width:100%;font-size:20px;padding:16px;margin-top:20px}
.remote h2{font-size:15px;margin:22px 0 0;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.remote .ok{background:var(--ok-bg);color:var(--ok);border-radius:12px;padding:18px;margin-top:14px;font-size:17px}
.hp{position:absolute;left:-9999px;height:0;overflow:hidden}
</style>`;

/** Formulario del teléfono para que el líder de un grupo de cuidado reporte su reunión. Protegido por enlace secreto. */
function careRemoteRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 30 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(o.status).send(o.html);
  };

  async function findGroup(token) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
    const { rows } = await db.query('SELECT id, name, leader_name, meeting_day, active, link_active FROM care_groups WHERE token = $1', [token]);
    return rows[0] && rows[0].active && rows[0].link_active ? rows[0] : null;
  }

  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a quien administra el panel.</p></div>', 404);

  function form(g, v = {}, errors = []) {
    const num = (key, label) =>
      `<div><label for="${key}">${label}</label><input id="${key}" type="number" min="0" step="1" inputmode="numeric" name="${key}" value="${esc(v[key] ?? '')}"></div>`;
    const area = (key, label, hint = '') =>
      `<label for="${key}">${label}</label><textarea id="${key}" name="${key}" placeholder="${esc(hint)}">${esc(v[key] || '')}</textarea>`;
    return `<h1>Reporte del grupo</h1>
      <p class="sub" style="margin:0"><strong>${esc(g.name)}</strong>${g.leader_name ? ` · ${esc(g.leader_name)}` : ''}</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        <label for="meeting_date">Fecha de la reunión</label>
        <input id="meeting_date" type="date" name="meeting_date" required value="${esc(v.meeting_date || today())}">
        <h2>Resumen</h2>
        <div class="pair">${num('members_count', 'Miembros')}${num('guests_count', 'Invitados')}</div>
        <div class="pair">${num('attendance', 'Total de asistentes')}
          <div><label for="offering">Ofrenda</label><input id="offering" type="text" inputmode="decimal" name="offering" value="${esc(v.offering ?? '')}" placeholder="0.00"></div></div>
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
        <button class="go">Enviar reporte</button>
      </form>
      <script>document.querySelectorAll('input[type=number]').forEach(function(i){ i.addEventListener('focus', function(){ i.select(); }); });</script>`;
  }

  r.get(
    '/g/:token',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      send(res, shell('Reporte del grupo', form(g)));
    })
  );

  r.post(
    '/g/:token',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const { value, errors } = parseReport(req.body, today());
      if (errors.length) return send(res, shell('Reporte del grupo', form(g, req.body, errors), 400));
      const out = await upsertReport(db, g.id, value, 'telefono');
      await db.query('UPDATE care_groups SET uses = uses + 1, last_used_at = now() WHERE id = $1', [g.id]);
      send(
        res,
        shell(
          'Reporte enviado',
          `<h1>¡Gracias!</h1>
          <div class="ok"><strong>${out.created ? 'Reporte recibido' : 'Reporte corregido'}</strong><br>
            ${esc(g.name)} · ${esc(value.meeting_date)}<br>
            Asistentes: ${value.attendance ?? '—'}${value.guests_count ? ` · Invitados: ${value.guests_count}` : ''}</div>
          <p class="muted">Si te equivocaste, vuelve a enviar la misma fecha y se corrige.</p>
          <a class="btn go" style="display:block;text-align:center;box-sizing:border-box" href="/g/${esc(req.params.token)}">Enviar otro reporte</a>`
        )
      );
    })
  );

  return r;
}

module.exports = { careRemoteRouter };
