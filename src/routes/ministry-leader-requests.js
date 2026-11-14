'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const intake = require('../ministry-leader-intake');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const short = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');

/** Líderes de ministerios de desarrollo: compartir su enlace y revisar lo que llega. */
function ministryLeaderRequestsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use(['/personas/ministerios-desarrollo', '/personas/ministerios-desarrollo/respuestas'], (req, res, next) => {
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

  const DEFAULT_ASK = `Hola, la paz del Señor. Estamos registrando la ficha de los líderes de los ministerios de desarrollo de ${config.churchName || 'la iglesia'} (Alabanza, Anfitriones, Diaconado, Nueva Vida, Medios e Intercesión). ¿Me ayudas llenando esta planilla desde tu teléfono? Son dos minutos: {enlace}`;

  r.get(
    '/personas/ministerios-desarrollo',
    ah(async (req, res) => {
      const settings = await intake.ensureToken(db);
      const url = `${config.publicUrl}/desarrollo/${settings.token}`;
      const waiting = await intake.countPending(db);
      // cada ministerio de desarrollo, con su coordinador y cuántas personas sirven en él
      const options = await intake.ministryOptions(db);
      const rows = (
        await db.query(
          `SELECT m.name, c.full_name AS coord, count(pm.person_id)::int AS members
             FROM ministries m
             LEFT JOIN people c ON c.id = m.coordinator_id
             LEFT JOIN person_ministries pm ON pm.ministry_id = m.id
            GROUP BY m.id, c.full_name`
        )
      ).rows;
      const cards = options
        .map((name) => {
          const m = rows.find((x) => intake.sameMinistry(x.name, name));
          return `<div class="card"><div class="stat">${m ? m.members : 0}</div><div class="stat-label">${esc(name)}${m && m.coord ? `<br>Coord.: ${esc(m.coord)}` : ''}</div></div>`;
        })
        .join('');
      page(
        req,
        res,
        'Líderes de ministerios de desarrollo',
        `<p><a href="/personas">← Personas</a> · <a href="/ministerios">Ministerios</a></p><h1>Líderes de ministerios de desarrollo</h1>
        <p class="sub">Un solo enlace para los líderes de los ministerios de desarrollo, que son solo los seis cargados en Ministerios (Alabanza, Anfitriones, Diaconado, Nueva Vida, Medios e Intercesión): cada líder lo abre, elige su ministerio y su cargo, llena su ficha —la misma de los líderes de grupo de cuidado, con el estado civil— y la envía. Los ministerios congregacionales (Niños, Jóvenes, Matrimonios, Mujeres, Hombres…) ya van como congregación en la planilla. Si su teléfono ya está en Personas y no trae nada distinto, su ficha se completa sola; si es alguien nuevo o trae un dato distinto, queda en <a href="/personas/ministerios-desarrollo/respuestas">Respuestas de líderes de desarrollo</a> para que tú lo apruebes. Al guardarse, la persona queda en su ministerio y, si es el líder y el ministerio no tenía coordinador, queda como coordinador.</p>
        ${waiting ? `<div class="flash ok"><a href="/personas/ministerios-desarrollo/respuestas">${waiting} registro${waiting === 1 ? '' : 's'} por revisar →</a></div>` : ''}
        ${cards ? `<h3>Personas por ministerio de desarrollo</h3><div class="grid">${cards}</div>` : ''}
        <div class="card"><h3>Enlace de líderes de ministerios de desarrollo</h3>
          <input type="text" id="link" readonly value="${esc(url)}" onclick="this.select()" style="font-size:13px" ${settings.active ? '' : 'disabled'}>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec" id="copyLink">Copiar enlace</button>
            <form class="inline" method="post" action="/personas/ministerios-desarrollo/enlace/${settings.active ? 'desactivar' : 'activar'}"><button class="small ${settings.active ? 'danger' : 'sec'}">${settings.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/personas/ministerios-desarrollo/enlace/nuevo"><button class="small sec">Generar enlace nuevo</button></form></p>
          <p class="muted" style="font-size:13px;margin:0">Quien tenga el enlace puede enviar un registro diciendo que lidera un ministerio de desarrollo: compártelo solo con esos líderes. Las fichas nuevas siempre pasan por tu revisión antes de entrar a Personas.</p></div>
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
    '/personas/ministerios-desarrollo/enlace/:accion(activar|desactivar|nuevo)',
    ah(async (req, res) => {
      if (req.params.accion === 'nuevo') {
        await intake.regenerateToken(db);
        return go(res, '/personas/ministerios-desarrollo', { ok: 'Enlace nuevo generado. El anterior ya no funciona; vuelve a compartirlo.' });
      }
      await intake.setActive(db, req.params.accion === 'activar');
      go(res, '/personas/ministerios-desarrollo', { ok: req.params.accion === 'activar' ? 'Enlace encendido.' : 'Enlace apagado.' });
    })
  );

  /* -------------------------- Registros por revisar -------------------------- */
  const showVal = (f, v) => (f === 'birth_date' && v ? short(v) : v);
  r.get(
    '/personas/ministerios-desarrollo/respuestas',
    ah(async (req, res) => {
      const pending = await intake.listPending(db);
      const cards = pending
        .map((s) => {
          const rows = [
            ...(['ministerio', 'cargo', ...intake.FIELDS].map((f) => {
              const cur = s['cur_' + f];
              const val = s[f];
              if (!val || (cur !== undefined && val === (cur ?? ''))) return '';
              if ((f === 'ministerio' || f === 'cargo') && cur === undefined) return `<tr><td class="muted">${esc(intake.LABELS[f])}</td><td><span class="muted">—</span></td><td><strong>${esc(val)}</strong></td></tr>`;
              return `<tr><td class="muted">${esc(intake.LABELS[f])}</td><td>${cur ? esc(showVal(f, cur)) : '<span class="muted">—</span>'}</td><td><strong>${esc(showVal(f, val))}</strong></td></tr>`;
            })),
          ].join('');
          return `<div class="card">
            <h3 style="margin-top:0">${esc(s.full_name)} <span class="badge">${esc(s.ministerio)}</span> <span class="badge">${esc(s.cargo)}</span> ${s.person_id ? '<span class="badge b-warn">Ya está en Personas, con datos distintos</span>' : '<span class="badge b-warn">Persona nueva</span>'}</h3>
            <p class="muted" style="font-size:13px">${esc(displayPhone(s.phone))} · recibido ${esc(short(new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: config.timezone })))}</p>
            ${s.has_photo ? `<img src="/personas/ministerios-desarrollo/respuestas/${s.id}/foto" alt="Foto enviada" width="96" height="96" style="border-radius:16px;object-fit:cover;float:right;margin:0 0 8px 12px">` : ''}
            <div class="table-scroll"><table><tr><th></th><th>Ahora</th><th>Envió</th></tr>${rows || '<tr><td colspan="3" class="muted">No trae cambios.</td></tr>'}</table></div>
            <form method="post" action="/personas/ministerios-desarrollo/respuestas/${s.id}/aplicar" class="toolbar" style="margin:10px 0 0;align-items:center">
              ${s.wants_messages ? '<label class="check" style="margin:0"><input type="checkbox" name="consent" value="1"> También registrar que aceptó recibir recordatorios (lo pidió en la planilla)</label>' : '<span class="muted" style="font-size:13px">No pidió recibir recordatorios.</span>'}
              <button class="small">${s.person_id ? 'Aprobar y guardar' : 'Aprobar y crear la persona'}</button>
              <button class="small danger" formaction="/personas/ministerios-desarrollo/respuestas/${s.id}/descartar">Descartar</button></form></div>`;
        })
        .join('');
      page(
        req,
        res,
        'Respuestas de líderes de desarrollo',
        `<p><a href="/personas/ministerios-desarrollo">← Líderes de ministerios de desarrollo</a></p><h1>Registros de líderes de desarrollo por revisar</h1>
        <p class="sub">Lo que coincide con una ficha y no trae nada distinto se guarda solo y no pasa por aquí. Al aprobar, la persona queda en su <strong>ministerio</strong> (y como coordinadora si es la líder y el ministerio no tenía coordinador), y se crea <strong>sin consentimiento</strong> (salvo que marques la casilla si lo pidió en la planilla).</p>
        ${cards || '<p class="muted">No hay registros pendientes.</p>'}`
      );
    })
  );
  r.get(
    '/personas/ministerios-desarrollo/respuestas/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const p = (await db.query("SELECT photo FROM ministry_leader_submissions WHERE id = $1 AND status = 'pendiente'", [+req.params.id])).rows[0];
      if (!p || !p.photo) return res.status(404).end();
      jpeg(res, p.photo);
    })
  );
  r.post(
    '/personas/ministerios-desarrollo/respuestas/:id(\\d{1,9})/:accion(aplicar|descartar)',
    ah(async (req, res) => {
      const id = +req.params.id;
      if (req.params.accion === 'descartar') {
        const ok = await intake.discard(db, id);
        return go(res, '/personas/ministerios-desarrollo/respuestas', ok ? { ok: 'Registro descartado.' } : { err: 'Ese registro ya fue atendido.' });
      }
      const out = await intake.apply(db, id, { consent: req.body.consent === '1' });
      if (out.error) return go(res, '/personas/ministerios-desarrollo/respuestas', { err: out.error });
      go(res, `/personas/${out.personId}`, { ok: out.created ? 'Persona creada y puesta en su ministerio.' : 'Datos guardados en la ficha y en su ministerio.' });
    })
  );

  return r;
}

module.exports = { ministryLeaderRequestsRouter };
