'use strict';
const msgs = require('./messages');

const STATUS_BY_ANSWER = { si: 'confirmado', no: 'no_puede' };

/** Registra la respuesta de un participante a partir de su token. */
async function applyResponse(db, token, answer, channel) {
  const status = STATUS_BY_ANSWER[answer];
  if (!status) return null;
  const { rows } = await db.query(
    `UPDATE event_participants ep
        SET status = $2, responded_at = now(), response_channel = $3
       FROM events e, people p
      WHERE ep.token = $1 AND e.id = ep.event_id AND p.id = ep.person_id
      RETURNING ep.id, ep.status, e.id AS event_id, e.title, e.starts_at, e.location, p.full_name, p.phone`,
    [token, status, channel]
  );
  return rows[0] || null;
}

async function findByToken(db, token) {
  const { rows } = await db.query(
    `SELECT ep.id, ep.status, ep.token, e.title, e.starts_at, e.location, e.cancelled, p.full_name
       FROM event_participants ep
       JOIN events e ON e.id = ep.event_id
       JOIN people p ON p.id = ep.person_id
      WHERE ep.token = $1`,
    [token]
  );
  return rows[0] || null;
}

/** Para respuestas escritas a mano: el evento más próximo con participación pendiente de esa persona. */
async function nextPendingTokenForPhone(db, phone, now) {
  const { rows } = await db.query(
    `SELECT ep.token
       FROM event_participants ep
       JOIN events e ON e.id = ep.event_id
       JOIN people p ON p.id = ep.person_id
      WHERE p.phone = $1 AND e.cancelled = FALSE AND e.starts_at > $2
      ORDER BY (ep.status = 'pendiente') DESC, e.starts_at ASC
      LIMIT 1`,
    [phone, now]
  );
  return rows[0] ? rows[0].token : null;
}

const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Procesa el cuerpo de un webhook de WhatsApp Cloud API.
 * Devuelve un resumen con lo que se hizo (útil para pruebas y registro).
 */
async function handleWhatsAppWebhook(ctx, body) {
  const { db, channels } = ctx;
  const now = ctx.now || new Date();
  const result = { responses: 0, unknown: 0, statuses: 0 };
  if (!body || body.object !== 'whatsapp_business_account') return result;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const st of value.statuses || []) {
        const rank = DELIVERY_RANK[st.status];
        if (!rank) continue;
        const errText =
          st.status === 'failed' && st.errors && st.errors[0]
            ? `${st.errors[0].code}: ${st.errors[0].title || st.errors[0].message || ''}`.slice(0, 500)
            : null;
        await db.query(
          `UPDATE notifications
              SET delivery_status = $2,
                  status = CASE WHEN $2 = 'failed' THEN 'fallido' ELSE status END,
                  error = COALESCE($3, error),
                  updated_at = now()
            WHERE provider_message_id = $1
              AND (delivery_status IS NULL
                   OR array_position(ARRAY['sent','delivered','read','failed'], delivery_status)
                    < array_position(ARRAY['sent','delivered','read','failed'], $2::text))`,
          [st.id, st.status, errText]
        );
        result.statuses++;
      }

      for (const m of value.messages || []) {
        const from = m.from;
        let body = '';
        let payload = null;
        if (m.type === 'button' && m.button) {
          payload = m.button.payload;
          body = m.button.text || '';
        } else if (m.type === 'interactive' && m.interactive) {
          const r = m.interactive.button_reply || m.interactive.list_reply || {};
          payload = r.id;
          body = r.title || '';
        } else if (m.type === 'text' && m.text) {
          body = m.text.body || '';
        } else {
          body = `[${m.type}]`;
        }

        let handledAs = 'sin_interpretar';
        let token = null;
        let answer = null;
        const parsed = msgs.parsePayload(payload);
        if (parsed) {
          token = parsed.token;
          answer = parsed.answer;
        } else {
          answer = msgs.parseFreeText(body);
          if (answer) token = await nextPendingTokenForPhone(db, from, now);
        }

        let updated = null;
        if (token && answer) updated = await applyResponse(db, token, answer, 'whatsapp');
        if (updated) {
          handledAs = updated.status;
          result.responses++;
          if (channels.whatsapp.available) {
            await channels.whatsapp.sendText(from, msgs.ackText(answer, updated.title)).catch((e) => {
              console.error('[webhook] no se pudo enviar el acuse:', e.message);
            });
          }
        } else {
          result.unknown++;
        }

        await db.query(
          `INSERT INTO inbound_messages (from_phone, body, payload, handled_as, raw) VALUES ($1,$2,$3,$4,$5)`,
          [from, body.slice(0, 2000), payload, handledAs, m]
        );
      }
    }
  }
  return result;
}

module.exports = { applyResponse, findByToken, handleWhatsAppWebhook, nextPendingTokenForPhone };
