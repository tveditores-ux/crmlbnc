'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const desarrollo = require('../ministry-leader-intake');
const pastores = require('../pastor-intake');
const personas = require('../member-intake');
const lideres = require('../care-intake');
const reporte = require('../care-report-link');
const chat = require('../chat-lideres');
const creyentes = require('../new-believer-intake');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Registros: TODOS los enlaces de registro de la iglesia en un solo lugar, para tenerlos bien
 * ubicados y enviarlos fácil: copiar el enlace, mandarlo por WhatsApp con su mensaje listo,
 * apagarlo/encenderlo o generar uno nuevo (el anterior deja de funcionar). Cada enlace sigue
 * viviendo también en su página de siempre, donde se revisan las respuestas; aquí solo se
 * reúnen los enlaces, usando las mismas funciones de cada módulo (mismo token en care_settings).
 */
function registrosRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/registros', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // los enlaces son secretos
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/registros', body, config, query: req.query }));
  const go = (res, flash) => res.redirect(303, flash ? `/registros?${new URLSearchParams(flash).toString()}` : '/registros');
  const church = config.churchName || 'la iglesia';

  const REGISTROS = [
    {
      key: 'desarrollo',
      title: 'Líderes de ministerios de desarrollo',
      para: 'Para los líderes de los ministerios de desarrollo (Alabanza, Anfitriones, Diaconado, Intercesión, Medios y Nueva Vida). Compártelo solo con esos líderes.',
      path: '/desarrollo/',
      panel: '/personas/ministerios-desarrollo',
      review: '/personas/ministerios-desarrollo/respuestas',
      ensure: (d) => desarrollo.ensureToken(d),
      regen: (d) => desarrollo.regenerateToken(d),
      setActive: (d, on) => desarrollo.setActive(d, on),
      pending: (d) => desarrollo.countPending(d),
      ask: `Hola, la paz del Señor. Estamos registrando la ficha de los líderes de los ministerios de desarrollo de ${church} (Alabanza, Anfitriones, Diaconado, Nueva Vida, Medios e Intercesión). ¿Me ayudas llenando esta planilla desde tu teléfono? Son dos minutos: {enlace}`,
    },
    {
      key: 'pastores',
      title: 'Registro ministerial (pastores y servidores)',
      para: 'Para pastores, diáconos y servidores: cada uno se registra con su función. Compártelo solo con el equipo pastoral y los servidores.',
      path: '/pastores/',
      panel: '/personas/pastores',
      review: '/personas/pastores/respuestas',
      ensure: (d) => pastores.ensureToken(d),
      regen: (d) => pastores.regenerateToken(d),
      setActive: (d, on) => pastores.setActive(d, on),
      pending: (d) => pastores.countPending(d),
      ask: `Hola, la paz del Señor. Estamos registrando la ficha de los pastores, diáconos y servidores de los ministerios de ${church}. ¿Me ayudas llenando esta planilla desde tu teléfono? Son dos minutos: {enlace}`,
    },
    {
      key: 'personas',
      title: 'Datos de las personas («Mis datos»)',
      para: 'Para toda la familia de la iglesia: cada persona llena o actualiza su ficha con este enlace.',
      path: '/mis-datos/',
      panel: '/personas/solicitud',
      review: '/personas/respuestas',
      ensure: (d) => personas.ensureToken(d),
      regen: (d) => personas.regenerateToken(d),
      setActive: (d, on) => personas.setActive(d, on),
      pending: (d) => personas.countPending(d),
      ask: `Hola, la paz del Señor. Estamos actualizando los datos de la familia de ${church}. ¿Me ayudas llenando esta planilla desde tu teléfono? Son dos minutos: {enlace}`,
    },
    {
      key: 'lideres',
      title: 'Datos de los líderes de grupos de cuidado',
      para: 'Para los líderes de los grupos de cuidado: actualizan los datos de su grupo. Desde su página puedes enviar el mensaje a cada líder con su nombre.',
      path: '/registro/',
      panel: '/grupos/solicitud',
      review: '/grupos/respuestas',
      ensure: (d) => lideres.ensureToken(d),
      regen: (d) => lideres.regenerateToken(d),
      setActive: (d, on) => lideres.setActive(d, on),
      pending: (d) => lideres.countPending(d),
      ask: 'Hola, esperamos que estés disfrutando tu vida en Cristo. Estamos actualizando los datos de los grupos de cuidado de la iglesia. ¿Me ayudas llenando esta planilla desde tu teléfono? Elige tu congregación, llena tus datos y envíala, son dos minutos: {enlace}',
    },
    {
      key: 'reporte',
      title: 'Reporte semanal de grupos de cuidado',
      para: 'Para que cada líder envíe el reporte semanal de su grupo, solo con su nombre. Se envía una vez y el líder lo guarda en su teléfono: sirve cada semana.',
      path: '/reportes/',
      panel: '/grupos/reporte-comun',
      review: '/grupos/reporte-comun',
      ensure: (d) => reporte.ensureLink(d),
      regen: (d) => reporte.regenerateLink(d),
      setActive: (d, on) => reporte.setLinkActive(d, on),
      pending: (d) => reporte.countPending(d),
      ask: 'Hola, la paz del Señor. Este es el enlace para enviar el reporte semanal de tu grupo de cuidado: {enlace} Solo escribe tu nombre y apellido, como líder, y llena el reporte. Guárdalo en tu teléfono: sirve cada semana.',
    },
    {
      key: 'chat',
      title: 'Invitación al chat de líderes',
      para: 'El enlace para invitar a los líderes y servidores al chat: quien lo abre escribe su número de WhatsApp y entra directo a su chat (solo funciona para quienes ya tienen acceso dado desde su ficha). Compártelo solo con líderes y servidores.',
      path: '/chat-invitacion/',
      panel: '/chat-lideres',
      review: '/chat-lideres',
      ensure: (d) => chat.ensureInvite(d),
      regen: (d) => chat.regenerateInvite(d),
      setActive: (d, on) => chat.setInviteActive(d, on),
      pending: async () => 0,
      ask: `Hola, la paz del Señor. Te invito al chat de líderes de ${church}: abre este enlace y entra con tu número de WhatsApp: {enlace} Ahí conversamos entre líderes y servidores, y Grace también está en la sala. Agrega el ícono a tu pantalla de inicio para recibir los avisos de la app.`,
    },
    {
      key: 'creyentes',
      title: 'Registro de nuevos creyentes',
      para: 'Para registrar a un nuevo creyente el mismo día de su conversión, en el momento de la decisión. Entra a la lista de Nueva Vida marcado por revisar. Compártelo solo con el equipo que registra conversiones.',
      path: '/nuevos-creyentes/',
      panel: '/nueva-vida/enlace',
      review: '/nueva-vida',
      ensure: (d) => creyentes.ensureLink(d),
      regen: (d) => creyentes.regenerateLink(d),
      setActive: (d, on) => creyentes.setLinkActive(d, on),
      pending: (d) => creyentes.countPending(d),
      ask: `Hola, la paz del Señor. Este es el enlace para registrar a los nuevos creyentes de ${church} el mismo día de su conversión: {enlace} Se llena en el momento de la decisión y queda en Nueva Vida para su seguimiento. Guárdalo en tu teléfono.`,
    },
  ];

  r.get(
    '/registros',
    ah(async (req, res) => {
      const cards = [];
      for (const reg of REGISTROS) {
        const s = await reg.ensure(db);
        const waiting = await reg.pending(db);
        const url = `${config.publicUrl}${reg.path}${s.token}`;
        cards.push(`<div class="card" data-reg>
          <h3 style="margin-top:0">${esc(reg.title)} ${s.active ? '<span class="badge b-ok">Encendido</span>' : '<span class="badge b-warn">Apagado</span>'}</h3>
          <p class="sub">${esc(reg.para)}</p>
          ${waiting ? `<div class="flash ok"><a href="${esc(reg.review)}">${waiting} respuesta${waiting === 1 ? '' : 's'} por revisar →</a></div>` : ''}
          <input type="text" class="reg-link" readonly value="${esc(url)}" onclick="this.select()" style="font-size:13px" ${s.active ? '' : 'disabled'}>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec reg-copy-link">Copiar enlace</button>
            <form class="inline" method="post" action="/registros/${reg.key}/${s.active ? 'apagar' : 'encender'}"><button class="small ${s.active ? 'danger' : 'sec'}">${s.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/registros/${reg.key}/nuevo" onsubmit="return confirm('El enlace anterior dejará de funcionar y habrá que compartir el nuevo. ¿Generar uno nuevo?')"><button class="small sec">Generar enlace nuevo</button></form>
            <a class="btn small sec" href="${esc(reg.panel)}">Ir a su página</a></p>
          <label>Mensaje para enviarlo (puedes cambiarlo; {enlace} se rellena solo)</label>
          <textarea class="reg-tpl" style="min-height:90px">${esc(reg.ask)}</textarea>
          <p class="toolbar" style="margin:8px 0 0"><a class="btn small reg-share" target="_blank" rel="noopener" href="#">Elegir chat en WhatsApp</a>
            <button type="button" class="small sec reg-copy-msg">Copiar mensaje</button></p>
          <p class="muted" style="font-size:13px;margin:6px 0 0">Lo envías tú, desde tu WhatsApp: el sistema no manda nada por su cuenta.</p>
        </div>`);
      }
      page(
        req,
        res,
        'Registros',
        `<h1>Registros</h1>
        <p class="sub">Todos los enlaces de registro de la iglesia, en un solo lugar: copiarlos, enviarlos por WhatsApp, apagarlos o generar uno nuevo. Quien tenga un enlace puede enviar un registro: compártelo solo con las personas de cada registro. Las respuestas se revisan en la página de cada uno («Ir a su página»).</p>
        ${cards.join('')}
        <script>
          function copy(btn, text, field){ (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){ var o = btn.textContent; btn.textContent = '¡Copiado!'; setTimeout(function(){ btn.textContent = o; }, 1500); }, function(){ if (field) field.select(); btn.textContent = 'Selecciona y copia'; }); }
          document.querySelectorAll('[data-reg]').forEach(function(card){
            var link = card.querySelector('.reg-link'), tpl = card.querySelector('.reg-tpl'), share = card.querySelector('.reg-share');
            function msg(){ var t = tpl.value; if (t.indexOf('{enlace}') < 0) t += '\\n{enlace}'; return t.split('{enlace}').join(link.value); }
            function refresh(){ share.href = 'https://wa.me/?text=' + encodeURIComponent(msg()); }
            tpl.addEventListener('input', refresh); refresh();
            card.querySelector('.reg-copy-link').addEventListener('click', function(){ copy(this, link.value, link); });
            card.querySelector('.reg-copy-msg').addEventListener('click', function(){ copy(this, msg(), tpl); });
          });
        </script>`
      );
    })
  );

  r.post(
    '/registros/:key/:accion(encender|apagar|nuevo)',
    ah(async (req, res) => {
      const reg = REGISTROS.find((x) => x.key === req.params.key);
      if (!reg) return go(res, { err: 'Ese registro no existe.' });
      if (req.params.accion === 'nuevo') {
        await reg.regen(db);
        return go(res, { ok: `Enlace nuevo de «${reg.title}» generado. El anterior ya no funciona; vuelve a compartirlo.` });
      }
      await reg.setActive(db, req.params.accion === 'encender');
      go(res, { ok: req.params.accion === 'encender' ? `Enlace de «${reg.title}» encendido.` : `Enlace de «${reg.title}» apagado.` });
    })
  );

  return r;
}

module.exports = { registrosRouter };
