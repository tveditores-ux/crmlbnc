'use strict';

/** WhatsApp Cloud API (Meta). Usa fetch nativo de Node 18+. */

// Meta rechaza parámetros de plantilla con saltos de línea, tabs o más de 4 espacios seguidos.
function cleanParam(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 900) || '-';
}

function createWhatsApp(cfg, fetchImpl = globalThis.fetch) {
  const base = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;

  async function post(body) {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* respuesta vacía */
    }
    if (!res.ok) {
      const e = data && data.error;
      const msg = e ? `${e.code || res.status}: ${e.error_user_msg || e.message}` : `HTTP ${res.status}`;
      throw new Error(`WhatsApp ${msg}`);
    }
    return { id: data.messages && data.messages[0] && data.messages[0].id };
  }

  return {
    /**
     * Envía una plantilla aprobada.
     * @param {string} to  número normalizado (solo dígitos)
     * @param {object} opts { name, lang, bodyParams: string[], buttonPayloads: string[] }
     */
    async sendTemplate(to, { name, lang, bodyParams = [], buttonPayloads = [] }) {
      const components = [];
      if (bodyParams.length) {
        components.push({
          type: 'body',
          parameters: bodyParams.map((t) => ({ type: 'text', text: cleanParam(t) })),
        });
      }
      buttonPayloads.forEach((payload, i) => {
        components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(i),
          parameters: [{ type: 'payload', payload }],
        });
      });
      return post({
        to,
        type: 'template',
        template: { name, language: { code: lang }, ...(components.length ? { components } : {}) },
      });
    },

    /** Texto libre: solo funciona dentro de las 24 h después de que la persona escribió. */
    async sendText(to, text) {
      return post({ to, type: 'text', text: { body: String(text).slice(0, 4096) } });
    },
  };
}

module.exports = { createWhatsApp, cleanParam };
