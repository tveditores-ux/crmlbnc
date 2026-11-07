'use strict';
const express = require('express');
const { createRateLimiter } = require('../attendance-store');
const lib = require('../redil-libreta');
const { openPage } = require('../views/redil-libreta');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Control remoto de la libretica del REDIL: un enlace secreto común (/libreta/<token>) que se manda por WhatsApp y abre SOLO la
 * libretica. Sin sesión del panel. La persona escribe su nombre y toca "Enviar a REDIL del CRM"; la página no lee nada de la base.
 * No crea personas ni toca opt_in.
 */
function libretaRemotaRouter(ctx) {
  const { db } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 120 });
  const sendLimiter = createRateLimiter({ max: 60 });

  r.get(
    '/libreta/:token',
    ah(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!limiter.take(`${req.ip}|get`)) return res.sendStatus(429);
      if (!(await lib.linkIsValid(db, req.params.token))) {
        return res.status(404).send('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Enlace no válido</title><body style="font-family:system-ui;padding:24px"><h2>Enlace no válido</h2><p>Pídele uno nuevo a quien administra el panel.</p></body></html>');
      }
      res.send(openPage({ L: lib.getLibreta(), token: req.params.token, libretaKey: lib.ACTIVE }));
    })
  );

  r.post(
    '/libreta/:token/enviar',
    ah(async (req, res) => {
      if (!(await lib.linkIsValid(db, req.params.token))) return res.sendStatus(404);
      if (!sendLimiter.take(`${req.ip}|${req.params.token}`)) return res.sendStatus(429);
      const sub = lib.parseOpenSubmission(lib.getLibreta(), req.body);
      if (sub.errors.length) return res.status(400).json({ errors: sub.errors });
      await lib.saveOpenSheet(db, sub.value, lib.ACTIVE);
      res.sendStatus(204);
    })
  );
  return r;
}

module.exports = { libretaRemotaRouter };
