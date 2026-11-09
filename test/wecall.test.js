'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadConfig, whatsappReady } = require('../src/config');
const { createApp } = require('../src/app');
const { createChannels } = require('../src/channels');
const wecall = require('../src/channels/wecall');
const { openTestDb } = require('./helpers/db');

const SECRET = 'secreto-de-prueba-wecall';
const sign = (body, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const env = (extra = {}) => ({
  DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'http://localhost', ADMIN_PASSWORD: 'clave-de-prueba-123',
  SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'true', WHATSAPP_PROVIDER: 'wecall', WECALL_BASE_URL: 'https://wecall.ejemplo.test/', WECALL_API_KEY: 'api-key-de-prueba', WECALL_WEBHOOK_SECRET: SECRET, ...extra,
});

test('config: sin WHATSAPP_PROVIDER sigue siendo Meta; con wecall hace falta su clave y su dirección', () => {
  const meta = loadConfig(env({ WHATSAPP_PROVIDER: '', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' }));
  assert.equal(meta.whatsappProvider, 'meta');
  assert.equal(whatsappReady(meta), true);
  const we = loadConfig(env());
  assert.equal(we.whatsappProvider, 'wecall');
  assert.equal(we.wecall.baseUrl, 'https://wecall.ejemplo.test'); // sin la barra final
  assert.equal(whatsappReady(we), true);
  assert.equal(whatsappReady(loadConfig(env({ WECALL_API_KEY: '' }))), false);
});

test('firma: solo acepta el HMAC correcto del cuerpo crudo', () => {
  const body = '{"evento":"mensaje_nuevo"}';
  assert.equal(wecall.verifySignature(SECRET, body, sign(body)), true);
  assert.equal(wecall.verifySignature(SECRET, body, sign(body, 'otro')), false);
  assert.equal(wecall.verifySignature(SECRET, body + ' ', sign(body)), false);
  assert.equal(wecall.verifySignature(SECRET, body, ''), false);
  assert.equal(wecall.verifySignature(SECRET, body, sign(body).replace('sha256=', '')), true); // también sin el prefijo
  assert.equal(wecall.verifySignature(SECRET, body, sign(body, 'otro').replace('sha256=', '')), false);
  assert.equal(wecall.verifySignature('', body, sign(body, '')), false); // sin secreto configurado nunca pasa
});

test('toMetaWebhook: mensaje entrante de texto; ignora lo saliente y otros eventos', () => {
  const ev = { evento: 'mensaje_nuevo', contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 7, direccion: 'entrante', texto: ' Hola ' } };
  const m = wecall.toMetaWebhook(ev, '58').entry[0].changes[0].value.messages[0];
  assert.deepEqual(m, { id: 'wecall-7', from: '584145551212', type: 'text', text: { body: 'Hola' } });
  assert.equal(wecall.toMetaWebhook({ ...ev, mensaje: { ...ev.mensaje, direccion: 'saliente' } }, '58'), null);
  assert.equal(wecall.toMetaWebhook({ ...ev, evento: 'estado' }, '58'), null);
  assert.equal(wecall.toMetaWebhook({ ...ev, contacto: {} }, '58'), null);
  const foto = wecall.toMetaWebhook({ ...ev, mensaje: { id: 8, texto: '', tipo: 'image' } }, '58').entry[0].changes[0].value.messages[0];
  assert.deepEqual([foto.type, foto.text], ['image', undefined]);
});

test('toMetaWebhook: acepta otros nombres de evento y de campos, y un aviso sin nombre de evento', () => {
  const base = { contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 1, texto: 'Hola' } };
  for (const evento of ['mensaje_recibido', 'message', 'message.received', undefined]) {
    const r = wecall.toMetaWebhook({ ...base, evento }, '58');
    assert.equal(r.entry[0].changes[0].value.messages[0].text.body, 'Hola', String(evento));
  }
  const en = wecall.toMetaWebhook({ event: 'message_received', contact: { phone: '584145551212' }, message: { message_id: 'abc', text: 'Hi', direction: 'incoming' } }, '58');
  assert.equal(en.entry[0].changes[0].value.messages[0].id, 'wecall-abc');
  assert.equal(wecall.toMetaWebhook({ ...base, evento: 'estado_actualizado' }, '58'), null);
  assert.equal(wecall.toMetaWebhook({ ...base, mensaje: { ...base.mensaje, direction: 'outbound' } }, '58'), null);
});

test('config: la clave y el secreto se recortan (espacios o saltos de línea al pegar)', () => {
  const c = loadConfig(env({ WECALL_API_KEY: '  clave \t', WECALL_WEBHOOK_SECRET: ' sec ' }));
  assert.deepEqual([c.wecall.apiKey, c.wecall.webhookSecret], ['clave', 'sec']);
});

test('envío: texto y plantilla van a la API v1 de WeCall con la clave; 409 y errores se explican', async () => {
  const calls = [];
  const fakeFetch = (status, data) => async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    return { status, ok: status < 300, json: async () => data };
  };
  const cfg = { baseUrl: 'https://wecall.ejemplo.test', apiKey: 'k' };
  const ok = await wecall.createWeCall(cfg, fakeFetch(200, { id: 55 })).sendText('584145551212', 'Hola');
  assert.equal(ok.id, '55');
  assert.deepEqual(calls[0], { url: 'https://wecall.ejemplo.test/api/v1/mensajes/enviar/', auth: 'Bearer k', body: { telefono: '584145551212', texto: 'Hola' } });
  await wecall.createWeCall(cfg, fakeFetch(200, {})).sendTemplate('584145551212', { name: 'recordatorio_evento', bodyParams: ['Ana', 'Culto\nde jóvenes'] });
  assert.deepEqual(calls[1].body, { telefono: '584145551212', plantilla: 'recordatorio_evento', variables: { 1: 'Ana', 2: 'Culto de jóvenes' } });
  await assert.rejects(wecall.createWeCall(cfg, fakeFetch(409, {})).sendText('1', 'x'), /ventana de 24 h/);
  await assert.rejects(wecall.createWeCall(cfg, fakeFetch(502, { error: 'Meta rechazó' })).sendText('1', 'x'), /WeCall 502: Meta rechazó/);
});

test('canales: con WeCall y DRY_RUN apagado, WhatsApp sale por WeCall; con DRY_RUN nada sale', async () => {
  const urls = [];
  const fetchImpl = async (url) => (urls.push(url), { status: 200, ok: true, json: async () => ({ id: 1 }) });
  const real = createChannels(loadConfig(env({ DRY_RUN: 'false' })), { fetchImpl });
  await real.whatsapp.sendText('584145551212', 'Hola');
  assert.deepEqual(urls, ['https://wecall.ejemplo.test/api/v1/mensajes/enviar/']);
  const dry = createChannels(loadConfig(env()), { fetchImpl, logger: { log() {} } });
  assert.equal((await dry.whatsapp.sendText('584145551212', 'Hola')).simulated, true);
  assert.equal(urls.length, 1);
});

test('webhook: firma obligatoria, el mensaje queda registrado una sola vez aunque WeCall lo repita; con Meta la ruta no existe', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const dead = { whatsapp: { available: false }, email: { available: false } };
  const app = createApp({ db: h.db, config: loadConfig(env()), channels: dead });
  const meta = createApp({ db: h.db, config: loadConfig(env({ WHATSAPP_PROVIDER: 'meta' })), channels: dead });
  const s1 = app.listen(0);
  const s2 = meta.listen(0);
  const post = (srv, body, sig) => fetch(`http://127.0.0.1:${srv.address().port}/webhooks/wecall`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-WeCall-Signature': sig } : {}) }, body });
  try {
    const body = JSON.stringify({ evento: 'mensaje_nuevo', contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 99, direccion: 'entrante', texto: 'Hola, ¿a qué hora es el culto?' } });
    assert.equal((await post(s1, body)).status, 401);
    assert.deepEqual((await wecall.recentDeliveries(h.db)).map((a) => [a.result, a.detail]), [['firma_invalida', 'llegó sin firma']]);
    assert.equal((await post(s1, body, sign(body, 'otro'))).status, 401);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM inbound_messages')).rows[0].n, 0);
    assert.equal((await post(s1, body, sign(body))).status, 200);
    assert.equal((await post(s1, body, sign(body))).status, 200); // el mismo aviso repetido
    const rows = (await h.db.query('SELECT from_phone, body FROM inbound_messages')).rows;
    assert.deepEqual(rows, [{ from_phone: '584145551212', body: 'Hola, ¿a qué hora es el culto?' }]);
    const saliente = JSON.stringify({ evento: 'mensaje_nuevo', contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 100, direccion: 'saliente', texto: 'respuesta nuestra' } });
    assert.equal((await post(s1, saliente, sign(saliente))).status, 200);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM inbound_messages')).rows[0].n, 1);
    assert.deepEqual((await wecall.recentDeliveries(h.db)).map((a) => a.result), ['ignorado', 'repetido', 'recibido', 'firma_invalida', 'firma_invalida']);
    assert.ok(!JSON.stringify(await wecall.recentDeliveries(h.db)).includes('5551212')); // el registro no guarda números ni textos
    assert.equal((await post(s2, body, sign(body))).status, 404);
  } finally {
    s1.close();
    s2.close();
    await h.close();
  }
});

test('asistente: cada respuesta por WeCall queda anotada (aceptada o con el error exacto), sin número ni texto', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const agent = require('../src/agent');
  try {
    const config = loadConfig(env({ DRY_RUN: 'false', AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant-prueba' }));
    let reply = { status: 200, ok: true, json: async () => ({ id: 77 }) };
    const channels = createChannels(config, { fetchImpl: async () => reply });
    const ctx = { db: h.db, config, channels };
    await agent.handleInbound(ctx, { from: '584145551212', body: 'Hola', type: 'text' });
    reply = { status: 502, ok: false, json: async () => ({ error: 'Meta rechazó el envío al 584145551212' }) };
    await agent.handleInbound(ctx, { from: '584145551212', body: 'Hola otra vez', type: 'text' });
    const avisos = await wecall.recentDeliveries(h.db);
    assert.deepEqual(avisos.map((a) => [a.result, a.evento]), [['envio_fallido', 'respuesta_asistente'], ['enviado', 'respuesta_asistente']]);
    assert.match(avisos[0].detail, /WeCall 502: Meta rechazó el envío/);
    assert.match(avisos[1].detail, /id 77/);
    assert.ok(!JSON.stringify(avisos).includes('5551212'));
  } finally {
    await h.close();
  }
});

test('respuesta: vuelve al teléfono como lo escribió WeCall (+58…) y ante un 409 se intenta una vez más', async () => {
  const conMas = wecall.toMetaWebhook({ evento: 'mensaje_nuevo', contacto: { telefono: '+584145551212' }, mensaje: { id: 5, texto: 'Hola' } }, '58');
  const m = conMas.entry[0].changes[0].value.messages[0];
  assert.equal(m.from, '584145551212');
  assert.equal(m.reply_to, '+584145551212');
  const local = wecall.toMetaWebhook({ evento: 'mensaje_nuevo', contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 6, texto: 'Hola' } }, '58');
  assert.equal(local.entry[0].changes[0].value.messages[0].reply_to, undefined);

  const calls = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body).telefono);
    n++;
    return n === 1 ? { status: 409, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ id: 9 }) };
  };
  const ch = wecall.createWeCall({ baseUrl: 'https://wecall.ejemplo.test', apiKey: 'k', retryDelayMs: 1 }, fetchImpl);
  assert.equal((await ch.sendText('+584145551212', 'Hola')).id, '9');
  assert.deepEqual(calls, ['+584145551212', '+584145551212']);
  const siempre409 = wecall.createWeCall({ baseUrl: 'https://wecall.ejemplo.test', apiKey: 'k', retryDelayMs: 1 }, async () => ({ status: 409, ok: false, json: async () => ({}) }));
  await assert.rejects(siempre409.sendText('+584145551212', 'Hola'), /ventana de 24 h/);
});

test('configuración: el modelo tiene que empezar con "claude-" (así "haiku-5-5" no se guarda)', () => {
  const settings = require('../src/settings');
  assert.ok(settings.parseModel('haiku-5-5').error);
  assert.equal(settings.parseModel('claude-haiku-5-5').value, 'claude-haiku-5-5');
});
