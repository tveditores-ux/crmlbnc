'use strict';

function createEmail(cfg, fetchImpl = globalThis.fetch) {
  if (cfg.provider === 'resend') {
    return {
      async send({ to, subject, html, text }) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.from, to: [to], subject, html, text }),
        });
        let data = {};
        try {
          data = await res.json();
        } catch {
          /* vacío */
        }
        if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message || data.name || 'error'}`);
        return { id: data.id };
      },
    };
  }

  if (cfg.provider === 'smtp') {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    });
    return {
      async send({ to, subject, html, text }) {
        const info = await transport.sendMail({ from: cfg.from, to, subject, html, text });
        return { id: info.messageId };
      },
    };
  }

  return null;
}

module.exports = { createEmail };
