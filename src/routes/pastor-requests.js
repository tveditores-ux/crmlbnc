'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const intake = require('../pastor-intake');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const short = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');

/** Registro ministerial: compartir el enlace con pastores, diáconos y servidores, y revisar lo que llega. */
function pastorRequestsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use(['/personas/pastores', '/personas/pastores/respuestas'], (req, res, next) => {
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

  const DEFAULT_ASK = `Hola, la paz del Señor. Estamos registrando la ficha de los pastores, diáconos y servidores de los ministerios de ${config.churchName || 'la iglesia'}. ¿Me ayudas llenando esta planilla desde tu teléfono? Son dos minutos: {enlace}`;

  r.get(
    '/personas/pastores',
    ah(async (req, res) => {
      const settings = await intake.ensureToken(db);
      const url = `${config.publicUrl}/ministerio/${settings.token}`;
      const waiting = await intake.countPending(db);
      // cuántas fichas activas hay por función de la lista (las demás, escritas a mano, van juntas)
      const byRole = (await db.query("SELECT role, count(*)::int AS n FROM people WHERE active AND role <> '' GROUP BY role")).rows;
      const cardsByRole = intake.FUNCIONES.map((f) => [f, (byRole.find((x) => x.role === f) || {}).n || 0])
        .filter(([, n]) => n)
        .map(([f, n]) => `<div class="card"><div class="stat">${n}</div><div class="stat-label">${esc(f)}</div></div>`)
        .join('');
      page(
        req,
        res,
        'Registro ministerial',
        `<p><a href="/personas">← Personas</a></p><h1>Registro ministerial</h1>
        <p class="sub">Un solo enlace para pastores, diáconos y servidores de los ministerios: cada uno lo abre, elige su función o ministerio (Pastor, Pastor asistente, Diácono, Nueva Vida, Consolidación, Alabanza…, u otro escrito a mano), llena su ficha —la misma de los líderes de grupo de cuidado, con el estado civil— y la envía. Si su teléfono ya está en Personas y no trae nada distinto, su ficha se completa sola y la función queda como su rol; si es alguien nuevo o trae un dato distinto, queda en <a href="/personas/pastores/respuestas">Respuestas del registro ministerial</a> para que tú lo apruebes.</p>
        ${waiting ? `<div class="flash ok"><a href="/personas/pastores/respuestas">${waiting} registro${waiting === 1 ? '' : 's'} por revisar →</a></div>` : ''}
        ${cardsByRole ? `<h3>Fichas activas por función</h3><div class="grid">${cardsByRole}</div>` : ''}
        <p class="muted" style="font-size:13px">Si la función tiene el mismo nombre que un ministerio de la pestaña <a href="/ministerios">Ministerios</a>, al guardarse la persona queda también en ese ministerio.</p>
        <div class="card"><h3>Enlace del registro ministerial</h3>
          <input type="text" id="link" readonly value="${esc(url)}" onclick="this.select()" style="font-size:13px" ${settings.active ? '' : 'disabled'}>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec" id="copyLink">Copiar enlace</button>
            <form class="inline" method="post" action="/personas/pastores/enlace/${settings.active ? 'desactivar' : 'activar'}"><button class="small ${settings.active ? 'danger' : 'sec'}">${settings.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/personas/pastores/enlace/nuevo"><button class="small sec">Generar enlace nuevo</button></form></p>
          <p class="muted" style="font-size:13px;margin:0">Quien tenga el enlace puede enviar un registro diciendo que es pastor o que sirve en un ministerio: compártelo solo con el liderazgo. Las fichas nuevas siempre pasan por tu revisión antes de entrar a Personas.</p></div>
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
    '/personas/pastores/enlace/:accion(activar|desactivar|nuevo)',
    ah(async (req, res) => {
      if (req.params.accion === 'nuevo') {
        await intake.regenerateToken(db);
        return go(res, '/personas/pastores', { ok: 'Enlace nuevo generado. El anterior ya no funciona; vuelve a compartirlo.' });
      }
      await intake.setActive(db, req.params.accion === 'activar');
      go(res, '/personas/pastores', { ok: req.params.accion === 'activar' ? 'Enlace encendido.' : 'Enlace apagado.' });
    })
  );

  /* -------------------------- Registros por revisar -------------------------- */
  const showVal = (f, v) => (f === 'birth_date' && v ? short(v) : v);
  r.get(
    '/personas/pastores/respuestas',
    ah(async (req, res) => {
      const pending = await intake.listPending(db);
      const cards = pending
        .map((s) => {
          const rows = [
            ...(['funcion', ...intake.FIELDS].map((f) => {
              const cur = f === 'funcion' ? s.cur_funcion : s['cur_' + f];
              const val = f === 'funcion' ? s.funcion : s[f];
              if (!val || val === (cur ?? '')) return '';
              return `<tr><td class="muted">${esc(intake.LABELS[f])}</td><td>${cur ? esc(showVal(f, cur)) : '<span class="muted">—</span>'}</td><td><strong>${esc(showVal(f, val))}</strong></td></tr>`;
            })),
          ].join('');
          return `<div class="card">
            <h3 style="margin-top:0">${esc(s.full_name)} <span class="badge">${esc(s.funcion)}</span> ${s.person_id ? '<span class="badge b-warn">Ya está en Personas, con datos distintos</span>' : '<span class="badge b-warn">Persona nueva</span>'}</h3>
            <p class="muted" style="font-size:13px">${esc(displayPhone(s.phone))} · recibido ${esc(short(new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: config.timezone })))}</p>
            ${s.has_photo ? `<img src="/personas/pastores/respuestas/${s.id}/foto" alt="Foto enviada" width="96" height="96" style="border-radius:16px;object-fit:cover;float:right;margin:0 0 8px 12px">` : ''}
            <div class="table-scroll"><table><tr><th></th><th>Ahora</th><th>Envió</th></tr>${rows || '<tr><td colspan="3" class="muted">No trae cambios.</td></tr>'}</table></div>
            <form method="post" action="/personas/pastores/respuestas/${s.id}/aplicar" class="toolbar" style="margin:10px 0 0;align-items:center">
              ${s.wants_messages ? '<label class="check" style="margin:0"><input type="checkbox" name="consent" value="1"> También registrar que aceptó recibir recordatorios (lo pidió en la planilla)</label>' : '<span class="muted" style="font-size:13px">No pidió recibir recordatorios.</span>'}
              <button class="small">${s.person_id ? 'Aprobar y guardar' : 'Aprobar y crear la persona'}</button>
              <button class="small danger" formaction="/personas/pastores/respuestas/${s.id}/descartar">Descartar</button></form></div>`;
        })
        .join('');
      page(
        req,
        res,
        'Respuestas del registro ministerial',
        `<p><a href="/personas/pastores">← Registro ministerial</a></p><h1>Registros ministeriales por revisar</h1>
        <p class="sub">Lo que coincide con una ficha y no trae nada distinto se guarda solo y no pasa por aquí. Al aprobar, la función que declaró queda como el <strong>rol</strong> de su ficha, y la persona se crea <strong>sin consentimiento</strong> (salvo que marques la casilla si lo pidió en la planilla).</p>
        ${cards || '<p class="muted">No hay registros pendientes.</p>'}`
      );
    })
  );
  r.get(
    '/personas/pastores/respuestas/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const p = (await db.query("SELECT photo FROM pastor_submissions WHERE id = $1 AND status = 'pendiente'", [+req.params.id])).rows[0];
      if (!p || !p.photo) return res.status(404).end();
      jpeg(res, p.photo);
    })
  );
  r.post(
    '/personas/pastores/respuestas/:id(\\d{1,9})/:accion(aplicar|descartar)',
    ah(async (req, res) => {
      const id = +req.params.id;
      if (req.params.accion === 'descartar') {
        const ok = await intake.discard(db, id);
        return go(res, '/personas/pastores/respuestas', ok ? { ok: 'Registro descartado.' } : { err: 'Ese registro ya fue atendido.' });
      }
      const out = await intake.apply(db, id, { consent: req.body.consent === '1' });
      if (out.error) return go(res, '/personas/pastores/respuestas', { err: out.error });
      go(res, `/personas/${out.personId}`, { ok: out.created ? 'Persona creada con su función.' : 'Datos guardados en la ficha, con su función.' });
    })
  );

  return r;
}

module.exports = { pastorRequestsRouter };
