'use strict';
const crypto = require('crypto');
const { normalizePhone } = require('../phone');

/**
 * WeCall Inbox: el sistema que administra el número de WhatsApp Business (API oficial de Meta).
 * El CRM le habla por su API v1 (Bearer WECALL_API_KEY) y recibe los mensajes por webhook firmado
 * (X-WeCall-Signature: sha256=<hmac del cuerpo crudo>). Misma forma de canal que channels/whatsapp.js.
 */
function createWeCall(cfg, fetchImpl = globalThis.fetch) {
  async function post(path, body) {
    const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* respuesta vacía */
    }
    if (res.status === 409) throw new Error('WeCall: la ventana de 24 h está cerrada; hace falta una plantilla aprobada');
    if (!res.ok) throw new Error(`WeCall ${res.status}: ${String((data && (data.error || data.detail)) || 'error').slice(0, 300)}`);
    const m = data.mensaje || {};
    return { id: String(data.id ?? data.message_id ?? m.id ?? '') || undefined };
  }

  return {
    /** Texto libre: solo dentro de las 24 h después de que la persona escribió (si no, WeCall responde 409). */
    async sendText(to, text) {
      return post('/api/v1/mensajes/enviar/', { telefono: to, texto: String(text).slice(0, 4096) });
    },
    /** Plantilla aprobada. WeCall recibe las variables como objeto {"1": ..., "2": ...} en el orden de la plantilla. */
    async sendTemplate(to, { name, bodyParams = [] }) {
      const variables = Object.fromEntries(bodyParams.map((t, i) => [String(i + 1), String(t ?? '-').replace(/\s+/g, ' ').trim() || '-']));
      return post('/api/v1/mensajes/enviar/', { telefono: to, plantilla: name, variables });
    },
  };
}

/** Firma del webhook: sha256=<hex> del HMAC del cuerpo crudo, comparada a tiempo constante. */
function verifySignature(secret, rawBody, header) {
  const h = String(header || '');
  if (!secret || !h.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
  const a = Buffer.from(h.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Convierte el evento de WeCall ({ evento: 'mensaje_nuevo', contacto: { telefono }, mensaje: { id, direccion, texto } })
 * al formato del webhook de Meta, para reutilizar todo lo que ya sabe atenderlo (respuestas, asistente, registro).
 * Devuelve null si no es un mensaje entrante.
 */
function toMetaWebhook(payload, countryCode) {
  if (!payload || payload.evento !== 'mensaje_nuevo') return null;
  const msg = payload.mensaje || {};
  if (msg.direccion && msg.direccion !== 'entrante') return null;
  const from = normalizePhone((payload.contacto || {}).telefono, countryCode);
  if (!from || msg.id == null) return null;
  const texto = String(msg.texto || '').trim();
  const m = texto
    ? { id: `wecall-${msg.id}`, from, type: 'text', text: { body: texto } }
    : { id: `wecall-${msg.id}`, from, type: String(msg.tipo || 'unsupported') };
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [m] } }] }] };
}

/** WeCall puede repetir un aviso: si ese mensaje ya quedó registrado, no se atiende otra vez. */
async function alreadySeen(db, body) {
  const ids = body.entry.flatMap((e) => e.changes.flatMap((c) => (c.value.messages || []).map((m) => m.id)));
  if (!ids.length) return false;
  const { rows } = await db.query("SELECT 1 FROM inbound_messages WHERE raw->>'id' = ANY($1::text[]) LIMIT 1", [ids]);
  return rows.length > 0;
}

module.exports = { createWeCall, verifySignature, toMetaWebhook, alreadySeen };
