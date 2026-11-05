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
  const h = String(header || '').trim().replace(/^sha256=/i, '').toLowerCase(); // con o sin el prefijo "sha256="
  if (!secret || !h) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
  const a = Buffer.from(h);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Convierte el evento de WeCall ({ evento: 'mensaje_nuevo', contacto: { telefono }, mensaje: { id, direccion, texto } })
 * al formato del webhook de Meta, para reutilizar todo lo que ya sabe atenderlo (respuestas, asistente, registro).
 * Devuelve null si no es un mensaje entrante.
 */
const INCOMING_EVENTS = new Set(['mensaje_nuevo', 'mensaje_recibido', 'mensaje_entrante', 'message', 'message_received', 'message.received', 'new_message', 'incoming_message']);
const OUTGOING = new Set(['saliente', 'outbound', 'outgoing', 'out', 'enviado']);

function toMetaWebhook(payload, countryCode) {
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload.mensaje || payload.message || {};
  const evento = String(payload.evento || payload.event || '').toLowerCase();
  // un evento conocido de mensaje entrante, o un aviso sin nombre de evento que trae un mensaje
  if (evento ? !INCOMING_EVENTS.has(evento) : !(payload.mensaje || payload.message)) return null;
  if (OUTGOING.has(String(msg.direccion || msg.direction || '').toLowerCase())) return null;
  const c = payload.contacto || payload.contact || {};
  const from = normalizePhone(c.telefono || c.phone || payload.telefono || payload.from, countryCode);
  const mid = msg.id ?? msg.message_id;
  if (!from || mid == null) return null;
  msg.id = mid;
  msg.texto = msg.texto ?? msg.text ?? msg.body ?? msg.mensaje;
  if (msg.texto && typeof msg.texto === 'object') msg.texto = msg.texto.body || '';
  msg.tipo = msg.tipo ?? msg.type;
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

const LOG_KEY = 'wecall_avisos';
/** Guarda los últimos avisos recibidos (sin datos de las personas ni claves) para poder ver en el panel por qué algo no entra. */
async function recordDelivery(db, { result, evento = '', detail = '' }) {
  try {
    const cur = (await db.query('SELECT value FROM system_state WHERE key = $1', [LOG_KEY])).rows[0];
    let list = [];
    try {
      list = JSON.parse(cur ? cur.value : '[]');
    } catch {
      /* se empieza de nuevo */
    }
    list.unshift({ at: new Date().toISOString(), result, evento: String(evento).slice(0, 40), detail: String(detail).slice(0, 120) });
    await db.query(
      "INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [LOG_KEY, JSON.stringify(list.slice(0, 20))]
    );
  } catch (err) {
    console.error('[webhook wecall] no se pudo guardar el aviso:', err.message);
  }
}
async function recentDeliveries(db) {
  const r = (await db.query('SELECT value FROM system_state WHERE key = $1', [LOG_KEY])).rows[0];
  try {
    return JSON.parse(r ? r.value : '[]');
  } catch {
    return [];
  }
}

module.exports = { createWeCall, verifySignature, toMetaWebhook, alreadySeen, recordDelivery, recentDeliveries };
