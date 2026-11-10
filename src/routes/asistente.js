'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { normalizePhone } = require('../phone');
const agent = require('../agent');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_ENTRIES = 40;

/** Pestaña Asistente: estado del asistente de WhatsApp, la información de la iglesia que puede compartir y un probador. */
function asistenteRouter(ctx) {
  const { db, config } = ctx;
  const channels = ctx.channels || {};
  const r = express.Router();
  r.use('/asistente', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/asistente', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const yn = (ok, yes, no) => (ok ? `<span class="badge b-ok">${yes}</span>` : `<span class="badge b-warn">${no}</span>`);

  const entryForm = (k) => `<form method="post" action="/asistente/info/${k.id}" class="card" style="${k.active ? '' : 'opacity:.6'}">
      <label>Título</label><input type="text" name="title" maxlength="120" value="${esc(k.title)}" required>
      <label>Texto que puede compartir</label><textarea name="body" maxlength="1000" required style="min-height:80px">${esc(k.body)}</textarea>
      <div class="actions"><label class="check" style="margin:0"><input type="checkbox" name="active" value="1" ${k.active ? 'checked' : ''}> Activa</label>
        <button class="small">Guardar</button>
        <button class="small danger" formaction="/asistente/info/${k.id}/eliminar" onclick="return confirm('¿Borrar esta información?')">Borrar</button></div></form>`;

  r.get(
    '/asistente',
    ah(async (req, res) => {
      const entries = (await db.query('SELECT * FROM agent_knowledge ORDER BY sort, id')).rows;
      const hasKey = !!config.agent.apiKey;
      let result = '';
      if (req.query.probar) {
        const phone = normalizePhone(req.query.telefono, config.defaultCountryCode);
        const out = phone ? await agent.dryAnswer(ctx, { phone, text: req.query.mensaje }) : { kind: 'telefono' };
        const label = {
          modelo: (out.escalate ? 'Respondería y pasaría el caso a un líder o pastor' : 'Respondería así') + (out.revisions ? ` (el revisor interno la corrigió ${out.revisions} ${out.revisions === 1 ? 'vez' : 'veces'})` : '') + (out.pastoral ? ' (modo pastoral: consultó los datos de la iglesia)' : ''),
          crisis: 'Mensaje de crisis: respuesta fija y aviso urgente al equipo pastoral (sin usar el modelo)',
          desconocido: 'Ese número no está registrado: respondería el aviso fijo, sin usar el modelo',
          bloqueada: 'El filtro de seguridad bloqueó la respuesta del modelo; enviaría el aviso fijo y pasaría el caso',
          rechazada: 'El revisor interno no aprobó la respuesta ni después de corregirla; enviaría el aviso fijo y pasaría el caso',
          sin_clave: 'Falta la clave del modelo (ANTHROPIC_API_KEY) en el servidor',
          vacio: 'Escribe un mensaje de prueba',
          telefono: 'Escribe un número de teléfono válido',
          error: `El modelo no respondió: ${out.error || ''}`,
        }[out.kind];
        result = `<div class="card"><strong>${esc(label)}</strong>
          ${out.reply ? `<pre style="margin:8px 0 0">${esc(out.reply)}</pre>` : ''}
          ${out.reason ? `<p class="muted" style="margin:6px 0 0">Motivo para el equipo: ${esc(out.reason)}</p>` : ''}
          ${out.original ? `<p class="muted" style="margin:6px 0 0">Lo que el modelo quería decir (no se enviaría): ${esc(out.original)}</p>` : ''}</div>`;
      }
      page(
        req,
        res,
        'Asistente',
        `<h1>Asistente virtual de WhatsApp</h1>
        <p class="sub">Atiende a las personas registradas sobre la vida de la iglesia: eventos y horarios, grupos de cuidado, ministerios, y ayuda a los líderes con su propio grupo. Todo lo demás lo rechaza con amabilidad y lo pasa a un líder o pastor, que lo ve en <a href="/conversaciones">Conversaciones</a>.</p>
        <div class="grid">
          <div class="card"><div class="stat-label">Asistente</div>${yn(config.agent.enabled, 'Encendido', 'Apagado')}</div>
          <div class="card"><div class="stat-label">Clave del modelo</div>${yn(hasKey, 'Configurada', 'Falta')}</div>
          <div class="card"><div class="stat-label">WhatsApp</div>${yn(channels.whatsapp && channels.whatsapp.available, 'Conectado', 'Sin conectar')}</div>
          <div class="card"><div class="stat-label">Respuestas por persona al día</div><strong>${config.agent.maxRepliesPerDay}</strong></div>
        </div>
        <p class="muted" style="font-size:13px"><a href="/configuracion/cerebro">Ver y editar el cerebro del asistente</a> · Se enciende y se le pone la clave en <a href="/configuracion">Configuración</a> (también valen las variables <span class="mono">AGENT_ENABLED</span> y <span class="mono">ANTHROPIC_API_KEY</span> de Railway). Mientras WhatsApp no esté conectado, o con <span class="mono">DRY_RUN</span> activo, el asistente no envía nada.</p>

        <h2>Límites del asistente</h2>
        <div class="card"><ul style="margin:0;padding-left:20px">
          <li>Solo responde a personas <strong>registradas y activas</strong>; a un número desconocido le pide que hable con su líder.</li>
          <li>Solo conoce los datos de <strong>quien le escribe</strong> (sus eventos, sus ministerios y, si es líder, su grupo) y la información de abajo. Nunca da datos de otras personas.</li>
          <li>Si le escriben algo fuera de la iglesia (política, noticias, tareas, tecnología...), lo rechaza y ofrece pasar el caso a su líder.</li>
          <li>Consejería, conflictos, quejas, ayuda o cualquier necesidad pastoral: <strong>escala</strong> a un líder o pastor.</li>
          <li>Mensajes de riesgo (crisis): respuesta fija y aviso urgente, sin pasar por el modelo.</li>
          <li><strong>Filtro de salida:</strong> si una respuesta trae un enlace o un teléfono que no está en sus datos, no se envía.</li>
        </ul></div>

        <h2>Información de la iglesia</h2>
        <p class="sub">Lo que escribas aquí lo puede compartir con cualquier persona registrada: horarios de reunión, sedes y direcciones, cómo bautizarse, contactos oficiales. Si algo no está aquí, el asistente <strong>no lo inventa</strong>: lo pasa a un líder. No pongas datos de personas.</p>
        ${entries.map(entryForm).join('')}
        ${
          entries.length < MAX_ENTRIES
            ? `<form method="post" action="/asistente/info" class="card">
          <h3 style="margin:0 0 6px">Agregar información</h3>
          <label>Título</label><input type="text" name="title" maxlength="120" required placeholder="Ej.: Horario de los servicios">
          <label>Texto que puede compartir</label><textarea name="body" maxlength="1000" required style="min-height:80px" placeholder="Ej.: Domingos a las 8:00 am, 10:00 am y 12:00 m en la sede Las Mercedes."></textarea>
          <div class="actions"><button>Agregar</button></div></form>`
            : `<p class="muted">Llegaste al máximo de ${MAX_ENTRIES} entradas.</p>`
        }

        <h2>Probar el asistente</h2>
        <p class="sub">Escribe el número de una persona registrada y un mensaje: verás qué respondería, <strong>sin enviar nada por WhatsApp ni guardar nada</strong>. Usa el modelo real, así que gasta un poco de crédito.</p>
        <form method="get" action="/asistente" class="card toolbar">
          <input type="hidden" name="probar" value="1">
          <div><label>Número de la persona</label><input type="text" name="telefono" value="${esc(req.query.telefono || '')}" placeholder="0414-000.00.00" inputmode="tel" required></div>
          <div style="flex:3 1 320px"><label>Mensaje</label><input type="text" name="mensaje" value="${esc(req.query.mensaje || '')}" maxlength="500" placeholder="¿A qué hora es el culto?" required></div>
          <button class="sec">Probar</button></form>
        ${result}`
      );
    })
  );

  const clean = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);

  r.post(
    '/asistente/info',
    ah(async (req, res) => {
      const title = clean(req.body.title, 120);
      const body = clean(req.body.body, 1000);
      if (!title || !body) return go(res, '/asistente', { err: 'Escribe el título y el texto.' });
      const n = (await db.query('SELECT count(*)::int AS n FROM agent_knowledge')).rows[0].n;
      if (n >= MAX_ENTRIES) return go(res, '/asistente', { err: `Máximo ${MAX_ENTRIES} entradas.` });
      await db.query('INSERT INTO agent_knowledge (title, body, sort) VALUES ($1, $2, $3)', [title, body, n]);
      go(res, '/asistente', { ok: 'Información agregada.' });
    })
  );
  r.post(
    '/asistente/info/:id(\\d{1,9})',
    ah(async (req, res) => {
      const title = clean(req.body.title, 120);
      const body = clean(req.body.body, 1000);
      if (!title || !body) return go(res, '/asistente', { err: 'Escribe el título y el texto.' });
      await db.query('UPDATE agent_knowledge SET title = $2, body = $3, active = $4, updated_at = now() WHERE id = $1', [+req.params.id, title, body, req.body.active === '1']);
      go(res, '/asistente', { ok: 'Información guardada.' });
    })
  );
  r.post(
    '/asistente/info/:id(\\d{1,9})/eliminar',
    ah(async (req, res) => {
      await db.query('DELETE FROM agent_knowledge WHERE id = $1', [+req.params.id]);
      go(res, '/asistente', { ok: 'Información borrada.' });
    })
  );

  return r;
}

module.exports = { asistenteRouter };
