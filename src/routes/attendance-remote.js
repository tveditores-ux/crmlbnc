'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { parseAttendance } = require('./attendance');
const { dayNameFor, upsertAttendance, createRateLimiter } = require('../attendance-store');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const REMOTE_CSS = `<style>
.remote{max-width:520px;margin:0 auto}
.remote h1{font-size:22px;margin:4px 0 2px}
.remote label{font-weight:600;margin-top:14px;display:block}
.remote input,.remote select,.remote textarea{font-size:20px;padding:12px;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;background:#fff}
.remote textarea{font-size:16px;min-height:90px}
.remote .pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.remote .triple{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.remote .pair>div,.remote .triple>div{min-width:0}
.remote input[type=date],.remote input[type=time]{min-width:0;max-width:100%;font-size:18px;-webkit-appearance:none;appearance:none;min-height:54px}
.remote .triple label,.remote .pair label{font-size:13px}
.remote .quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.remote .quick button{flex:1 1 70px;font-size:16px;padding:10px 6px}
.remote .go{width:100%;font-size:20px;padding:16px;margin-top:20px}
.remote h2{font-size:15px;margin:22px 0 0;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.remote .ok{background:var(--ok-bg);color:var(--ok);border-radius:12px;padding:18px;margin-top:14px;font-size:17px}
.hp{position:absolute;left:-9999px;height:0;overflow:hidden}
</style>`;

function remoteRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 40 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${REMOTE_CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => res.status(o.status).send(o.html);

  async function findLink(token) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
    const { rows } = await db.query('SELECT id, sede, label, active FROM attendance_links WHERE token = $1', [token]);
    return rows[0] && rows[0].active ? rows[0] : null;
  }

  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a quien administra el panel.</p></div>', 404);

  async function sedeOptions() {
    const rows = (await db.query('SELECT DISTINCT sede FROM service_attendance ORDER BY sede')).rows.map((x) => x.sede);
    return [...new Set(['Agua Viva', 'Las Mercedes', 'Nuarito', ...rows])];
  }

  async function form(link, v = {}, errors = []) {
    const num = (key, label, extra = '') =>
      `<div><label for="${key}">${label}</label><input id="${key}" type="number" min="0" step="1" inputmode="numeric" name="${key}" value="${esc(v[key] ?? '')}" ${extra}></div>`;
    const sedeBlock = link.sede
      ? `<p class="sub" style="margin:0 0 6px">Sede: <strong>${esc(link.sede)}</strong></p>`
      : `<label for="sede">Sede</label><select id="sede" name="sede" required><option value="">Elige…</option>${(await sedeOptions())
          .map((s) => `<option ${v.sede === s ? 'selected' : ''}>${esc(s)}</option>`)
          .join('')}</select>`;
    return `<h1>Asistencia al servicio</h1>
      ${link.label ? `<p class="sub" style="margin:0">${esc(link.label)}</p>` : ''}
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        ${sedeBlock}
        <div class="pair">
          <div><label for="service_date">Fecha</label><input id="service_date" type="date" name="service_date" required value="${esc(v.service_date || today())}"></div>
          <div><label for="horario">Horario</label><input id="horario" type="time" name="horario" required value="${esc(v.horario || '')}"></div>
        </div>
        <div class="quick" aria-label="Horarios frecuentes">${['08:00', '10:00', '12:00', '17:30']
          .map((h) => `<button type="button" class="sec" data-h="${h}">${h}</button>`)
          .join('')}</div>
        <h2>Asistencia</h2>
        <div class="triple">${num('att_start', 'Al inicio')}${num('att_mid', 'En medio')}${num('att_end', 'Al final')}</div>
        <h2>Personas</h2>
        <div class="pair">${num('guests', 'Invitados')}${num('conversions', 'Conversiones')}${num('servers', 'Servidores')}${num('pastors', 'Pastores')}</div>
        <h2>Niños y jóvenes</h2>
        <div class="triple">${num('kids', 'Niños')}${num('preteens', 'Pre-adol.')}${num('teens', 'Adolesc.')}</div>
        <label for="notes">Novedades del servicio</label>
        <textarea id="notes" name="notes" placeholder="Opcional">${esc(v.notes || '')}</textarea>
        <button class="go">Enviar</button>
      </form>
      <script>
        document.querySelectorAll('.quick button').forEach(function(b){
          b.addEventListener('click', function(){ document.getElementById('horario').value = b.getAttribute('data-h'); });
        });
        document.querySelectorAll('input[type=number]').forEach(function(i){ i.addEventListener('focus', function(){ i.select(); }); });
      </script>`;
  }

  r.get(
    '/a/:token',
    ah(async (req, res) => {
      const link = await findLink(req.params.token);
      if (!link) return send(res, invalid());
      send(res, shell('Asistencia', await form(link)));
    })
  );

  r.post(
    '/a/:token',
    ah(async (req, res) => {
      const link = await findLink(req.params.token);
      if (!link) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const body = { ...req.body };
      if (link.sede) body.sede = link.sede;
      const { value, errors } = parseAttendance({ ...body, day_name: '' });
      if (!errors.length) {
        value.day_name = dayNameFor(value.service_date);
        const t = today();
        const diff = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${value.service_date}T00:00:00Z`)) / 86400000;
        if (diff < -1) errors.push('La fecha no puede ser futura.');
        if (diff > 60) errors.push('La fecha es de hace más de 60 días. Para fechas antiguas pídele ayuda a quien administra el panel.');
        if (!value.horario) errors.push('Escribe el horario del servicio.');
        if (value.att_end === null && value.att_start === null && value.att_mid === null) errors.push('Escribe al menos una cifra de asistencia.');
        for (const k of ['att_start', 'att_mid', 'att_end', 'guests', 'conversions', 'servers', 'pastors', 'kids', 'preteens', 'teens']) {
          if (value[k] !== null && value[k] > 5000) errors.push('Revisa las cifras: hay un número demasiado grande.');
        }
      }
      if (errors.length) return send(res, shell('Asistencia', await form(link, req.body, [...new Set(errors)]), 400));
      const out = await upsertAttendance(db, value, 'telefono');
      await db.query('UPDATE attendance_links SET uses = uses + 1, last_used_at = now() WHERE id = $1', [link.id]);
      send(
        res,
        shell(
          'Registrado',
          `<h1>¡Listo!</h1>
          <div class="ok"><strong>${out.created ? 'Servicio registrado' : 'Servicio actualizado'}</strong><br>
            ${esc(value.sede)} · ${esc(value.day_name)} ${esc(value.service_date)} · ${esc(value.horario)}<br>
            Asistencia final: ${value.att_end ?? '—'}${value.conversions ? ` · Conversiones: ${value.conversions}` : ''}</div>
          <p class="muted">Si te equivocaste, vuelve a enviar el mismo horario y se corrige.</p>
          <a class="btn go" style="display:block;text-align:center;box-sizing:border-box" href="/a/${esc(req.params.token)}">Registrar otro servicio</a>`
        )
      );
    })
  );

  return r;
}

module.exports = { remoteRouter };
