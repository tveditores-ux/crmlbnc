'use strict';
const { applyResponse } = require('./responses');
const { EVENT_TYPES } = require('./event-types');

/**
 * Confirmación del REDIL desde el enlace del líder (/g/<token>/redil).
 * El líder es la persona de Personas con el mismo teléfono que el del grupo. Solo ve y responde los REDIL a los que
 * está convocado (participante del evento): el token de participante nunca sale al navegador, se busca aquí.
 */
const WINDOW_BEFORE = '6 hours'; // un REDIL que empezó hace poco todavía se muestra
const WINDOW_AFTER = '14 days';

/** Los próximos REDIL del líder, con su respuesta actual. [] si no hay persona con ese teléfono o no está convocado. */
async function listForLeader(db, group) {
  if (!group.leader_phone) return [];
  const { rows } = await db.query(
    `SELECT e.id AS event_id, e.title, e.event_type, e.starts_at, e.location, ep.status, ep.responded_at
       FROM people p
       JOIN event_participants ep ON ep.person_id = p.id
       JOIN events e ON e.id = ep.event_id
      WHERE p.phone = $1 AND e.cancelled = FALSE AND e.event_type = ANY($2::text[])
        AND e.starts_at > now() - $3::interval AND e.starts_at < now() + $4::interval
      ORDER BY e.starts_at`,
    [group.leader_phone, EVENT_TYPES, WINDOW_BEFORE, WINDOW_AFTER]
  );
  return rows;
}

/** Cuántos REDIL esperan respuesta del líder (para el aviso en su pantalla principal). */
async function countPending(db, group) {
  return (await listForLeader(db, group)).filter((r) => r.status === 'pendiente').length;
}

/** Registra "voy" / "no puedo" del líder para uno de sus REDIL. Devuelve la fila actualizada o null si no le corresponde. */
async function respond(db, group, eventId, answer) {
  if (!['si', 'no'].includes(answer)) return null;
  const mine = (await listForLeader(db, group)).find((r) => String(r.event_id) === String(eventId));
  if (!mine) return null;
  const { rows } = await db.query(
    `SELECT ep.token FROM event_participants ep JOIN people p ON p.id = ep.person_id WHERE ep.event_id = $1 AND p.phone = $2`,
    [mine.event_id, group.leader_phone]
  );
  if (!rows[0]) return null;
  return applyResponse(db, rows[0].token, answer, 'enlace_lider');
}

module.exports = { listForLeader, countPending, respond };
