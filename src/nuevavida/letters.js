'use strict';
const path = require('path');
const { normalizePhone } = require('../phone');
const { firstName } = require('../util');

/**
 * Cartas de bienvenida para los nuevos creyentes (pestaña Nueva Vida).
 * Para agregar otra (por ejemplo la de varón): copia el PDF a src/assets/cartas/ y suma una línea aquí.
 */
const LETTERS = [{ id: 'dama', title: 'Carta de bienvenida · Dama', file: 'bienvenida-dama.pdf', hint: 'Para mujeres que recién recibieron a Cristo' }];
const DIR = path.join(__dirname, '..', 'assets', 'cartas');

const letterById = (id) => LETTERS.find((l) => l.id === id) || null;
const letterByFile = (file) => LETTERS.find((l) => l.file === file) || null;
const letterPath = (l) => path.join(DIR, l.file);

const defaultTemplate = (churchName) =>
  `Hola {nombre}, la paz del Señor. Te damos la bienvenida a ${churchName || 'nuestra iglesia'}. Aquí está tu carta de bienvenida: {enlace}`;

/** Arma el mensaje: {nombre} lleva el primer nombre (si no hay, "Hola, ...") y {enlace} la dirección de la carta. */
function buildMessage(template, name, url) {
  let t = String(template || '');
  if (!t.includes('{enlace}')) t = `${t.trim()}\n${'{enlace}'}`; // sin enlace no hay carta: se agrega al final
  const m = t.split('{nombre}').join(name ? firstName(name) : '').split('{enlace}').join(url);
  return m.replace(/Hola\s+,/g, 'Hola,').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Números escritos a mano: uno por línea o separados por coma o punto y coma. Pueden llevar un nombre antes o después
 * ("Ana 0414-000.00.01"). Devuelve { recipients: [{ phone, name }], invalid: [texto] }, sin repetidos.
 */
function parseNumbers(text, countryCode = '58') {
  const recipients = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/[\n;,]+/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const m = chunk.match(/\+?\d[\d\s().-]{5,}\d/);
    const phone = m ? normalizePhone(m[0], countryCode) : null;
    if (!phone) {
      invalid.push(chunk.slice(0, 60));
      continue;
    }
    if (seen.has(phone)) continue;
    seen.add(phone);
    const name = chunk.replace(m[0], ' ').replace(/[:–—-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    recipients.push({ phone, name });
  }
  return { recipients, invalid };
}

/** Enlace de WhatsApp que abre el chat con el mensaje escrito; lo envía la persona desde su propio WhatsApp. */
const waLink = (phone, message) => `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;

module.exports = { LETTERS, letterById, letterByFile, letterPath, defaultTemplate, buildMessage, parseNumbers, waLink };
