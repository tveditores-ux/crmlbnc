'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone, normalizeEmail, displayPhone } = require('../src/phone');
const { parseCsv, csvToRecords, detectDelimiter } = require('../src/csv');
const time = require('../src/time');
const msgs = require('../src/messages');
const rem = require('../src/reminders');
const auth = require('../src/auth');
const { cleanParam, createWhatsApp } = require('../src/channels/whatsapp');
const repo = require('../src/repo');

const TZ = 'America/Caracas';
const DAY = 86400000;

test('teléfonos venezolanos se normalizan', () => {
  assert.equal(normalizePhone('0414-123.45.67'), '584141234567');
  assert.equal(normalizePhone('+58 414 1234567'), '584141234567');
  assert.equal(normalizePhone('584241234567'), '584241234567');
  assert.equal(normalizePhone('4121234567'), '584121234567');
  assert.equal(normalizePhone('00 1 305 555 1234'), '13055551234');
  assert.equal(normalizePhone('+1 (305) 555-1234'), '13055551234');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(displayPhone('584141234567'), '0414-123.45.67');
});

test('correos', () => {
  assert.equal(normalizeEmail(' Maria@Ejemplo.COM '), 'maria@ejemplo.com');
  assert.equal(normalizeEmail('maria@'), null);
});

test('CSV con punto y coma, comillas y BOM', () => {
  const text = '﻿Nombre;Teléfono;Ministerios\r\n"Pérez; María";0414-1234567;"Diáconos, Alabanza"\r\nJosé;0424;\r\n';
  assert.equal(detectDelimiter(text), ';');
  const rows = parseCsv(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['Pérez; María', '0414-1234567', 'Diáconos, Alabanza']);
  const { records } = csvToRecords(text);
  assert.equal(records[0].nombre, 'Pérez; María');
  assert.equal(records[0].telefono, '0414-1234567');
  assert.equal(records[0]._line, 2);
});

test('CSV con comillas dobles escapadas y saltos de línea', () => {
  const rows = parseCsv('a,b\n"dijo ""hola""","línea1\nlínea2"\n');
  assert.deepEqual(rows[1], ['dijo "hola"', 'línea1\nlínea2']);
});

test('conversión de hora local de Caracas a UTC y de vuelta', () => {
  const d = time.localInputToDate('2026-10-04T09:30', TZ);
  assert.equal(d.toISOString(), '2026-10-04T13:30:00.000Z');
  assert.equal(time.dateToLocalInput(d, TZ), '2026-10-04T09:30');
  assert.equal(time.localInputToDate('basura', TZ), null);
});

test('conversión con horario de verano (Nueva York)', () => {
  const d = time.localInputToDate('2026-07-01T10:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-07-01T14:00:00.000Z');
  const w = time.localInputToDate('2026-12-01T10:00', 'America/New_York');
  assert.equal(w.toISOString(), '2026-12-01T15:00:00.000Z');
});

test('etiqueta de cuándo', () => {
  const now = new Date('2026-10-01T14:00:00Z'); // 10:00 en Caracas
  assert.equal(time.whenLabel(new Date('2026-10-01T23:00:00Z'), now, TZ), 'hoy');
  assert.equal(time.whenLabel(new Date('2026-10-02T13:00:00Z'), now, TZ), 'mañana');
  assert.equal(time.whenLabel(new Date('2026-10-08T13:00:00Z'), now, TZ), 'en una semana');
  assert.equal(time.whenLabel(new Date('2026-10-31T13:00:00Z'), now, TZ), 'en un mes');
  assert.equal(time.whenLabel(new Date('2026-10-05T13:00:00Z'), now, TZ), 'en 4 días');
  // Medianoche local: 2026-10-02 03:30Z es 23:30 del 1 en Caracas
  assert.equal(time.whenLabel(new Date('2026-10-02T03:30:00Z'), now, TZ), 'hoy');
});

test('formato de fecha en español', () => {
  const s = time.formatEventDate(new Date('2026-10-04T13:30:00Z'), TZ);
  assert.match(s, /domingo/);
  assert.match(s, /octubre/);
  assert.match(s, /9:30/);
});

test('ventanas de recordatorio', () => {
  const start = new Date('2026-11-15T14:00:00Z');
  const at = (msBefore) => new Date(start.getTime() - msBefore);
  assert.equal(rem.dueKind(start, at(31 * DAY)), null);
  assert.equal(rem.dueKind(start, at(30 * DAY)), '1m');
  assert.equal(rem.dueKind(start, at(10 * DAY)), '1m');
  assert.equal(rem.dueKind(start, at(7 * DAY)), '1w');
  assert.equal(rem.dueKind(start, at(3 * DAY)), '1w');
  assert.equal(rem.dueKind(start, at(1 * DAY)), '1d');
  assert.equal(rem.dueKind(start, at(60 * 1000)), '1d');
  assert.equal(rem.dueKind(start, start), null);
  assert.equal(rem.dueKind(start, at(-DAY)), null);
});

test('quién recibe recordatorio según su respuesta', () => {
  assert.equal(rem.shouldRemind('pendiente', '1m'), true);
  assert.equal(rem.shouldRemind('confirmado', '1w'), false);
  assert.equal(rem.shouldRemind('confirmado', '1d'), true);
  assert.equal(rem.shouldRemind('no_puede', '1d'), false);
});

test('elección de canal con respaldo', () => {
  const both = { whatsapp: true, email: true };
  assert.deepEqual(rem.channelsFor({ preferred_channel: 'whatsapp', phone: '58', email: 'a@b.c' }, both), ['whatsapp']);
  assert.deepEqual(rem.channelsFor({ preferred_channel: 'ambos', phone: '58', email: 'a@b.c' }, both), ['whatsapp', 'email']);
  assert.deepEqual(rem.channelsFor({ preferred_channel: 'whatsapp', phone: null, email: 'a@b.c' }, both), ['email']);
  assert.deepEqual(rem.channelsFor({ preferred_channel: 'email', phone: '58', email: 'a@b.c' }, { whatsapp: true, email: false }), ['whatsapp']);
  assert.deepEqual(rem.channelsFor({ preferred_channel: 'email', phone: null, email: 'a@b.c' }, { whatsapp: true, email: false }), []);
});

test('horario de envío', () => {
  const cfg = { timezone: TZ, sendWindowStart: 8, sendWindowEnd: 20 };
  assert.equal(rem.inSendWindow(new Date('2026-10-01T11:00:00Z'), cfg), false); // 7:00
  assert.equal(rem.inSendWindow(new Date('2026-10-01T12:00:00Z'), cfg), true); // 8:00
  assert.equal(rem.inSendWindow(new Date('2026-10-01T23:59:00Z'), cfg), true); // 19:59
  assert.equal(rem.inSendWindow(new Date('2026-10-02T00:00:00Z'), cfg), false); // 20:00
});

test('payload de botones y respuestas escritas', () => {
  const p = msgs.payloadFor('abcDEF123_-x', 'si');
  assert.deepEqual(msgs.parsePayload(p), { token: 'abcDEF123_-x', answer: 'si' });
  assert.equal(msgs.parsePayload('R:x:si'), null);
  assert.equal(msgs.parsePayload('otra cosa'), null);
  assert.equal(msgs.parseFreeText('Sí, confirmo'), 'si');
  assert.equal(msgs.parseFreeText('Confirmo!'), 'si');
  assert.equal(msgs.parseFreeText('No puedo, lo siento'), 'no');
  assert.equal(msgs.parseFreeText('no'), 'no');
  assert.equal(msgs.parseFreeText('¿a qué hora es?'), null);
  assert.equal(msgs.parseFreeText('noche'), null);
});

test('limpieza de parámetros para Meta', () => {
  assert.equal(cleanParam('hola\nmundo\t  x'), 'hola mundo x');
  assert.equal(cleanParam(''), '-');
});

test('la plantilla tiene 5 variables y no empieza ni termina con una', () => {
  const vars = msgs.TEMPLATE_BODY.match(/\{\{\d\}\}/g);
  assert.deepEqual(vars, ['{{1}}', '{{2}}', '{{3}}', '{{4}}', '{{5}}']);
  assert.ok(!/^\{\{/.test(msgs.TEMPLATE_BODY) && !/\}\}$/.test(msgs.TEMPLATE_BODY));
});

test('WhatsApp arma la petición correcta y reporta errores de Meta', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    if (calls.length === 2) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 132001, message: 'Template name does not exist' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.123' }] }) };
  };
  const wa = createWhatsApp({ token: 'T', phoneNumberId: '999', apiVersion: 'v23.0' }, fakeFetch);
  const r = await wa.sendTemplate('584141234567', {
    name: 'recordatorio_evento',
    lang: 'es',
    bodyParams: ['Ana', 'Ensayo', 'mañana', 'sábado', 'Templo'],
    buttonPayloads: ['R:tok12345:si', 'R:tok12345:no'],
  });
  assert.equal(r.id, 'wamid.123');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/999/messages');
  assert.equal(calls[0].auth, 'Bearer T');
  const t = calls[0].body.template;
  assert.equal(t.components[0].parameters.length, 5);
  assert.equal(t.components[1].sub_type, 'quick_reply');
  assert.equal(t.components[2].index, '1');
  assert.equal(t.components[2].parameters[0].payload, 'R:tok12345:no');
  await assert.rejects(() => wa.sendText('584141234567', 'x'), /132001/);
});

test('sesiones firmadas', () => {
  const secret = 'x'.repeat(40);
  const s = auth.makeSession(secret, 1000);
  assert.equal(auth.verifySession(s, secret, 2000), true);
  assert.equal(auth.verifySession(s, 'y'.repeat(40), 2000), false);
  assert.equal(auth.verifySession(s, secret, 1000 + auth.MAX_AGE_MS + 1), false);
  const tampered = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
  assert.equal(auth.verifySession(tampered, secret, 2000), false);
  assert.equal(auth.verifySession('basura', secret), false);
  assert.equal(auth.passwordMatches('clave-correcta', 'clave-correcta'), true);
  assert.equal(auth.passwordMatches('otra', 'clave-correcta'), false);
  assert.equal(auth.passwordMatches('', ''), false);
});

test('límite de intentos de inicio de sesión', () => {
  const l = auth.createLoginLimiter({ max: 2, windowMs: 1000 });
  l.fail('ip', 0);
  assert.equal(l.blocked('ip', 10), false);
  l.fail('ip', 20);
  assert.equal(l.blocked('ip', 30), true);
  assert.equal(l.blocked('ip', 2000), false);
});

test('validación de personas', () => {
  const ok = repo.validatePerson({ full_name: '  Ana   Díaz ', phone: '0414-1234567' }, '58');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.full_name, 'Ana Díaz');
  assert.equal(ok.value.preferred_channel, 'whatsapp');
  const mail = repo.validatePerson({ full_name: 'B', email: 'b@x.com' }, '58');
  assert.equal(mail.value.preferred_channel, 'email');
  assert.match(repo.validatePerson({ full_name: 'C' }, '58').errors[0], /teléfono o correo/);
  assert.match(repo.validatePerson({ full_name: 'D', phone: '12' }, '58').errors[0], /Teléfono no válido/);
  assert.equal(repo.parseYes('Sí'), true);
  assert.equal(repo.parseYes('no'), false);
  assert.equal(repo.parseYes('quizás'), null);
  assert.equal(repo.parseChannel('Correo'), 'email');
  assert.equal(repo.parseChannel('WhatsApp'), 'whatsapp');
  assert.deepEqual(repo.splitMinistries('Diáconos; Alabanza | Medios'), ['Diáconos', 'Alabanza', 'Medios']);
});

test('importar: personas sin contacto se permiten, sin consentimiento, solo con allowNoContact', () => {
  const sin = repo.validatePerson({ full_name: 'Sin Datos', opt_in: true }, '58', { allowNoContact: true });
  assert.deepEqual(sin.errors, []);
  assert.equal(sin.value.opt_in, false);
  assert.match(repo.validatePerson({ full_name: 'Sin Datos' }, '58').errors[0], /teléfono o correo/);
});
