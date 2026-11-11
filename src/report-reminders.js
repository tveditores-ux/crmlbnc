'use strict';
/**
 * Recordatorio de reporte semanal de los grupos de cuidado (GdC) + resumen diario a los números pastorales.
 * Lo dispara el programador (src/reminders.js, en cada pasada, como el aviso de cumpleaños) y está APAGADO por
 * defecto (config.agent.reportReminder; Configuración → Asistente o la variable REPORT_REMINDER).
 *
 * Regla de negocio (simple, a propósito):
 *  - Una vez al día, a partir de la hora elegida (config.agent.reportReminderHour, por defecto 9, hora de Caracas),
 *    se miran los grupos activos con día de reunión válido.
 *  - `meeting_day` se guarda como nombre del día en español con mayúscula inicial ('Lunes'…'Domingo',
 *    el DAYS de src/care-groups.js). La "reunión debida" de un grupo es la más reciente ya pasada (hace 1 a 6 días):
 *    si la reunión es HOY todavía no se recuerda.
 *  - El grupo está "sin reporte" si no tiene ningún reporte con meeting_date >= esa fecha de reunión.
 *  - Al líder de cada grupo sin reporte se le envía UN solo recordatorio por reunión: la tabla
 *    care_report_reminders (migración 034) guarda (group_id, meeting_date, canal) como único, al estilo del
 *    claim de src/reminders.js para eventos; un envío fallido puede reintentarse hasta 3 veces, cada 30 minutos.
 *    Se eligió una tabla propia (y no claves en system_state) porque la deduplicación es por grupo+fecha+reunión
 *    (muchas claves, con estado e intentos por envío) y porque queda como auditoría de qué se recordó y cuándo.
 *  - Solo se escribe al líder si está en Personas con ese teléfono (normalizado), activo y con opt_in;
 *    si no, se cuenta como omitido y no se envía nada (regla del repo: solo activos que aceptaron mensajes).
 *  - Mensaje: texto libre primero; si el canal avisa que la ventana de 24 h está cerrada y hay una plantilla
 *    configurada (config.agent.reportReminderTemplate), se envía esa plantilla. El texto solo habla de SU grupo.
 *  - Resumen pastoral: si después de los intentos queda al menos un grupo sin reporte, se envía UNA vez al día
 *    (system_state, clave BRIEF_STATE_KEY, como el aviso de cumpleaños) un resumen corto a los números con
 *    acceso pastoral: grupos sin reporte (grupo — líder — último reporte) y cuántos recordatorios salieron.
 * Respeta DRY_RUN (lo maneja el canal, como el resto de envíos del CRM).
 */
const calendar = require('./calendar');
const pastoral = require('./agent-pastoral');
const wecall = require('./channels/wecall');
const { normalizePhone } = require('./phone');
const { firstName } = require('./util');
const { localHour } = require('./time');

const BRIEF_STATE_KEY = 'resumen_reportes_gdc_ultimo'; // fecha (AAAA-MM-DD) del último día que ya se envió el resumen
const MAX_BRIEF_GROUPS = 15; // el resumen no se convierte en una lista interminable

const localDate = (now, tz) => now.toLocaleDateString('en-CA', { timeZone: tz });
const sinTildes = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** Índice del día de reunión (0 = lunes … 6 = domingo, como calendar.weekday) o -1 si no se entiende. */
function meetingDayIndex(meetingDay) {
  const d = sinTildes(meetingDay);
  if (!d) return -1;
  return calendar.DAYS.findIndex((x) => sinTildes(x) === d);
}

/**
 * Fecha (AAAA-MM-DD) de la reunión más reciente ya pasada de un grupo, o null si la reunión es hoy
 * (todavía no toca recordar) o el día no es válido. today también va en AAAA-MM-DD.
 */
function lastMeetingDate(meetingDay, today) {
  const idx = meetingDayIndex(meetingDay);
  if (idx < 0) return null;
  const back = (calendar.weekday(today) - idx + 7) % 7;
  if (back === 0) return null;
  return calendar.addDays(today, -back);
}

/** El enlace para reportar, solo si el enlace del grupo está activo. */
function reportLink(group, config) {
  return group.link_active && group.token && config.publicUrl ? `${config.publicUrl}/g/${group.token}` : '';
}

/** Texto del recordatorio al líder: solo su grupo, su reunión y su enlace. */
function reminderText({ leaderName, group, meetingDate }, config) {
  const link = reportLink(group, config);
  const lines = [
    `Hola ${firstName(leaderName)}, Dios te bendiga. Te recordamos que tu grupo de cuidado «${group.name}» se reunió el ${calendar.dayLabel(meetingDate)} y aún no hemos recibido su reporte semanal.`,
  ];
  lines.push(link ? `Puedes enviarlo aquí: ${link}` : 'Por favor envíalo cuanto antes; si no tienes tu enlace a mano, pídelo a tu líder asesor.');
  return lines.join('\n');
}

/** Variables de la plantilla (mismo orden que el texto propuesto): nombre, grupo, fecha de la reunión, enlace. */
function templateBodyParams({ leaderName, group, meetingDate }, config) {
  return [firstName(leaderName), group.name, calendar.dayLabel(meetingDate), reportLink(group, config) || config.publicUrl || 'tu enlace de líder'];
}

const dm = (ymd) => (ymd ? `${+ymd.slice(8, 10)}/${+ymd.slice(5, 7)}` : 'sin reportes');

/** Texto del resumen pastoral: un grupo por línea, sin teléfonos ni datos de nadie más. */
function briefText(due, { sent = 0, failed = 0, skipped = 0 } = {}) {
  const lines = due.slice(0, MAX_BRIEF_GROUPS).map((d) => `- ${d.group.name} — ${d.group.leader_name || 'sin líder'} — último reporte: ${dm(d.group.last_report)}`);
  if (due.length > MAX_BRIEF_GROUPS) lines.push(`- …y ${due.length - MAX_BRIEF_GROUPS} más`);
  return [
    `📋 *Grupos de cuidado sin reporte de su última reunión (${due.length}):*`,
    ...lines,
    '',
    `Recordatorios de hoy: ${sent} enviados · ${skipped} omitidos · ${failed} fallidos.`,
  ].join('\n');
}

/**
 * Reserva el recordatorio en la base antes de enviarlo (evita duplicados aunque haya dos procesos).
 * Mismo criterio que el claim de eventos: un fallido se puede reintentar hasta 3 veces, cada 30 minutos.
 */
async function claim(db, groupId, meetingDate) {
  const { rows } = await db.query(
    `INSERT INTO care_report_reminders (group_id, meeting_date, channel, status)
     VALUES ($1, $2, 'whatsapp', 'enviando')
     ON CONFLICT (group_id, meeting_date, channel)
     DO UPDATE SET status = 'enviando', attempts = care_report_reminders.attempts + 1, updated_at = now(), error = NULL
       WHERE care_report_reminders.status = 'fallido'
         AND care_report_reminders.attempts < 3
         AND care_report_reminders.updated_at < now() - interval '30 minutes'
     RETURNING id`,
    [groupId, meetingDate]
  );
  return rows.length ? rows[0].id : null;
}

const isClosedWindow = (e) => /ventana de 24 h|24 ?h|131047|re-engagement/i.test((e && e.message) || '');

/** Envía un WhatsApp (texto libre, con caída a plantilla si la ventana de 24 h está cerrada). Devuelve 'enviado'. */
async function sendWhatsApp(ctx, to, { text, templateName, bodyParams, note, detail }) {
  const { config, channels } = ctx;
  try {
    await channels.whatsapp.sendText(to, text);
    await note({ result: 'enviado', detail });
    return { id: undefined };
  } catch (e) {
    if (isClosedWindow(e) && templateName) {
      const r = await channels.whatsapp.sendTemplate(to, {
        name: templateName,
        lang: config.whatsapp && config.whatsapp.templateLang,
        bodyParams,
      });
      await note({ result: 'enviado', detail: `${detail} (plantilla ${templateName})` });
      return r || {};
    }
    throw e;
  }
}

/** El resumen a los números pastorales, una sola vez al día. Devuelve true si se envió a al menos un número. */
async function sendBrief(ctx, { due, counts, today }) {
  const { db, config, channels } = ctx;
  const phones = pastoral.phoneList(config);
  if (!phones.length) return false;
  const last = (await db.query('SELECT value FROM system_state WHERE key = $1', [BRIEF_STATE_KEY])).rows[0];
  if (last && last.value === today) return false;
  // se marca antes de enviar: si algo falla, no se insiste en cada pasada del programador
  await db.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [BRIEF_STATE_KEY, today]
  );
  const note =
    config.whatsappProvider === 'wecall' && !channels.dryRun
      ? (r) => wecall.recordDelivery(db, { evento: 'resumen_reportes_gdc', ...r })
      : async () => {};
  const text = briefText(due, counts);
  let sent = 0;
  for (const to of phones) {
    try {
      await channels.whatsapp.sendText(to, text);
      sent++;
      await note({ result: 'enviado', detail: `${due.length} grupos sin reporte` });
    } catch (e) {
      console.error('[resumen de reportes] no se pudo enviar:', String(e.message).replace(/\d{7,}/g, '…'));
      await note({ result: 'envio_fallido', detail: String(e.message).replace(/\d{7,}/g, '…') }).catch(() => {});
    }
  }
  return sent > 0;
}

/**
 * Una pasada del recordatorio: se llama en cada tick del programador. Devuelve el resumen
 * { checked, due, sent, failed, skipped, briefSent } (y `reason` si no tocaba correr: apagado, hora, sin WhatsApp).
 */
async function runReportReminders(ctx, now = new Date()) {
  const { db, config, channels } = ctx;
  const summary = { checked: 0, due: 0, sent: 0, failed: 0, skipped: 0, briefSent: false };
  const a = config.agent || {};
  if (!a.reportReminder) return { ...summary, reason: 'apagado' };
  const tz = config.timezone || 'America/Caracas';
  const hour = Number.isInteger(a.reportReminderHour) ? a.reportReminderHour : 9;
  if (localHour(now, tz) < hour) return { ...summary, reason: 'todavía no es la hora' };
  if (!channels.whatsapp || !channels.whatsapp.available) return { ...summary, reason: 'WhatsApp no está disponible' };

  const today = localDate(now, tz);
  const groups = (
    await db.query(
      `SELECT g.id, g.name, g.leader_name, g.leader_phone, g.meeting_day, g.token, g.link_active,
              (SELECT max(r.meeting_date)::text FROM care_group_reports r WHERE r.group_id = g.id) AS last_report
         FROM care_groups g
        WHERE g.active
        ORDER BY g.name`
    )
  ).rows;
  summary.checked = groups.length;

  // reportes de los últimos 6 días: el más reciente por grupo basta para saber si la última reunión ya se reportó
  const recent = (
    await db.query('SELECT group_id, meeting_date::text AS d FROM care_group_reports WHERE meeting_date >= $1', [
      calendar.addDays(today, -6),
    ])
  ).rows;
  const lastRecent = new Map();
  for (const r of recent) {
    const cur = lastRecent.get(r.group_id);
    if (!cur || r.d > cur) lastRecent.set(r.group_id, r.d);
  }

  const due = [];
  for (const g of groups) {
    const meetingDate = lastMeetingDate(g.meeting_day, today);
    if (!meetingDate) continue; // día inválido o la reunión es hoy
    const rep = lastRecent.get(g.id);
    if (rep && rep >= meetingDate) continue; // ya reportó esa reunión (o una posterior)
    due.push({ group: g, meetingDate });
  }
  summary.due = due.length;
  if (!due.length) return summary;

  const note =
    config.whatsappProvider === 'wecall' && !channels.dryRun
      ? (r) => wecall.recordDelivery(db, { evento: 'recordatorio_reporte_gdc', ...r })
      : async () => {};

  for (const item of due) {
    const g = item.group;
    const phone = normalizePhone(g.leader_phone, config.defaultCountryCode || '58');
    if (!phone) {
      summary.skipped++;
      continue;
    }
    const person = (await db.query('SELECT id, full_name, phone, active, opt_in FROM people WHERE phone = $1 LIMIT 1', [phone])).rows[0];
    if (!person || !person.active || !person.opt_in) {
      summary.skipped++; // no está en Personas, está inactivo o no aceptó mensajes: no se le escribe
      continue;
    }
    const logId = await claim(db, g.id, item.meetingDate);
    if (!logId) {
      summary.skipped++; // ya se le recordó esta reunión (o se agotaron los reintentos)
      continue;
    }
    const data = { leaderName: person.full_name || g.leader_name, group: g, meetingDate: item.meetingDate };
    try {
      const r = await sendWhatsApp(ctx, person.phone, {
        text: reminderText(data, config),
        templateName: a.reportReminderTemplate || '',
        bodyParams: templateBodyParams(data, config),
        note,
        detail: `grupo ${g.name}`,
      });
      await db.query(`UPDATE care_report_reminders SET status = 'enviado', provider_message_id = $2, updated_at = now() WHERE id = $1`, [
        logId,
        (r && r.id) || null,
      ]);
      summary.sent++;
    } catch (e) {
      await db.query(`UPDATE care_report_reminders SET status = 'fallido', error = $2, updated_at = now() WHERE id = $1`, [
        logId,
        String(e.message || e).slice(0, 500),
      ]);
      summary.failed++;
      await note({ result: 'envio_fallido', detail: String(e.message).replace(/\d{7,}/g, '…') }).catch(() => {});
    }
  }

  // resumen pastoral: solo si queda al menos un grupo sin reporte, y una sola vez al día
  summary.briefSent = await sendBrief(ctx, {
    due: due.map((d) => ({ group: d.group, meetingDate: d.meetingDate })),
    counts: { sent: summary.sent, failed: summary.failed, skipped: summary.skipped },
    today,
  });
  return summary;
}

module.exports = {
  runReportReminders,
  lastMeetingDate,
  meetingDayIndex,
  reminderText,
  briefText,
  templateBodyParams,
  reportLink,
  claim,
  BRIEF_STATE_KEY,
};
