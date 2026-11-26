'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const calendar = require('../calendar');
const rc = require('../redil-confirm');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Panel «Confirmación REDIL»: el botón para enviar la plantilla `confirmacion_redil` a los líderes
 * y co-líderes de los grupos de cuidado, con el día y la hora del próximo REDIL. Solo recibe quien
 * está en Personas, activo y con «acepta mensajes»; la página muestra el motivo de los demás.
 */
function redilConfirmarRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const go = (res, flash) => res.redirect(303, `/redil/confirmar?${new URLSearchParams(flash).toString()}`);
  const page = (req, res, body) =>
    res.send(
      layout({
        title: 'Confirmación REDIL',
        active: '/redil/confirmar',
        config,
        query: req.query,
        body: `<p><a href="/redil/libreta">← Libretica REDIL</a></p>${body}`,
      })
    );

  r.get(
    '/redil/confirmar',
    ah(async (req, res) => {
      const list = await rc.recipients(db);
      const ready = list.filter((x) => x.listo);
      const rows = list
        .map(
          (x) => `<tr>
            <td>${x.listo ? `<input type="checkbox" name="quien" value="${x.personId}" checked style="width:auto">` : '<span class="muted">—</span>'}</td>
            <td>${esc(x.name)}</td><td>${esc(x.groupName)}</td>
            <td>${x.listo ? '<span class="badge b-ok">Recibe</span>' : `<span class="badge b-warn">${esc(x.motivo)}</span>`}</td></tr>`
        )
        .join('');
      const warnings = [
        config.whatsappPaused
          ? '<div class="flash err">Los envíos de WhatsApp están <strong>pausados</strong> en Configuración: así no sale nada. Reactívalos ahí para poder enviar.</div>'
          : '',
        !ctx.channels.whatsapp || !ctx.channels.whatsapp.available
          ? '<div class="flash err">WhatsApp no está disponible (falta la conexión con WeCall o Meta).</div>'
          : '',
      ].join('');
      page(
        req,
        res,
        `<h1>Confirmación REDIL</h1>
        <p class="sub">Envía la plantilla <span class="mono">${esc(rc.TEMPLATE_NAME)}</span> a los líderes y co-líderes de los grupos de cuidado, para que confirmen su asistencia al REDIL. La plantilla tiene que estar creada y aprobada en Meta; quien toque «Sí, confirmo» o «No podré asistir» responde como un mensaje normal y queda en Conversaciones.</p>
        ${warnings}
        <form method="post" class="card">
          <div class="row">
            <div><label for="fecha">Día del REDIL</label><input id="fecha" type="date" name="fecha" required min="${esc(today())}"></div>
            <div><label for="hora">Hora</label><input id="hora" type="text" name="hora" required placeholder="Ej.: 7:00 p. m."></div>
          </div>
          <p class="muted" style="font-size:13px">El mensaje dirá: «Hola [nombre], te escribimos de Las Buenas Nuevas de Cabudare. ¿Confirmas tu asistencia al REDIL de este [día] a las [hora]?»</p>
          <div class="table-scroll"><table><tr><th></th><th>Líder</th><th>Grupo</th><th>Estado</th></tr>${rows || '<tr><td colspan="4" class="muted">No hay grupos de cuidado activos.</td></tr>'}</table></div>
          <div class="actions"><button ${ready.length ? '' : 'disabled'}>Enviar la confirmación a los marcados (${ready.length})</button></div>
        </form>`
      );
    })
  );

  r.post(
    '/redil/confirmar',
    ah(async (req, res) => {
      const b = req.body || {};
      const fecha = String(b.fecha || '');
      const hora = String(b.hora || '').trim().slice(0, 40);
      const ids = (Array.isArray(b.quien) ? b.quien : b.quien ? [b.quien] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return go(res, { err: 'Elige el día del REDIL.' });
      if (!hora) return go(res, { err: 'Escribe la hora del REDIL.' });
      if (!ids.length) return go(res, { err: 'Marca al menos un líder para enviarle la confirmación.' });
      const dateText = calendar.dayLabel(fecha).toLowerCase();
      const out = await rc.sendConfirmations(ctx, { dateText, timeText: hora, personIds: ids });
      if (out.failed.length) {
        return go(res, {
          err: `${out.sent ? `Enviadas ${out.sent}. ` : ''}No se pudo enviar a ${out.failed.length}: ${out.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`,
        });
      }
      if (!out.sent) return go(res, { err: 'Ninguno de los marcados podía recibir (revisa su estado en la lista).' });
      go(res, { ok: `Confirmación enviada a ${out.sent} ${out.sent === 1 ? 'líder' : 'líderes'} para el REDIL del ${dateText} a las ${hora}.` });
    })
  );

  return r;
}

module.exports = { redilConfirmarRouter };
