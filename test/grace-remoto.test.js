'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createChannels } = require('../src/channels');
const auth = require('../src/auth');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const SECRET = 's'.repeat(48);
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSONH = { 'Content-Type': 'application/json' };

async function setup(t, { modelText = 'Fueron 570 personas.', key = 'sk-ant-inventada-0001' } = {}) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const config = loadConfig({
    DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'https://crm.ejemplo.test', ADMIN_PASSWORD: 'clave-de-prueba-123',
    SESSION_SECRET: SECRET, DRY_RUN: 'true', ANTHROPIC_API_KEY: key,
  });
  const asks = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    asks.push(body);
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ respuesta: modelText, escalar: false, motivo: '' }) }] }) };
  };
  const ctx = { db: h.db, config, channels: createChannels(config, { logger: { log() {} } }), fetchImpl };
  const server = createApp(ctx).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
  const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const coord = { Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role: 'coordinador', pid: 7 })}` };
  const get = (p, headers = admin) => fetch(base + p, { headers, redirect: 'manual' });
  const post = (p, body, headers = admin) => fetch(base + p, { method: 'POST', headers: { ...JSONH, ...headers }, body: JSON.stringify(body || {}), redirect: 'manual' });
  return { ...h, config, asks, base, admin, coord, get, post, close: async () => { server.close(); await h.close(); } };
}

test('control remoto: la pantalla de chat carga, Grace responde en modo pastoral y la conversación queda guardada', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const page = await (await s.get('/grace')).text();
    assert.match(page, /Hola, soy Grace/);
    assert.match(page, /Cuántos vinieron el último servicio/);
    const r = await s.post('/grace/mensaje', { texto: '¿Cuántos vinieron el domingo?' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { respuesta: 'Fueron 570 personas.', escalar: false });
    assert.match(s.asks[0].system, /MODO PASTORAL/);
    assert.ok(s.asks[0].tools.some((x) => x.name === 'asistencia_servicios'));
    const hist = await (await s.get('/grace/historial')).json();
    assert.deepEqual(hist.mensajes.map((m) => [m.de, m.texto]), [['yo', '¿Cuántos vinieron el domingo?'], ['grace', 'Fueron 570 personas.']]);
    assert.equal((await s.post('/grace/mensaje', { texto: '   ' })).status, 400);
    assert.equal((await s.post('/grace/limpiar')).status, 200);
    assert.equal((await (await s.get('/grace/historial')).json()).mensajes.length, 0);
  } finally {
    await s.close();
  }
});

test('control remoto: solo administración, sin sesión no entra, y no acepta envíos desde otro sitio', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    assert.equal((await s.get('/grace', {})).status, 303);
    assert.equal((await s.post('/grace/mensaje', { texto: 'hola' }, {})).status, 401);
    assert.equal((await s.get('/grace', s.coord)).status, 403);
    assert.equal((await s.post('/grace/mensaje', { texto: 'hola' }, s.coord)).status, 403);
    assert.equal((await s.post('/grace/mensaje', { texto: 'hola' }, { ...s.admin, Origin: 'https://otro-sitio.example' })).status, 403);
    assert.equal(s.asks.length, 0);
  } finally {
    await s.close();
  }
});

test('control remoto: el avatar se cambia (solo PNG/JPG/WebP de verdad y livianos) y se puede volver al original', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    let a = await s.get('/grace/avatar');
    assert.match(a.headers.get('content-type'), /svg/);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
    assert.equal((await s.post('/grace/avatar', { imagen: `data:image/png;base64,${png.toString('base64')}` })).status, 200);
    a = await s.get('/grace/avatar');
    assert.equal(a.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await a.arrayBuffer()).length, png.length);
    assert.equal((await s.post('/grace/avatar', { imagen: `data:image/png;base64,${Buffer.from('<script>no</script>').toString('base64')}` })).status, 400);
    assert.equal((await s.post('/grace/avatar', { imagen: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
    assert.equal((await s.post('/grace/avatar', { imagen: `data:image/png;base64,${Buffer.alloc(410 * 1024, 0x89).toString('base64')}` })).status, 400);
    assert.equal((await s.post('/grace/avatar/borrar')).status, 200);
    assert.match((await s.get('/grace/avatar')).headers.get('content-type'), /svg/);
  } finally {
    await s.close();
  }
});

test('control remoto: sin clave del modelo lo dice, sin llamar a nadie', async (t) => {
  const s = await setup(t, { key: '' });
  if (!s) return;
  try {
    const r = await s.post('/grace/mensaje', { texto: 'hola' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /clave del modelo/);
    assert.equal((await (await s.get('/grace/historial')).json()).listo, false);
  } finally {
    await s.close();
  }
});
