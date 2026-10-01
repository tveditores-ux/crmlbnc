'use strict';
const { formatEventDate, whenLabel } = require('./time');
const { esc, firstName } = require('./util');

/**
 * Texto de la plantilla que hay que registrar en Meta (categoría: Utilidad, idioma: Español).
 * Se muestra también en el panel (página "Pruebas") para copiarla tal cual.
 */
const TEMPLATE_BODY =
  'Hola {{1}}, te recordamos que {{2}} es {{3}}: {{4}}, en {{5}}. ¿Nos confirmas tu participación?';
const TEMPLATE_BUTTONS = ['Confirmo', 'No puedo'];

function payloadFor(token, answer) {
  return `R:${token}:${answer}`;
}

function parsePayload(payload) {
  const m = /^R:([A-Za-z0-9_-]{8,}):(si|no)$/.exec(String(payload || ''));
  return m ? { token: m[1], answer: m[2] } : null;
}

/** Interpreta una respuesta escrita a mano en WhatsApp. */
function parseFreeText(text) {
  const t = String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[!¡.,👍🙏]/gu, '')
    .trim();
  if (!t) return null;
  if (/^(no|no puedo|no podre|no voy|no asistire|2)\b/.test(t)) return 'no';
  if (/^(si|confirmo|confirmado|ok|okay|dale|claro|alli estare|ahi estare|1|amen)\b/.test(t)) return 'si';
  return null;
}

function reminderData({ person, event, token }, config, now = new Date()) {
  const tz = config.timezone;
  return {
    name: firstName(person.full_name),
    title: event.title,
    when: whenLabel(event.starts_at, now, tz),
    date: formatEventDate(event.starts_at, tz),
    location: event.location || config.churchName,
    link: `${config.publicUrl}/c/${token}`,
  };
}

function whatsappTemplateArgs(data, token, config) {
  return {
    name: config.whatsapp.templateName,
    lang: config.whatsapp.templateLang,
    bodyParams: [data.name, data.title, data.when, data.date, data.location],
    buttonPayloads: [payloadFor(token, 'si'), payloadFor(token, 'no')],
  };
}

function reminderEmail(data, config) {
  const subject = `Recordatorio: ${data.title} (${data.when})`;
  const text = [
    `Hola ${data.name},`,
    '',
    `Te recordamos que ${data.title} es ${data.when}: ${data.date}, en ${data.location}.`,
    '',
    `Confirma tu participación aquí: ${data.link}`,
    '',
    config.churchName,
  ].join('\n');
  const btn = (href, label, bg) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;margin:4px 8px 4px 0;border-radius:8px;background:${bg};color:#fff;text-decoration:none;font-weight:600">${esc(label)}</a>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1f2a2e">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
  <p style="font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b6250;margin:0 0 16px">${esc(config.churchName)}</p>
  <div style="background:#fff;border-radius:12px;padding:24px">
    <p style="margin:0 0 12px;font-size:16px">Hola ${esc(data.name)},</p>
    <p style="margin:0 0 6px;font-size:16px">Te recordamos que <strong>${esc(data.title)}</strong> es <strong>${esc(data.when)}</strong>.</p>
    <p style="margin:0 0 20px;font-size:15px;color:#4a4a4a">${esc(data.date)}<br>${esc(data.location)}</p>
    <p style="margin:0 0 10px;font-size:15px">¿Nos confirmas tu participación?</p>
    ${btn(`${data.link}?r=si`, 'Confirmo', '#2f6b4f')}${btn(`${data.link}?r=no`, 'No puedo', '#8a4b3c')}
  </div>
</div></body></html>`;
  return { subject, text, html };
}

function ackText(answer, eventTitle) {
  return answer === 'si'
    ? `¡Gracias! Quedó registrada tu confirmación para ${eventTitle}. Dios te bendiga.`
    : `Gracias por avisar. Registramos que no podrás asistir a ${eventTitle}.`;
}

module.exports = {
  TEMPLATE_BODY,
  TEMPLATE_BUTTONS,
  payloadFor,
  parsePayload,
  parseFreeText,
  reminderData,
  whatsappTemplateArgs,
  reminderEmail,
  ackText,
};
