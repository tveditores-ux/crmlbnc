'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const auth = require('../auth');
const settings = require('../settings');
const brain = require('../agent-brain');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const go = (res, flash) => res.redirect(303, `/configuracion?${new URLSearchParams(flash).toString()}`);

const SOURCE = {
  panel: '<span class="badge b-ok">Guardada en el panel</span>',
  railway: '<span class="badge b-ok">Tomada de Railway</span>',
  falta: '<span class="badge b-bad">Falta</span>',
  ilegible: '<span class="badge b-bad">Guardada pero ilegible</span>',
};

/**
 * Pestaña "Configuración": las claves de WeCall se escriben aquí y no hace falta entrar a Railway.
 * Solo administración (la clave de emergencia o un acceso de Google con nivel admin). Las claves nunca se muestran de vuelta.
 */
function configuracionRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const webhookUrl = () => `${String(config.publicUrl || '').replace(/\/$/, '')}/webhooks/wecall`;

  // solo administración; y los envíos solo desde esta misma página (contra formularios de otros sitios)
  r.use('/configuracion', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = auth.readSession(auth.parseCookies(req.headers.cookie)[auth.COOKIE], config.sessionSecret);
    if (s && s.role && s.role !== 'admin') {
      return res.status(403).send(layout({ title: 'Configuración', active: '/configuracion', config, body: '<div class="card"><h1>Solo administración</h1><p class="muted">Tu acceso no incluye la configuración. Pídesela a quien administra el panel.</p></div>' }));
    }
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          /* origen ilegible: se rechaza */
        }
        if (host !== req.get('host')) return res.sendStatus(403);
      }
    }
    next();
  });

  r.get(
    '/configuracion',
    ah(async (req, res) => {
      const stored = await settings.loadStored(db, config.sessionSecret);
      const src = (k) => settings.sourceOf(k, stored, config);
      const isWc = config.whatsappProvider === 'wecall';
      const missing = ['wecallBaseUrl', 'wecallApiKey', 'wecallWebhookSecret'].filter((k) => src(k) === 'falta' || src(k) === 'ilegible').map((k) => settings.FIELDS[k].label);
      const wa = ctx.channels.whatsapp && ctx.channels.whatsapp.available;
      const faltaBot = [!config.agent.enabled && 'está apagado', !config.agent.apiKey && 'falta la clave del modelo', !wa && 'WhatsApp no está conectado'].filter(Boolean);
      const agentState = faltaBot.length
        ? `<span class="badge b-warn">No responde todavía</span> <span class="muted">${esc(faltaBot.join(' · '))}</span>`
        : config.dryRun
          ? '<span class="badge b-warn">Listo, pero en modo prueba (DRY_RUN): no envía nada</span> <span class="muted">Para que responda de verdad hay que cambiar DRY_RUN a false en Railway.</span>'
          : '<span class="badge b-ok">El asistente responde por WhatsApp</span>';
      const secretRow = (key, name, clearName, help) => `<div style="margin-top:14px"><label for="${name}">${esc(settings.FIELDS[key].label)} ${SOURCE[src(key)]}</label>
        <input id="${name}" type="password" name="${name}" autocomplete="new-password" spellcheck="false" placeholder="${src(key) === 'falta' ? 'Pega aquí la clave' : 'Déjalo vacío para conservar la actual'}">
        <p class="muted" style="margin:4px 0 0;font-size:13px">${help}</p>
        ${stored[key] ? `<label style="font-weight:400;font-size:13px;margin-top:6px"><input type="checkbox" name="${clearName}" value="1" style="width:auto"> Borrar la que guardé en el panel${src(key) === 'panel' && config._env && (key === 'wecallApiKey' ? config._env.wecall.apiKey : config._env.wecall.webhookSecret) ? ' (volvería a valer la de Railway)' : ''}</label>` : ''}</div>`;
      const body = `<h1>Configuración</h1>
        <p class="sub">Aquí se escriben las claves de WeCall, sin entrar a Railway. Lo que guardes aquí se aplica al instante y manda sobre lo que diga Railway.</p>
        <div class="card"><h2 style="margin-top:0">WhatsApp por WeCall</h2>
          <p style="margin:0 0 10px">Estado: ${isWc ? '<span class="badge b-ok">El CRM envía y recibe por WeCall</span>' : '<span class="badge b-warn">Usando Meta directo (WeCall apagado)</span>'}
            ${isWc && missing.length ? ` <span class="badge b-bad">Falta: ${esc(missing.join(', '))}</span>` : ''}</p>
          <form method="post" action="/configuracion/wecall" autocomplete="off">
            <label for="provider">Proveedor de WhatsApp ${SOURCE[src('whatsappProvider')]}</label>
            <select id="provider" name="provider"><option value="meta" ${config.whatsappProvider === 'meta' ? 'selected' : ''}>Meta (conexión directa)</option><option value="wecall" ${isWc ? 'selected' : ''}>WeCall</option></select>
            <div style="margin-top:14px"><label for="base_url">${esc(settings.FIELDS.wecallBaseUrl.label)} ${SOURCE[src('wecallBaseUrl')]}</label>
              <input id="base_url" type="url" name="base_url" value="${esc(stored.wecallBaseUrl && stored.wecallBaseUrl.value ? stored.wecallBaseUrl.value : config.wecall.baseUrl)}" placeholder="https://…" spellcheck="false">
              <p class="muted" style="margin:4px 0 0;font-size:13px">La dirección que te dio WeCall para su API (empieza con https://). No es un secreto.</p></div>
            ${secretRow('wecallApiKey', 'api_key', 'clear_api_key', 'La “API key” del panel de WeCall.')}
            ${secretRow('wecallWebhookSecret', 'webhook_secret', 'clear_webhook_secret', 'El “Webhook secret” del panel de WeCall, con el que se comprueba que los avisos vienen de ellos.')}
            <div class="actions"><button>Guardar</button></div>
            <p class="muted" style="font-size:13px;margin:8px 0 0">Las claves se guardan cifradas y no se vuelven a mostrar. Pegar de nuevo reemplaza la anterior.</p>
          </form>
        </div>
        <div class="card"><h2 style="margin-top:0">Asistente de WhatsApp (el bot)</h2>
          <p style="margin:0 0 10px">${agentState}</p>
          <form method="post" action="/configuracion/agente" autocomplete="off">
            <label for="agent_enabled">El asistente ${SOURCE[src('agentEnabled')]}</label>
            <select id="agent_enabled" name="enabled"><option value="no" ${config.agent.enabled ? '' : 'selected'}>Apagado</option><option value="si" ${config.agent.enabled ? 'selected' : ''}>Encendido: responde a quien le escribe</option></select>
            <div style="margin-top:14px"><label for="agent_key">${esc(settings.FIELDS.anthropicApiKey.label)} ${SOURCE[src('anthropicApiKey')]}</label>
              <input id="agent_key" type="password" name="api_key" autocomplete="new-password" spellcheck="false" placeholder="${src('anthropicApiKey') === 'falta' ? 'Pega aquí la clave' : 'Déjalo vacío para conservar la actual'}">
              <p class="muted" style="margin:4px 0 0;font-size:13px">La clave de la API de Anthropic (empieza con sk-ant-). Es lo que le da “cerebro” al asistente.</p>
              ${stored.anthropicApiKey ? '<label style="font-weight:400;font-size:13px;margin-top:6px"><input type="checkbox" name="clear_api_key" value="1" style="width:auto"> Borrar la que guardé en el panel</label>' : ''}</div>
            <div class="row" style="margin-top:14px">
              <div><label for="agent_model">Modelo ${SOURCE[src('agentModel')]}</label><input id="agent_model" type="text" name="model" value="${esc(config.agent.model)}" spellcheck="false"></div>
              <div><label for="agent_max">Respuestas por persona al día ${SOURCE[src('agentMaxReplies')]}</label><input id="agent_max" type="number" name="max_replies" min="1" max="100" value="${esc(config.agent.maxRepliesPerDay)}"></div></div>
            <div class="row" style="margin-top:14px">
              <div><label for="agent_reviewer">Revisor interno ${SOURCE[src('agentReviewer')]}</label>
                <select id="agent_reviewer" name="reviewer"><option value="no" ${config.agent.reviewer ? '' : 'selected'}>Apagado</option><option value="si" ${config.agent.reviewer ? 'selected' : ''}>Encendido: revisa cada respuesta antes de enviarla</option></select></div>
              <div><label for="agent_rmodel">Modelo del revisor (opcional) ${SOURCE[src('agentReviewerModel')]}</label><input id="agent_rmodel" type="text" name="reviewer_model" value="${esc(config.agent.reviewerModel)}" placeholder="el mismo del asistente" spellcheck="false"></div></div>
            <p class="muted" style="margin:4px 0 0;font-size:13px">El revisor es una segunda mirada: antes de enviar, comprueba la respuesta contra los valores del cerebro. Si la objeta, el asistente la corrige (hasta 2 veces); si sigue mal, pasa el caso a una persona. Usa una consulta más por mensaje.</p>
            <div class="actions"><button>Guardar</button></div>
            <p class="muted" style="font-size:13px;margin:8px 0 0">Solo responde a personas registradas y activas, solo sobre la iglesia, nunca escribe primero, y pasa a un líder o pastor lo que no sabe. Lo que no es de la iglesia lo rechaza con amabilidad.</p>
          </form>
          <div class="actions" style="margin-top:10px"><form class="inline" method="post" action="/configuracion/agente/probar"><button class="sec small">Probar la clave del modelo</button></form>
            <a class="btn sec small" href="/asistente">Probar una conversación (sin enviar nada)</a></div>
        </div>
        <div class="card"><h3 style="margin:0 0 6px">Cerebro del asistente ${config.agent.brain ? '<span class="badge b-ok">Personalizado</span>' : '<span class="badge b-muted">Original</span>'}</h3>
          <p class="muted" style="margin:0 0 8px">Quién es el asistente, sus valores, cómo conversa y cuándo pasa el caso a una persona, escrito en lenguaje normal. Lo editas aquí; las reglas de seguridad (no inventar datos, no dar datos de otros, no salirse de la iglesia) no se pueden quitar.</p>
          <a class="btn sec small" href="/configuracion/cerebro">Ver y editar el cerebro</a></div>
        <div class="card"><h3 style="margin:0 0 6px">Comprobar la conexión</h3>
          <p class="muted" style="margin:0 0 8px">Hace una consulta de solo lectura a WeCall con la API key guardada. No envía ningún mensaje.</p>
          <form method="post" action="/configuracion/wecall/probar"><button class="sec">Probar la API key</button></form></div>
        <div class="card"><h3 style="margin:0 0 6px">Lo que va en el panel de WeCall</h3>
          <p class="muted" style="margin:0 0 6px">En el campo “Webhook URL” de tu número pon esta dirección:</p>
          <input type="text" readonly value="${esc(webhookUrl())}" onclick="this.select()" class="mono">
          <p class="muted" style="margin:8px 0 0;font-size:13px">Cuando WeCall avise de un mensaje, queda anotado en <a href="/pruebas">Pruebas → Últimos avisos de WeCall</a>.</p></div>
        <div class="card"><h3 style="margin:0 0 6px">Modo de envío</h3>
          <p style="margin:0">${config.dryRun ? '<span class="badge b-warn">Prueba (DRY_RUN): los mensajes se registran pero no se envían</span>' : '<span class="badge b-ok">Envíos reales</span>'}</p>
          <p class="muted" style="margin:6px 0 0;font-size:13px">Este interruptor es de seguridad y solo se cambia en Railway (variable <span class="mono">DRY_RUN</span>), a propósito.</p></div>`;
      res.send(layout({ title: 'Configuración', active: '/configuracion', body, config, query: req.query }));
    })
  );

  r.post(
    '/configuracion/wecall',
    ah(async (req, res) => {
      const b = req.body || {};
      const errors = [];
      const changes = []; // [clave, valor | null (borrar)]
      if (b.provider !== undefined) {
        if (!settings.PROVIDERS.includes(b.provider)) errors.push('Elige el proveedor de WhatsApp.');
        else changes.push(['whatsappProvider', b.provider]);
      }
      const url = settings.parseBaseUrl(b.base_url);
      if (url.error) errors.push(url.error);
      else if (url.value) changes.push(['wecallBaseUrl', url.value]);
      else if (b.clear_base_url) changes.push(['wecallBaseUrl', null]);
      for (const [key, field, clear] of [['wecallApiKey', 'api_key', 'clear_api_key'], ['wecallWebhookSecret', 'webhook_secret', 'clear_webhook_secret']]) {
        const s = settings.parseSecret(b[field], settings.FIELDS[key].label);
        if (s.error) errors.push(s.error);
        else if (s.value) changes.push([key, s.value]);
        else if (b[clear]) changes.push([key, null]);
      }
      if (errors.length) return go(res, { err: errors.join(' ') });
      for (const [key, value] of changes) {
        if (value === null) await settings.removeValue(db, key);
        else await settings.setValue(db, config.sessionSecret, key, value);
      }
      await settings.apply(ctx);
      const faltan = config.whatsappProvider === 'wecall' && !(config.wecall.baseUrl && config.wecall.apiKey && config.wecall.webhookSecret);
      go(res, { ok: `Configuración guardada y aplicada.${faltan ? ' Ojo: WeCall está activo pero todavía falta alguno de sus datos.' : ''}` });
    })
  );

  r.post(
    '/configuracion/agente',
    ah(async (req, res) => {
      const b = req.body || {};
      const errors = [];
      const changes = [];
      if (b.enabled !== undefined) {
        if (!['si', 'no'].includes(b.enabled)) errors.push('Elige si el asistente va encendido o apagado.');
        else changes.push(['agentEnabled', b.enabled]);
      }
      const key = settings.parseSecret(b.api_key, settings.FIELDS.anthropicApiKey.label);
      if (key.error) errors.push(key.error);
      else if (key.value) changes.push(['anthropicApiKey', key.value]);
      else if (b.clear_api_key) changes.push(['anthropicApiKey', null]);
      const model = settings.parseModel(b.model);
      if (model.error) errors.push(model.error);
      else if (model.value) changes.push(['agentModel', model.value]);
      if (b.reviewer !== undefined) {
        if (!['si', 'no'].includes(b.reviewer)) errors.push('Elige si el revisor va encendido o apagado.');
        else changes.push(['agentReviewer', b.reviewer]);
      }
      const rmodel = settings.parseModel(b.reviewer_model);
      if (rmodel.error) errors.push(rmodel.error);
      else if (rmodel.value) changes.push(['agentReviewerModel', rmodel.value]);
      const max = settings.parseMaxReplies(b.max_replies);
      if (max.error) errors.push(max.error);
      else if (max.value) changes.push(['agentMaxReplies', max.value]);
      if (errors.length) return go(res, { err: errors.join(' ') });
      for (const [k, value] of changes) {
        if (value === null) await settings.removeValue(db, k);
        else await settings.setValue(db, config.sessionSecret, k, value);
      }
      await settings.apply(ctx);
      const falta = config.agent.enabled && !config.agent.apiKey;
      go(res, { ok: `Asistente guardado y aplicado.${falta ? ' Ojo: está encendido pero todavía falta la clave del modelo.' : ''}` });
    })
  );

  // ---- el cerebro del asistente: ver, editar, restaurar el original ----
  const brainPage = (req, res, { text, status = 200, err = '' } = {}) => {
    const current = text ?? brain.activeBrain(config);
    const body = `<p><a href="/configuracion">← Configuración</a></p><h1>Cerebro del asistente</h1>
      <p class="sub">${config.agent.brain ? '<span class="badge b-ok">Personalizado</span>' : '<span class="badge b-muted">Original</span>'} Escríbelo en lenguaje normal: quién es, qué valores lo mandan, qué hace y qué no, cómo conversa y cuándo pasa el caso a una persona. Los cambios valen desde el siguiente mensaje.</p>
      <div class="card"><h3 style="margin:0 0 6px">Lo que no se puede cambiar</h3>
        <p class="muted" style="margin:0 0 6px;font-size:13px">Estas reglas se agregan siempre al final, aunque el cerebro diga otra cosa, y además el CRM filtra enlaces y teléfonos que no estén en los datos, responde con un mensaje fijo ante una crisis y solo atiende a personas registradas.</p>
        <pre style="white-space:pre-wrap;margin:0;font-size:12px">${esc(brain.REGLAS_FIJAS)}</pre></div>
      <form method="post" action="/configuracion/cerebro" class="card">
        <label for="brain">Cerebro (${brain.MIN_BRAIN} a ${brain.MAX_BRAIN} letras)</label>
        <textarea id="brain" name="brain" spellcheck="true" style="min-height:520px;font-family:inherit;font-size:14px;line-height:1.45">${esc(current)}</textarea>
        <div class="actions"><button>Guardar el cerebro</button>
          <button class="sec" formaction="/configuracion/cerebro/restaurar" formnovalidate onclick="return confirm('Se pierde lo que escribiste y vuelve el cerebro original. ¿Continuar?')">Volver al original</button>
          <a class="btn sec" href="/asistente">Probar una conversación</a></div>
        <p class="muted" style="font-size:13px;margin:8px 0 0">Prueba siempre en <a href="/asistente">Asistente</a> (no envía nada) antes de confiar en un cambio.</p>
      </form>`;
    res.status(status).send(layout({ title: 'Cerebro del asistente', active: '/configuracion', body, config, query: err ? { err } : req.query }));
  };
  r.get('/configuracion/cerebro', (req, res) => brainPage(req, res));
  r.post(
    '/configuracion/cerebro',
    ah(async (req, res) => {
      const p = brain.parseBrain(req.body && req.body.brain);
      if (p.error) {
        return brainPage(req, res, { text: String((req.body && req.body.brain) || ''), status: 400, err: p.error });
      }
      await settings.setValue(db, config.sessionSecret, 'agentBrain', p.value);
      await settings.apply(ctx);
      res.redirect(303, '/configuracion/cerebro?ok=' + encodeURIComponent('Cerebro guardado. Vale desde el siguiente mensaje.'));
    })
  );
  r.post(
    '/configuracion/cerebro/restaurar',
    ah(async (req, res) => {
      await settings.removeValue(db, 'agentBrain');
      await settings.apply(ctx);
      res.redirect(303, '/configuracion/cerebro?ok=' + encodeURIComponent('Volvió el cerebro original.'));
    })
  );

  r.post(
    '/configuracion/agente/probar',
    ah(async (req, res) => {
      const out = await settings.testAnthropic(config.agent, ctx.fetchImpl);
      go(res, out.ok ? { ok: out.text } : { err: out.text });
    })
  );

  r.post(
    '/configuracion/wecall/probar',
    ah(async (req, res) => {
      const out = await settings.testWeCall(config.wecall, ctx.fetchImpl);
      go(res, out.ok ? { ok: out.text } : { err: out.text });
    })
  );

  return r;
}

module.exports = { configuracionRouter };
