'use strict';
/**
 * Aviso diario al pastor: quién cumple años hoy (personas y líderes de grupos de cuidado), por WhatsApp, a los números con
 * acceso pastoral (Configuración). Lo dispara el programador una vez al día, a partir de la hora elegida.
 *
 * WhatsApp solo deja escribir texto libre si la persona escribió en las últimas 24 h. Si la ventana está cerrada y hay una
 * plantilla aprobada configurada, se envía con la plantilla (una sola variable con los nombres); si no, queda anotado en
 * Pruebas → Últimos avisos de WeCall para saber por qué no llegó. Respeta DRY_RUN (lo hace el canal).
 */
const calendar = require('./calendar');
const pastoral = require('./agent-pastoral');
const wecall = require('./channels/wecall');

const STATE_KEY = 'aviso_cumpleanos_ultimo'; // fecha (AAAA-MM-DD) del último día que ya se avisó

const localDate = (now, tz) => now.toLocaleDateString('en-CA', { timeZone: tz });
const localHour = (now, tz) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));

/** Cumpleaños de ese día: [{ name, sub }] (sin edad, sin teléfonos). */
async function birthdaysOn(db, tz, date) {
  const items = await calendar.collect(db, tz, date, date);
  return items.filter((i) => i.kind === 'cumple' || i.kind === 'lider').map((i) => ({ name: i.title, sub: i.sub || '' }));
}

/** El texto para WhatsApp, o null si nadie cumple años. */
function briefText(list, date) {
  if (!list.length) return null;
  const lines = list.map((b) => `- ${b.name}${b.sub ? ` (${b.sub})` : ''}`);
  return `🎂 *Cumpleaños de hoy, ${calendar.dayLabel(date)}:*\n${lines.join('\n')}\n\nQue sea una buena oportunidad para bendecirlos.`;
}
/** Para la plantilla: una sola línea (las variables de WhatsApp no aceptan saltos de línea). */
const oneLine = (list) => list.map((b) => (b.sub ? `${b.name} (${b.sub})` : b.name)).join(', ').slice(0, 900);

/**
 * Se llama en cada pasada del programador. Devuelve qué hizo: { skipped: motivo } o { date, sent, failed, count }.
 */
async function runDailyBrief(ctx, now = new Date()) {
  const { db, config, channels } = ctx;
  const a = config.agent || {};
  if (!a.birthdayBrief) return { skipped: 'apagado' };
  const phones = pastoral.phoneList(config);
  if (!phones.length) return { skipped: 'sin números con acceso pastoral' };
  const tz = config.timezone;
  if (localHour(now, tz) < (Number.isInteger(a.briefHour) ? a.briefHour : 7)) return { skipped: 'todavía no es la hora' };
  const date = localDate(now, tz);
  const last = (await db.query('SELECT value FROM system_state WHERE key = $1', [STATE_KEY])).rows[0];
  if (last && last.value === date) return { skipped: 'ya se avisó hoy' };
  // se marca antes de enviar: si algo falla, no se insiste cada 10 minutos
  await db.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STATE_KEY, date]
  );
  const list = await birthdaysOn(db, tz, date);
  const text = briefText(list, date);
  if (!text) return { date, count: 0, sent: 0, failed: 0 };
  if (!channels.whatsapp || !channels.whatsapp.available) return { date, count: list.length, sent: 0, failed: phones.length, error: 'WhatsApp no está disponible' };
  const note = config.whatsappProvider === 'wecall' && !channels.dryRun ? (r) => wecall.recordDelivery(db, { evento: 'aviso_cumpleanos', ...r }) : async () => {};
  let sent = 0;
  let failed = 0;
  for (const to of phones) {
    try {
      await channels.whatsapp.sendText(to, text);
      sent++;
      await note({ result: 'enviado', detail: `${list.length} cumpleaños` });
    } catch (e) {
      const closed = /ventana de 24 h|24 ?h|131047|re-engagement/i.test(e.message);
      if (closed && a.briefTemplate) {
        try {
          await channels.whatsapp.sendTemplate(to, { name: a.briefTemplate, lang: config.whatsapp && config.whatsapp.templateLang, bodyParams: [oneLine(list)] });
          sent++;
          await note({ result: 'enviado', detail: `con la plantilla ${a.briefTemplate}` });
          continue;
        } catch (e2) {
          e.message = `plantilla: ${e2.message}`;
        }
      }
      failed++;
      const why = closed && !a.briefTemplate ? 'la ventana de 24 h está cerrada y no hay plantilla configurada' : String(e.message).replace(/\d{7,}/g, '…');
      console.error('[aviso de cumpleaños] no se pudo enviar:', why);
      await note({ result: 'envio_fallido', detail: why });
    }
  }
  return { date, count: list.length, sent, failed };
}

module.exports = { runDailyBrief, birthdaysOn, briefText, oneLine, STATE_KEY };
