'use strict';
const express = require('express');
const crypto = require('crypto');
const { layout } = require('../views/layout');
const { esc, firstName } = require('../util');
const { formatEventDate } = require('../time');
const responses = require('../responses');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function publicRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const tz = config.timezone;

  /* ---------- Página de confirmación (enlaces de correo) ---------- */
  function confirmPage(p, { done, preselect } = {}) {
    let body;
    if (!p) {
      body = `<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace no existe o ya no está disponible.</p></div>`;
    } else if (p.cancelled) {
      body = `<div class="card"><h1>${esc(p.title)}</h1><p>Este evento fue cancelado. ¡Gracias por tu disposición!</p></div>`;
    } else {
      const state =
        p.status === 'confirmado'
          ? '<div class="flash ok">Tu participación está confirmada.</div>'
          : p.status === 'no_puede'
          ? '<div class="flash err">Registramos que no podrás asistir.</div>'
          : '';
      const past = new Date(p.starts_at) <= new Date();
      body = `<div class="card" style="max-width:520px;margin:0 auto">
        ${done ? '<p style="font-size:18px;margin-top:0"><strong>¡Gracias por responder!</strong></p>' : ''}
        <p style="margin-top:0">Hola ${esc(firstName(p.full_name))},</p>
        <h1>${esc(p.title)}</h1>
        <p class="sub">${esc(formatEventDate(p.starts_at, tz))}${p.location ? `<br>${esc(p.location)}` : ''}</p>
        ${state}
        ${
          past
            ? '<p class="muted">Este evento ya pasó.</p>'
            : `<form method="post" class="actions">
                 <button name="r" value="si" style="background:var(--ok)${preselect === 'si' ? ';outline:3px solid #9fc9b2' : ''}">Confirmo</button>
                 <button name="r" value="no" class="danger"${preselect === 'no' ? ' style="outline:3px solid #e1b3a7"' : ''}>No puedo</button>
               </form>`
        }
      </div>`;
    }
    return layout({ title: 'Confirmación', body, config, bare: true });
  }

  // GET no modifica nada: los lectores de correo a veces abren los enlaces automáticamente.
  r.get(
    '/c/:token',
    ah(async (req, res) => {
      const p = await responses.findByToken(db, req.params.token);
      res.status(p ? 200 : 404).send(confirmPage(p, { preselect: req.query.r }));
    })
  );

  r.post(
    '/c/:token',
    ah(async (req, res) => {
      const answer = req.body.r === 'si' ? 'si' : req.body.r === 'no' ? 'no' : null;
      const p0 = await responses.findByToken(db, req.params.token);
      if (!p0) return res.status(404).send(confirmPage(null));
      if (answer && !p0.cancelled && new Date(p0.starts_at) > new Date()) {
        await responses.applyResponse(db, req.params.token, answer, 'enlace');
      }
      const p = await responses.findByToken(db, req.params.token);
      res.send(confirmPage(p, { done: Boolean(answer) }));
    })
  );

  /* ---------- Webhook de WhatsApp ---------- */
  r.get('/webhooks/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
      return res.status(200).type('text/plain').send(String(challenge || ''));
    }
    res.sendStatus(403);
  });

  r.post(
    '/webhooks/whatsapp',
    ah(async (req, res) => {
      if (config.whatsapp.appSecret) {
        const sig = String(req.get('x-hub-signature-256') || '');
        const expected =
          'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody || '').digest('hex');
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
      }
      // Siempre respondemos 200 para que Meta no reintente en bucle; los errores quedan en el registro.
      try {
        await responses.handleWhatsAppWebhook(ctx, req.body);
      } catch (err) {
        console.error('[webhook] error procesando:', err);
      }
      res.sendStatus(200);
    })
  );

  return r;
}

module.exports = { publicRouter };
