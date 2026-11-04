'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const intake = require('../member-intake');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const short = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');

/** Tarjeta de solo lectura con lo que la persona envió, para su ficha. Datos sensibles: solo en el panel, con sesión. */
function memberDataCard(p, hasPhoto, timeZone) {
  const rows = [
    ['Nacimiento', p.birth_date ? short(p.birth_date) : ''], ['Cédula (C.I.)', p.cedula], ['Dirección', p.address],
    ['Estado civil', p.civil_status], ['Congregación', p.congregation], ['Grupo de cuidado', p.care_group_name],
  ].filter(([, v]) => v);
  if (!rows.length && !hasPhoto && !p.profile_updated_at) return '';
  return `<div class="card" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
    ${hasPhoto ? `<img src="/personas/${p.id}/foto" alt="Foto" width="96" height="96" style="border-radius:16px;object-fit:cover">` : ''}
    <div style="flex:1 1 240px"><h3 style="margin:0 0 4px">Datos que envió la persona</h3>
      ${p.profile_updated_at ? `<p class="muted" style="margin:0 0 6px;font-size:13px">Enviados el ${esc(short(new Date(p.profile_updated_at).toLocaleDateString('en-CA', { timeZone })))}</p>` : ''}
      ${rows.map(([l, v]) => `<div><span class="muted">${esc(l)}:</span> ${esc(v)}</div>`).join('') || '<span class="muted">Sin datos todavía.</span>'}</div></div>`;
}

/** Pedir los datos a las personas (enlace "Mis datos") y revisar lo que llega. */
function memberRequestsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use(['/personas/solicitud', '/personas/respuestas'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/personas', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const jpeg = (res, buf) => {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(buf));
  };

  const DEFAULT_ASK = `Hola, la paz del Señor. Estamos actualizando los datos de la familia de ${config.churchName || 'la iglesia'}. ¿Me ayudas llenando esta planilla desde tu teléfono? Son dos minutos: {enlace}`;

  r.get(
    '/personas/solicitud',
    ah(async (req, res) => {
      const settings = await intake.ensureToken(db);
      const url = `${config.publicUrl}/mis-datos/${settings.token}`;
      const waiting = await intake.countPending(db);
      const st = (await db.query('SELECT count(*)::int AS total, count(profile_updated_at)::int AS sent FROM people WHERE active')).rows[0];
      page(
        req,
        res,
        'Pedir datos a las personas',
        `<p><a href="/personas">← Personas</a></p><h1>Pedir los datos a las personas</h1>
        <p class="sub">Un solo enlace para todos: cada persona lo abre, llena su planilla (con nacimiento, cédula, dirección y foto) y la envía. Si su teléfono ya está en Personas y no trae nada distinto, su ficha se completa sola; si es alguien nuevo o trae un dato distinto, queda en <a href="/personas/respuestas">Respuestas</a> para que tú lo apruebes.</p>
        ${waiting ? `<div class="flash ok"><a href="/personas/respuestas">${waiting} respuesta${waiting === 1 ? '' : 's'} por revisar →</a></div>` : ''}
        <div class="grid">
          <div class="card"><div class="stat">${st.sent}</div><div class="stat-label">personas activas ya enviaron sus datos</div></div>
          <div class="card"><div class="stat">${st.total - st.sent}</div><div class="stat-label">activas que aún no</div></div>
        </div>
        <div class="card"><h3>Enlace para todos</h3>
          <input type="text" id="link" readonly value="${esc(url)}" onclick="this.select()" style="font-size:13px" ${settings.active ? '' : 'disabled'}>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec" id="copyLink">Copiar enlace</button>
            <form class="inline" method="post" action="/personas/solicitud/enlace/${settings.active ? 'desactivar' : 'activar'}"><button class="small ${settings.active ? 'danger' : 'sec'}">${settings.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/personas/solicitud/enlace/nuevo"><button class="small sec">Generar enlace nuevo</button></form></p>
          <p class="muted" style="font-size:13px;margin:0">Quien tenga el enlace puede enviar datos: compártelo con tu gente (por ejemplo, en el grupo oficial de WhatsApp). Si se riega a quien no debe, genera uno nuevo y el anterior deja de funcionar.</p></div>
        <div class="card"><label>Mensaje (puedes cambiarlo; {enlace} se rellena solo)</label>
          <textarea id="tpl" style="min-height:100px">${esc(DEFAULT_ASK)}</textarea>
          <p class="toolbar" style="margin:8px 0 0"><a class="btn small" id="share" target="_blank" rel="noopener" href="#">Elegir chat en WhatsApp</a>
            <button type="button" class="small sec" id="copyMsg">Copiar mensaje</button></p>
          <p class="muted" style="font-size:13px;margin:6px 0 0">Lo envías tú, desde tu WhatsApp: el sistema no manda nada por su cuenta.</p></div>
        <script>
          var url = document.getElementById('link').value, tpl = document.getElementById('tpl');
          function msg(){ var t = tpl.value; if (t.indexOf('{enlace}') < 0) t += '\\n{enlace}'; return t.split('{enlace}').join(url); }
          function refresh(){ document.getElementById('share').href = 'https://wa.me/?text=' + encodeURIComponent(msg()); }
          tpl.addEventListener('input', refresh); refresh();
          function copy(btn, text, field){ (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){ var o = btn.textContent; btn.textContent = '¡Copiado!'; setTimeout(function(){ btn.textContent = o; }, 1500); }, function(){ field.select(); btn.textContent = 'Selecciona y copia'; }); }
          document.getElementById('copyLink').addEventListener('click', function(){ copy(this, url, document.getElementById('link')); });
          document.getElementById('copyMsg').addEventListener('click', function(){ copy(this, msg(), tpl); });
        </script>`
      );
    })
  );

  r.post(
    '/personas/solicitud/enlace/:accion(activar|desactivar|nuevo)',
    ah(async (req, res) => {
      if (req.params.accion === 'nuevo') {
        await intake.regenerateToken(db);
        return go(res, '/personas/solicitud', { ok: 'Enlace nuevo generado. El anterior ya no funciona; vuelve a compartirlo.' });
      }
      await intake.setActive(db, req.params.accion === 'activar');
      go(res, '/personas/solicitud', { ok: req.params.accion === 'activar' ? 'Enlace encendido.' : 'Enlace apagado.' });
    })
  );

  /* -------------------------- Respuestas por revisar -------------------------- */
  const showVal = (f, v) => (f === 'birth_date' && v ? short(v) : v);
  r.get(
    '/personas/respuestas',
    ah(async (req, res) => {
      const pending = await intake.listPending(db);
      const cards = pending
        .map((s) => {
          const changes = intake.FIELDS.filter((f) => s[f] !== '' && s[f] !== (s['cur_' + f] ?? ''))
            .map((f) => `<tr><td class="muted">${esc(intake.LABELS[f])}</td><td>${s['cur_' + f] ? esc(showVal(f, s['cur_' + f])) : '<span class="muted">—</span>'}</td><td><strong>${esc(showVal(f, s[f]))}</strong></td></tr>`)
            .join('');
          return `<div class="card">
            <h3 style="margin-top:0">${esc(s.full_name)} ${s.person_id ? '<span class="badge b-warn">Ya está en Personas, con datos distintos</span>' : '<span class="badge b-warn">Persona nueva</span>'}</h3>
            <p class="muted" style="font-size:13px">${esc(displayPhone(s.phone))} · recibida ${esc(short(new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: config.timezone })))}</p>
            ${s.has_photo ? `<img src="/personas/respuestas/${s.id}/foto" alt="Foto enviada" width="96" height="96" style="border-radius:16px;object-fit:cover;float:right;margin:0 0 8px 12px">` : ''}
            <div class="table-scroll"><table><tr><th></th><th>Ahora</th><th>Envió</th></tr>${changes || '<tr><td colspan="3" class="muted">No trae cambios.</td></tr>'}</table></div>
            <form method="post" action="/personas/respuestas/${s.id}/aplicar" class="toolbar" style="margin:10px 0 0;align-items:center">
              ${s.wants_messages ? '<label class="check" style="margin:0"><input type="checkbox" name="consent" value="1"> También registrar que aceptó recibir recordatorios (lo pidió en la planilla)</label>' : '<span class="muted" style="font-size:13px">No pidió recibir recordatorios.</span>'}
              <button class="small">${s.person_id ? 'Aprobar y guardar' : 'Aprobar y crear la persona'}</button>
              <button class="small danger" formaction="/personas/respuestas/${s.id}/descartar">Descartar</button></form></div>`;
        })
        .join('');
      page(
        req,
        res,
        'Respuestas de las personas',
        `<p><a href="/personas/solicitud">← Pedir datos a las personas</a></p><h1>Respuestas por revisar</h1>
        <p class="sub">Lo que coincide con una ficha y no trae nada distinto se guarda solo y no pasa por aquí. Aprobar una persona nueva la crea <strong>sin consentimiento</strong> y <strong>sin clasificar</strong> (tú decides si es miembro o amigo en Personas).</p>
        ${cards || '<p class="muted">No hay respuestas pendientes.</p>'}`
      );
    })
  );
  r.get(
    '/personas/respuestas/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const p = (await db.query("SELECT photo FROM member_submissions WHERE id = $1 AND status = 'pendiente'", [+req.params.id])).rows[0];
      if (!p || !p.photo) return res.status(404).end();
      jpeg(res, p.photo);
    })
  );
  r.post(
    '/personas/respuestas/:id(\\d{1,9})/:accion(aplicar|descartar)',
    ah(async (req, res) => {
      const id = +req.params.id;
      if (req.params.accion === 'descartar') {
        const ok = await intake.discard(db, id);
        return go(res, '/personas/respuestas', ok ? { ok: 'Respuesta descartada.' } : { err: 'Esa respuesta ya fue atendida.' });
      }
      const out = await intake.apply(db, id, { consent: req.body.consent === '1' });
      if (out.error) return go(res, '/personas/respuestas', { err: out.error });
      go(res, `/personas/${out.personId}`, { ok: out.created ? 'Persona creada con sus datos.' : 'Datos guardados en la ficha.' });
    })
  );

  // foto de la persona: solo con sesión del panel (este router va después del guardia de sesión)
  r.get(
    '/personas/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const p = (await db.query('SELECT data FROM people_photos WHERE person_id = $1', [+req.params.id])).rows[0];
      if (!p) return res.status(404).end();
      jpeg(res, p.data);
    })
  );

  return r;
}

module.exports = { memberRequestsRouter, memberDataCard };
