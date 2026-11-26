'use strict';
/**
 * Confirmación de asistencia al REDIL por plantilla de WhatsApp (botón del panel «Confirmación REDIL»).
 *
 * - La plantilla es `confirmacion_redil` (Utilidad, español, 3 variables: nombre, día, hora) y tiene que
 *   estar creada y APROBADA en Meta; el CRM solo la envía por WeCall con `sendTemplate`.
 * - Destinatarios: líderes y co-líderes de los grupos de cuidado activos. Cada quien recibe UNA sola
 *   confirmación (aunque lidere varios grupos): se deduplica por teléfono.
 * - Regla del repo: solo se envía a quien está en Personas con ese teléfono, activo y con opt_in
 *   («acepta mensajes»); a los demás la página les muestra el motivo y no se les envía nada.
 * - Cada envío queda registrado en la auditoría de entregas de WeCall (evento `confirmacion_redil`),
 *   como el recordatorio de reportes. Respeta la pausa de envíos: si está puesta, el canal rechaza
 *   cada envío y la página lo cuenta como fallido con ese motivo.
 */
const wecall = require('./channels/wecall');
const { normalizePhone } = require('./phone');
const { firstName } = require('./util');

const TEMPLATE_NAME = 'confirmacion_redil';
const TEMPLATE_LANG = 'es';

const keyOf = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const cleanErr = (e) => String((e && e.message) || e || 'error').replace(/\d{7,}/g, '…').slice(0, 200);

/**
 * La lista de destinatarios con su estado. Devuelve [{ personId, name, phone, groupName, listo, motivo }]
 * ordenada por nombre; `listo` dice si puede recibir y `motivo` explica por qué no, cuando no puede.
 */
async function recipients(db) {
  const groups = (
    await db.query('SELECT name, leader_name, leader_phone, co_leader_name FROM care_groups WHERE active ORDER BY name')
  ).rows;
  const people = (await db.query('SELECT id, full_name, phone, active, opt_in FROM people')).rows;
  const byPhone = new Map();
  const byName = new Map();
  for (const p of people) {
    const ph = normalizePhone(p.phone || '');
    if (ph && !byPhone.has(ph)) byPhone.set(ph, p);
    const k = keyOf(p.full_name);
    if (k && !byName.has(k)) byName.set(k, p);
  }
  const out = [];
  const seenPhones = new Set();
  const push = (name, groupPhone, groupName) => {
    const display = String(name || '').trim();
    if (!display) return;
    const ph = normalizePhone(groupPhone || '');
    const person = (ph && byPhone.get(ph)) || byName.get(keyOf(display)) || null;
    const entry = { personId: person ? person.id : null, name: person ? person.full_name : display, phone: '', groupName, listo: false, motivo: '' };
    if (!person) entry.motivo = 'no está en Personas';
    else if (!normalizePhone(person.phone || '')) entry.motivo = 'sin teléfono en Personas';
    else if (!person.active) entry.motivo = 'está inactivo en Personas';
    else if (!person.opt_in) entry.motivo = 'no acepta mensajes (opt_in)';
    else {
      entry.phone = normalizePhone(person.phone);
      if (seenPhones.has(entry.phone)) return; // una sola confirmación por persona
      seenPhones.add(entry.phone);
      entry.listo = true;
    }
    out.push(entry);
  };
  for (const g of groups) {
    push(g.leader_name, g.leader_phone, g.name);
    if (g.co_leader_name) push(g.co_leader_name, '', g.name);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return out;
}

/**
 * Envía la plantilla a los destinatarios elegidos (por personId) que estén «listos».
 * Devuelve { sent, failed: [{ name, error }] }.
 */
async function sendConfirmations(ctx, { dateText, timeText, personIds }) {
  const { db, config, channels } = ctx;
  const chosen = new Set((personIds || []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0));
  const all = await recipients(db);
  const targets = all.filter((x) => x.listo && chosen.has(x.personId));
  const note =
    config.whatsappProvider === 'wecall' && !channels.dryRun
      ? (r) => wecall.recordDelivery(db, { evento: 'confirmacion_redil', ...r }).catch(() => {})
      : async () => {};
  let sent = 0;
  const failed = [];
  for (const t of targets) {
    const bodyParams = [firstName(t.name), dateText, timeText];
    try {
      await channels.whatsapp.sendTemplate(t.phone, { name: TEMPLATE_NAME, lang: TEMPLATE_LANG, bodyParams });
      sent++;
      await note({ result: 'enviado', detail: `${t.name} · REDIL ${dateText} ${timeText}` });
    } catch (e) {
      failed.push({ name: t.name, error: cleanErr(e) });
      await note({ result: 'envio_fallido', detail: `${t.name}: ${cleanErr(e)}` });
    }
  }
  return { sent, failed };
}

module.exports = { TEMPLATE_NAME, TEMPLATE_LANG, recipients, sendConfirmations };
