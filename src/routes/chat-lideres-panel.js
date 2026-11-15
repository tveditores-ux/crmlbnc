'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const chat = require('../chat-lideres');
const webpush = require('../web-push');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const firstName = (name) => String(name || '').split(' ')[0];

/**
 * Panel del chat de líderes:
 * - /personas/:id/chat: el acceso personal de una persona (su enlace, compartirlo, apagarlo, regenerarlo).
 * - /chat-lideres: la sala vista por administración (miembros, últimos mensajes con borrado, límite de Grace).
 */
function chatLideresPanelRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  // Sin guardia propia: como los demás routers del panel, lo protege la sesión global de app.js.
  const page = (req, res, title, active, body) => res.send(layout({ title, active, body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);

  const personById = async (id) => (await db.query('SELECT id, full_name, phone, opt_in, role, active FROM people WHERE id = $1', [id])).rows[0] || null;

  r.get(
    '/personas/:id(\\d+)/chat',
    ah(async (req, res) => {
      const person = await personById(+req.params.id);
      if (!person) return go(res, '/personas', { err: 'No existe esa persona.' });
      const link = await chat.ensureLink(db, person.id);
      const url = `${config.publicUrl}/chat/${link.token}`;
      const saludo = `Hola ${firstName(person.full_name)}, entra al chat de líderes de ${config.churchName} con tu enlace personal: ${url} — ahí conversamos entre líderes y servidores, y Grace también está en la sala, como una más: menciónala en un mensaje y te responde. Guárdalo y agrega el ícono a tu pantalla de inicio para recibir los avisos de la app.`;
      const tienePush = await chat.hasSubscription(db, person.id);
      page(
        req,
        res,
        `Chat de líderes · ${person.full_name}`,
        '/personas',
        `<p><a href="/personas/${person.id}">← Volver a su ficha</a> · <a href="/chat-lideres">Ver la sala completa</a></p>
        <h1>Su acceso al chat de líderes</h1>
        <div class="card">
          <p style="margin-top:0"><strong>${esc(person.full_name)}</strong> entra a la sala con <strong>su propio enlace</strong> (no es el de nadie más): con él la app sabe quién escribe y le avisa cuando hay mensajes nuevos.</p>
          <label>Su enlace personal
            <input type="text" readonly value="${esc(url)}" onclick="this.select()" style="width:100%">
          </label>
          <p style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0">
            <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(saludo)}">Enviar por WhatsApp</a>
            <button type="button" class="btn sec" onclick="navigator.clipboard.writeText(${JSON.stringify(url)});this.textContent='¡Copiado!'">Copiar enlace</button>
            <a class="btn sec" href="/chat/${link.token}" target="_blank" rel="noopener">Abrir su chat</a>
          </p>
          <p class="muted" style="margin-bottom:0">Estado: <strong>${link.active ? 'activo' : 'apagado'}</strong> · Notificaciones de la app en su aparato: <strong>${tienePush ? 'activadas' : 'todavía no'}</strong> (las activa la persona con la campana 🔔 dentro del chat).</p>
        </div>
        <div class="card">
          <form method="post" action="/personas/${person.id}/chat/enlace/${link.active ? 'desactivar' : 'activar'}" style="display:inline">
            <button class="btn sec">${link.active ? 'Apagar su acceso' : 'Encender su acceso'}</button>
          </form>
          <form method="post" action="/personas/${person.id}/chat/enlace/nuevo" style="display:inline" onsubmit="return confirm('Se crea un enlace nuevo y el anterior deja de funcionar. ¿Continuar?')">
            <button class="btn sec">Regenerar enlace</button>
          </form>
          <p class="muted" style="margin-bottom:0">Si apagas su acceso, su enlace deja de abrir la sala. Regenerarlo sirve si el enlace se compartió con quien no debía.</p>
        </div>`
      );
    })
  );

  r.post(
    '/personas/:id(\\d+)/chat/enlace/:accion',
    ah(async (req, res) => {
      const id = +req.params.id;
      const person = await personById(id);
      if (!person) return go(res, '/personas', { err: 'No existe esa persona.' });
      if (req.params.accion === 'nuevo') await chat.regenerate(db, id);
      else if (req.params.accion === 'activar') await chat.setActive(db, id, true);
      else if (req.params.accion === 'desactivar') await chat.setActive(db, id, false);
      go(res, `/personas/${id}/chat`, { ok: 'Acceso al chat actualizado.' });
    })
  );

  r.get(
    '/chat-lideres',
    ah(async (req, res) => {
      const miembros = await chat.members(db);
      const mensajes = await chat.recentMessages(db, 50);
      const limite = await chat.getGraceLimit(db);
      const invite = await chat.getInvite(db);
      const inviteUrl = invite.token ? `${config.publicUrl}/chat-invitacion/${invite.token}` : '';
      const inviteSaludo = `Hola, la paz del Señor. Te invito al chat de líderes de ${config.churchName}: abre este enlace y entra con tu número de WhatsApp: ${inviteUrl} Ahí conversamos entre líderes y servidores, y Grace también está en la sala. Agrega el ícono a tu pantalla de inicio para recibir los avisos de la app.`;
      const vapid = await webpush.ensureVapid(db).catch(() => null);
      const subs = (await db.query('SELECT DISTINCT person_id FROM push_subscriptions')).rows.map((x) => x.person_id);
      const filasMiembros = miembros.length
        ? miembros
            .map(
              (m) => `<tr><td><a href="/personas/${m.id}/chat">${esc(m.full_name)}</a></td><td>${esc(m.role || '—')}</td><td>${subs.includes(m.id) ? '🔔 activadas' : 'sin activar'}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="3" class="muted">Todavía nadie tiene acceso. Genera el enlace desde la ficha de cada líder o servidor (botón «Su acceso al chat de líderes»).</td></tr>';
      const filasMensajes = mensajes.length
        ? mensajes
            .slice()
            .reverse()
            .map(
              (m) => `<tr>
                <td style="white-space:nowrap">${new Date(m.created_at).toLocaleString('es-VE', { timeZone: config.timezone, day: '2-digit', month: '2-digit', hour: 'numeric', minute: '2-digit' })}</td>
                <td>${m.kind === 'grace' ? '✦ Grace' : esc(m.author_name)}</td>
                <td>${esc(m.body)}</td>
                <td><form method="post" action="/chat-lideres/mensaje/${m.id}/borrar" onsubmit="return confirm('¿Borrar este mensaje de la sala?')"><button class="btn sec small">Borrar</button></form></td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="muted">La sala todavía no tiene mensajes.</td></tr>';
      page(
        req,
        res,
        'Chat de líderes',
        '/personas',
        `<h1>Chat de líderes</h1>
        <p class="muted">La sala donde los líderes y servidores conversan entre ellos. Grace es una más en la sala: responde cuando la mencionan en un mensaje. Cada quien entra con su enlace personal, desde su ficha. Los avisos salen como notificaciones de la propia app (no por WhatsApp).</p>
        <div class="card">
          <h2 style="margin-top:0">Ajustes</h2>
          <form method="post" action="/chat-lideres/limite" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
            <label>Preguntas a Grace por persona y día
              <input type="number" name="limite" min="0" max="50" value="${limite}" style="width:90px">
            </label>
            <button class="btn">Guardar</button>
          </form>
          <p class="muted" style="margin-bottom:0">Notificaciones de la app: ${vapid ? 'listas (clave pública generada)' : 'sin generar todavía'} · Con 0, Grace no responde en la sala.</p>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Enlace de invitación (para compartir con los miembros)</h2>
          ${
            invite.token
              ? `<p style="margin-top:0">Este es <strong>el enlace que se comparte</strong> con los líderes y servidores — por el grupo de WhatsApp, por ejemplo. Quien lo abre escribe su número de WhatsApp y entra directo a <strong>su</strong> chat (cada quien como sí mismo). También está en la pestaña «Registros» y dentro del chat, en el botón ↗.</p>
          <label>Enlace de invitación
            <input type="text" readonly value="${esc(inviteUrl)}" onclick="this.select()" style="width:100%">
          </label>
          <p style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(inviteSaludo)}">Enviar por WhatsApp</a>
            <button type="button" class="btn sec" onclick="navigator.clipboard.writeText(${JSON.stringify(inviteUrl)});this.textContent='¡Copiado!'">Copiar enlace</button>
          </p>
          <p class="muted">Estado: <strong>${invite.active ? 'encendido' : 'apagado'}</strong></p>
          <form method="post" action="/chat-lideres/invitacion/${invite.active ? 'apagar' : 'encender'}" style="display:inline">
            <button class="btn sec">${invite.active ? 'Apagar la invitación' : 'Encender la invitación'}</button>
          </form>
          <form method="post" action="/chat-lideres/invitacion/nuevo" style="display:inline" onsubmit="return confirm('Se crea un enlace de invitación nuevo y el anterior deja de funcionar. ¿Continuar?')">
            <button class="btn sec">Generar enlace nuevo</button>
          </form>`
              : `<p style="margin-top:0">Todavía no hay enlace de invitación. Genéralo y compártelo con los líderes y servidores: quien lo abra escribe su número de WhatsApp y entra directo a su chat, sin repartir enlace por enlace.</p>
          <form method="post" action="/chat-lideres/invitacion/generar"><button class="btn">Generar enlace de invitación</button></form>`
          }
        </div>
        <div class="card">
          <h2 style="margin-top:0">Miembros (${miembros.length})</h2>
          <table><thead><tr><th>Persona</th><th>Rol</th><th>Notificaciones</th></tr></thead><tbody>${filasMiembros}</tbody></table>
        </div>
        <div class="card">
          <h2 style="margin-top:0">Últimos mensajes</h2>
          <table><thead><tr><th>Cuándo</th><th>Quién</th><th>Mensaje</th><th></th></tr></thead><tbody>${filasMensajes}</tbody></table>
        </div>`
      );
    })
  );

  r.post(
    '/chat-lideres/invitacion/:accion(generar|nuevo|encender|apagar)',
    ah(async (req, res) => {
      if (req.params.accion === 'generar') await chat.ensureInvite(db);
      else if (req.params.accion === 'nuevo') await chat.regenerateInvite(db);
      else await chat.setInviteActive(db, req.params.accion === 'encender');
      go(res, '/chat-lideres', { ok: 'Enlace de invitación actualizado.' });
    })
  );

  r.post(
    '/chat-lideres/limite',
    ah(async (req, res) => {
      await chat.setGraceLimit(db, req.body && req.body.limite);
      go(res, '/chat-lideres', { ok: 'Límite de preguntas a Grace guardado.' });
    })
  );

  r.post(
    '/chat-lideres/mensaje/:id(\\d+)/borrar',
    ah(async (req, res) => {
      await chat.deleteMessage(db, +req.params.id);
      go(res, '/chat-lideres', { ok: 'Mensaje borrado de la sala.' });
    })
  );

  return r;
}

module.exports = { chatLideresPanelRouter };
