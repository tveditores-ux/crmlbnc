'use strict';
const { localHour } = require('./time');
const msgs = require('./messages');

const DAY = 24 * 60 * 60 * 1000;

// Ventanas de recordatorio, de la más lejana a la más cercana.
const OFFSETS = [
  { kind: '1m', ms: 30 * DAY, label: '1 mes antes' },
  { kind: '1w', ms: 7 * DAY, label: '1 semana antes' },
  { kind: '1d', ms: 1 * DAY, label: '1 día antes' },
];
const KIND_LABEL = Object.fromEntries(OFFSETS.map((o) => [o.kind, o.label]));
KIND_LABEL.manual = 'manual';

/**
 * ¿Qué recordatorio corresponde ahora? Cada uno tiene una ventana que termina donde
 * empieza el siguiente. Así, si un evento se crea con 3 días de anticipación,
 * no se manda el "1 mes" ni el "1 semana" tarde: solo el "1 día".
 */
function dueKind(startsAt, now) {
  const s = new Date(startsAt).getTime();
  const n = new Date(now).getTime();
  if (n >= s) return null;
  for (let i = 0; i < OFFSETS.length; i++) {
    const lower = s - OFFSETS[i].ms;
    const upper = i + 1 < OFFSETS.length ? s - OFFSETS[i + 1].ms : s;
    if (n >= lower && n < upper) return OFFSETS[i].kind;
  }
  return null;
}

/** Quien ya confirmó solo recibe el recordatorio de 1 día; quien dijo que no, ninguno. */
function shouldRemind(status, kind) {
  if (status === 'no_puede') return false;
  if (status === 'confirmado') return kind === '1d';
  return true;
}

function channelsFor(person, available) {
  const out = [];
  const wantWa = person.preferred_channel === 'whatsapp' || person.preferred_channel === 'ambos';
  const wantMail = person.preferred_channel === 'email' || person.preferred_channel === 'ambos';
  if (wantWa && person.phone && available.whatsapp) out.push('whatsapp');
  if (wantMail && person.email && available.email) out.push('email');
  // Respaldo: si el canal preferido no se puede usar, intentar el otro.
  if (!out.length) {
    if (person.phone && available.whatsapp) out.push('whatsapp');
    else if (person.email && available.email) out.push('email');
  }
  return out;
}

function inSendWindow(now, config) {
  const h = localHour(now, config.timezone);
  return h >= config.sendWindowStart && h < config.sendWindowEnd;
}

/**
 * Reserva el envío en la base de datos antes de enviarlo (evita duplicados aunque
 * haya dos procesos). Permite reintentar un fallido hasta 3 veces, cada 30 minutos.
 */
async function claim(db, participantId, kind, channel) {
  if (kind === 'manual') {
    const { rows } = await db.query(
      `INSERT INTO notifications (participant_id, kind, channel, status) VALUES ($1,$2,$3,'enviando') RETURNING id`,
      [participantId, kind, channel]
    );
    return rows[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO notifications (participant_id, kind, channel, status)
     VALUES ($1,$2,$3,'enviando')
     ON CONFLICT (participant_id, kind, channel) WHERE kind <> 'manual'
     DO UPDATE SET status = 'enviando', attempts = notifications.attempts + 1, updated_at = now(), error = NULL
       WHERE notifications.status = 'fallido'
         AND notifications.attempts < 3
         AND notifications.updated_at < now() - interval '30 minutes'
     RETURNING id`,
    [participantId, kind, channel]
  );
  return rows.length ? rows[0].id : null;
}

async function sendOne(ctx, row, kind, channel) {
  const { db, config, channels, now } = ctx;
  const notifId = await claim(db, row.participant_id, kind, channel);
  if (!notifId) return { skipped: true };

  const data = msgs.reminderData(
    { person: row, event: { title: row.title, starts_at: row.starts_at, location: row.location }, token: row.token },
    config,
    now
  );
  try {
    let result;
    if (channel === 'whatsapp') {
      result = await channels.whatsapp.sendTemplate(row.phone, msgs.whatsappTemplateArgs(data, row.token, config));
    } else {
      const mail = msgs.reminderEmail(data, config);
      result = await channels.email.send({ to: row.email, ...mail });
    }
    const status = result && result.simulated ? 'simulado' : 'enviado';
    await db.query(
      `UPDATE notifications SET status=$2, provider_message_id=$3, updated_at=now() WHERE id=$1`,
      [notifId, status, result && result.id]
    );
    return { sent: true, status };
  } catch (err) {
    await db.query(`UPDATE notifications SET status='fallido', error=$2, updated_at=now() WHERE id=$1`, [
      notifId,
      String(err.message || err).slice(0, 500),
    ]);
    return { failed: true, error: err.message };
  }
}

const PARTICIPANT_SQL = `
  SELECT ep.id AS participant_id, ep.status, ep.token,
         e.id AS event_id, e.title, e.starts_at, e.location,
         p.id AS person_id, p.full_name, p.phone, p.email, p.preferred_channel
    FROM event_participants ep
    JOIN events e ON e.id = ep.event_id
    JOIN people p ON p.id = ep.person_id
   WHERE e.cancelled = FALSE
     AND p.active = TRUE
     AND p.opt_in = TRUE`;

/** Ejecuta una pasada del programador. Devuelve un resumen. */
async function runReminders(ctx) {
  const { db, config, channels } = ctx;
  const now = ctx.now || new Date();
  const summary = { checked: 0, sent: 0, failed: 0, skipped: 0, outsideWindow: false };

  if (!inSendWindow(now, config)) {
    summary.outsideWindow = true;
    return summary;
  }

  const { rows } = await db.query(
    `${PARTICIPANT_SQL} AND e.starts_at > $1 AND e.starts_at <= $1::timestamptz + interval '31 days'
     ORDER BY e.starts_at`,
    [now]
  );
  const available = { whatsapp: channels.whatsapp.available, email: channels.email.available };

  for (const row of rows) {
    const kind = dueKind(row.starts_at, now);
    if (!kind || !shouldRemind(row.status, kind)) continue;
    summary.checked++;
    for (const channel of channelsFor(row, available)) {
      const r = await sendOne({ ...ctx, now }, row, kind, channel);
      if (r.sent) summary.sent++;
      else if (r.failed) summary.failed++;
      else summary.skipped++;
    }
  }
  return summary;
}

/** Envío manual desde el panel ("Enviar recordatorio ahora"). Ignora horario y ventanas. */
async function sendManual(ctx, eventId, { onlyPending = true } = {}) {
  const { db, channels } = ctx;
  const now = ctx.now || new Date();
  const { rows } = await db.query(`${PARTICIPANT_SQL} AND e.id = $1`, [eventId]);
  const available = { whatsapp: channels.whatsapp.available, email: channels.email.available };
  const summary = { sent: 0, failed: 0, noChannel: 0, errors: [] };
  for (const row of rows) {
    if (row.status === 'no_puede') continue;
    if (onlyPending && row.status !== 'pendiente') continue;
    const chans = channelsFor(row, available);
    if (!chans.length) {
      summary.noChannel++;
      continue;
    }
    for (const channel of chans) {
      const r = await sendOne({ ...ctx, now }, row, 'manual', channel);
      if (r.sent) summary.sent++;
      else if (r.failed) {
        summary.failed++;
        summary.errors.push(`${row.full_name}: ${r.error}`);
      }
    }
  }
  return summary;
}

const SCHED_LOCK = 724002;

function startScheduler(ctx, logger = console) {
  const { db, config } = ctx;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const client = await db.connect().catch((e) => {
      logger.error('[programador] sin conexión a la base de datos:', e.message);
      return null;
    });
    if (!client) {
      running = false;
      return;
    }
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHED_LOCK]);
      if (!rows[0].ok) return; // otra instancia está trabajando
      try {
        const summary = await runReminders({ ...ctx, now: new Date() });
        await db.query(
          `INSERT INTO system_state (key, value, updated_at) VALUES ('last_run', $1, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [JSON.stringify(summary)]
        );
        if (summary.sent || summary.failed) logger.log('[programador]', JSON.stringify(summary));
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHED_LOCK]);
      }
    } catch (err) {
      logger.error('[programador] error:', err);
    } finally {
      client.release();
      running = false;
    }
  };
  const handle = setInterval(tick, config.schedulerIntervalMinutes * 60 * 1000);
  setTimeout(tick, 5000);
  return () => clearInterval(handle);
}

module.exports = {
  OFFSETS,
  KIND_LABEL,
  dueKind,
  shouldRemind,
  channelsFor,
  inSendWindow,
  runReminders,
  sendManual,
  startScheduler,
};
