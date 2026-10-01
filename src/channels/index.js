'use strict';
const crypto = require('crypto');
const { createWhatsApp } = require('./whatsapp');
const { createEmail } = require('./email');
const { whatsappReady, emailReady } = require('../config');

/**
 * Devuelve los canales listos para usar. En modo DRY_RUN nada sale a internet:
 * se registra el mensaje como "simulado" para poder probar todo el flujo.
 */
function createChannels(config, { fetchImpl, logger = console } = {}) {
  const waReal = whatsappReady(config) ? createWhatsApp(config.whatsapp, fetchImpl) : null;
  const mailReal = emailReady(config) ? createEmail(config.email, fetchImpl) : null;
  const fakeId = () => `simulado-${crypto.randomBytes(4).toString('hex')}`;

  const simulate = (label) => async (...args) => {
    logger.log(`[DRY_RUN] ${label}`, JSON.stringify(args).slice(0, 500));
    return { id: fakeId(), simulated: true };
  };

  if (config.dryRun) {
    return {
      dryRun: true,
      whatsapp: {
        available: true,
        sendTemplate: simulate('whatsapp.template'),
        sendText: simulate('whatsapp.text'),
      },
      email: { available: true, send: simulate('email') },
    };
  }

  return {
    dryRun: false,
    whatsapp: waReal
      ? { available: true, sendTemplate: waReal.sendTemplate, sendText: waReal.sendText }
      : { available: false },
    email: mailReal ? { available: true, send: mailReal.send } : { available: false },
  };
}

module.exports = { createChannels };
