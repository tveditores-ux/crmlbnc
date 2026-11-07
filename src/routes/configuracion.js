'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const auth = require('../auth');
const settings = require('../settings');

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
    '/configuracion/wecall/probar',
    ah(async (req, res) => {
      const out = await settings.testWeCall(config.wecall, ctx.fetchImpl);
      go(res, out.ok ? { ok: out.text } : { err: out.text });
    })
  );

  return r;
}

module.exports = { configuracionRouter };
