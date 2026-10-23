'use strict';

const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Nombre del día para una fecha 'AAAA-MM-DD' (sin depender de la zona horaria). */
function dayNameFor(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * Guarda un servicio. Si ya existe uno de la misma sede, fecha y horario, lo actualiza.
 * Devuelve { created: boolean }.
 */
async function upsertAttendance(db, v, source = 'panel') {
  const { rows } = await db.query(
    `INSERT INTO service_attendance (service_date, sede, day_name, horario, att_start, att_mid, att_end, guests, conversions, servers, pastors, kids, preteens, teens, notes, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (service_date, lower(sede), horario) DO UPDATE SET
       day_name=EXCLUDED.day_name, att_start=EXCLUDED.att_start, att_mid=EXCLUDED.att_mid, att_end=EXCLUDED.att_end,
       guests=EXCLUDED.guests, conversions=EXCLUDED.conversions, servers=EXCLUDED.servers, pastors=EXCLUDED.pastors,
       kids=EXCLUDED.kids, preteens=EXCLUDED.preteens, teens=EXCLUDED.teens, notes=EXCLUDED.notes, source=EXCLUDED.source, updated_at=now()
     RETURNING (xmax = 0) AS created`,
    [v.service_date, v.sede, v.day_name, v.horario, v.att_start, v.att_mid, v.att_end, v.guests, v.conversions, v.servers, v.pastors, v.kids, v.preteens, v.teens, v.notes, source]
  );
  return { created: Boolean(rows[0] && rows[0].created) };
}

/** Limitador en memoria: máximo `max` envíos por clave en la ventana. */
function createRateLimiter({ max = 40, windowMs = 60 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      const h = hits.get(key);
      if (!h || h.reset < now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        return true;
      }
      h.count++;
      return h.count <= max;
    },
  };
}

module.exports = { dayNameFor, upsertAttendance, createRateLimiter, WEEKDAYS };
