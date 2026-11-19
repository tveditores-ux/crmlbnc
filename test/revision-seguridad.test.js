'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const auth = require('../src/auth');

const env = (extra = {}) => ({
  DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'http://localhost', ADMIN_PASSWORD: 'clave-de-prueba-123',
  SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'true', ...extra,
});
const dead = { whatsapp: { available: false }, email: { available: false } };
const noDb = { query: async () => ({ rows: [] }) };

async function postMeta(config) {
  const srv = createApp({ db: noDb, config, channels: dead }).listen(0);
  try {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '584140000000', type: 'text', text: { body: 'BAJA' } }] } }] }] });
    return (await fetch(`http://127.0.0.1:${srv.address().port}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status;
  } finally {
    srv.close();
  }
}

test('webhook de Meta: con WeCall la ruta no existe y sin el secreto de Meta no se acepta un mensaje inventado', async () => {
  assert.equal(await postMeta(loadConfig(env({ WHATSAPP_PROVIDER: 'wecall', WECALL_BASE_URL: 'https://wecall.ejemplo.test', WECALL_API_KEY: 'k', WECALL_WEBHOOK_SECRET: 'x' }))), 404);
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(await postMeta(loadConfig(env({ WHATSAPP_PROVIDER: 'meta' }))), 401);
  } finally {
    console.error = log;
  }
  assert.equal(await postMeta(loadConfig(env({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_APP_SECRET: 'secreto' }))), 401); // sin firma
});

test('cookies: una cookie mal escrita no tumba la página', () => {
  assert.deepEqual(auth.parseCookies('sesion=%; otra=a%20b'), { sesion: '%', otra: 'a b' });
  assert.equal(auth.verifySession(auth.parseCookies('sesion=%E0%A4%A').sesion, 's'.repeat(48)), false);
});
