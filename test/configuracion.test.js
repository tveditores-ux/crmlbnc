'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createChannels } = require('../src/channels');
const auth = require('../src/auth');
const settings = require('../src/settings');
const { openTestDb } = require('./helpers/db');

// Todas las claves de estas pruebas son inventadas.
const SECRET = 's'.repeat(48);
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const KEY = 'clave-inventada-de-wecall-123';
const WH = 'secreto-inventado-del-webhook-456';
const env = (extra = {}) => ({ DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'https://crm.ejemplo.test', ADMIN_PASSWORD: 'clave-de-prueba-123', SESSION_SECRET: SECRET, DRY_RUN: 'false', ...extra });

test('cifrado: ida y vuelta; otra SESSION_SECRET, un dato alterado o texto sin cifrar no se leen', () => {
  const c = settings.encrypt(KEY, SECRET);
  assert.ok(c.startsWith('enc1:') && !c.includes(KEY));
  assert.equal(settings.decrypt(c, SECRET), KEY);
  assert.notEqual(settings.encrypt(KEY, SECRET), c); // cada cifrado es distinto
  assert.equal(settings.decrypt(c, 'otra'.repeat(12)), null);
  assert.equal(settings.decrypt(c.slice(0, -3) + 'AAA', SECRET), null);
  assert.equal(settings.decrypt(KEY, SECRET), null);
  assert.equal(settings.decrypt('', SECRET), null);
});

test('validación: la dirección debe ser https y pública; las claves no llevan espacios', () => {
  assert.deepEqual(settings.parseBaseUrl(' https://wecall.ejemplo.com/ '), { value: 'https://wecall.ejemplo.com' });
  assert.deepEqual(settings.parseBaseUrl('https://wecall.ejemplo.com/api/'), { value: 'https://wecall.ejemplo.com/api' });
  assert.deepEqual(settings.parseBaseUrl(''), { value: '' });
  for (const bad of ['http://wecall.ejemplo.com', 'wecall.ejemplo.com', 'https://localhost:3000', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.2', 'https://172.20.0.1', 'https://169.254.169.254', 'https://db.railway.internal', 'https://[::1]', 'https://user:pass@wecall.ejemplo.com']) {
    assert.ok(settings.parseBaseUrl(bad).error, bad);
  }
  assert.equal(settings.parseSecret('  abc123  ', 'X').value, 'abc123');
  assert.ok(settings.parseSecret('abc 123', 'X').error);
  assert.ok(settings.parseSecret('abc\n123', 'X').error);
  assert.ok(settings.parseSecret('a'.repeat(301), 'X').error);
  assert.equal(settings.parseSecret('', 'X').value, '');
});

async function setup(t, envExtra = {}) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const config = loadConfig(env(envExtra));
  const calls = [];
  let nextStatus = 404;
  const fetchImpl = async (url, opts) => {
    if (nextStatus === 'boom') throw new Error('sin red');
    calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization, method: (opts && opts.method) || 'GET', body: opts && opts.body });
    return { status: nextStatus, ok: nextStatus < 300, json: async () => ({ id: 1 }) };
  };
  const ctx = { db: h.db, config, channels: createChannels(config, { fetchImpl }), fetchImpl };
  const app = createApp(ctx);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
  const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const get = (p, headers = admin) => fetch(base + p, { headers, redirect: 'manual' });
  const post = (p, f, headers = admin) => fetch(base + p, { method: 'POST', headers: { ...FORM, ...headers }, body: new URLSearchParams(f), redirect: 'manual' });
  const flash = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  return { ...h, ctx, config, calls, setStatus: (s) => (nextStatus = s), base, admin, get, post, flash, close: async () => { server.close(); await h.close(); } };
}

test('guardar: se aplica al instante (canal, firma del webhook), se guarda cifrado y la pantalla nunca muestra las claves', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    assert.equal(s.config.whatsappProvider, 'meta');
    const inicial = await (await s.get('/configuracion')).text();
    assert.match(inicial, /Usando Meta directo/);
    assert.ok(inicial.includes(`${'https://crm.ejemplo.test'}/webhooks/wecall`));

    const r = await s.post('/configuracion/wecall', { provider: 'wecall', base_url: 'https://wecall.ejemplo.com/', api_key: ` ${KEY} `, webhook_secret: WH });
    assert.equal(r.status, 303);
    assert.match(s.flash(r), /Configuración guardada y aplicada\.$/);

    // en la base: la dirección en claro, las claves cifradas (nunca en claro)
    const rows = Object.fromEntries((await s.db.query('SELECT key, value, secret FROM app_settings')).rows.map((x) => [x.key, x]));
    assert.equal(rows.wecallBaseUrl.value, 'https://wecall.ejemplo.com');
    assert.ok(rows.wecallApiKey.secret && rows.wecallApiKey.value.startsWith('enc1:') && !rows.wecallApiKey.value.includes(KEY));
    assert.ok(!JSON.stringify(rows).includes(KEY) && !JSON.stringify(rows).includes(WH));

    // aplicado sin reiniciar: la config cambió y el canal ahora envía por WeCall con la clave nueva
    assert.deepEqual([s.config.whatsappProvider, s.config.wecall.apiKey, s.config.wecall.webhookSecret], ['wecall', KEY, WH]);
    s.setStatus(200);
    await s.ctx.channels.whatsapp.sendText('584145551212', 'Hola');
    assert.deepEqual(s.calls.at(-1), { url: 'https://wecall.ejemplo.com/api/v1/mensajes/enviar/', auth: `Bearer ${KEY}`, method: 'POST', body: JSON.stringify({ telefono: '584145551212', texto: 'Hola' }) });

    // y el webhook ya valida con el secreto nuevo (antes el CRM respondía 404)
    const body = JSON.stringify({ evento: 'mensaje_nuevo', contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 7, direccion: 'entrante', texto: 'Hola' } });
    const sign = (sec) => 'sha256=' + crypto.createHmac('sha256', sec).update(body).digest('hex');
    const hook = (sig) => fetch(`${s.base}/webhooks/wecall`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WeCall-Signature': sig }, body });
    assert.equal((await hook(sign('otro'))).status, 401);
    assert.equal((await hook(sign(WH))).status, 200);

    // la pantalla: dice de dónde sale cada cosa y NO contiene ninguna clave
    const page = await (await s.get('/configuracion')).text();
    assert.match(page, /El CRM envía y recibe por WeCall/);
    assert.ok((page.match(/Guardada en el panel/g) || []).length >= 3);
    assert.ok(!page.includes(KEY) && !page.includes(WH));
    assert.ok(page.includes('value="https://wecall.ejemplo.com"'));
    assert.ok(!/<input[^>]*type="password"[^>]*value=/.test(page));
    assert.ok(!(await (await s.get('/pruebas')).text()).includes(KEY));
  } finally {
    await s.close();
  }
});

test('vacío conserva; "borrar" quita lo del panel y vuelve a lo de Railway; sin nada, falta', async (t) => {
  const s = await setup(t, { WECALL_API_KEY: 'clave-de-railway-999', WECALL_BASE_URL: 'https://railway.ejemplo.com' });
  if (!s) return;
  try {
    assert.match(await (await s.get('/configuracion')).text(), /Tomada de Railway/);
    await s.post('/configuracion/wecall', { provider: 'wecall', base_url: '', api_key: KEY, webhook_secret: '' });
    assert.equal(s.config.wecall.apiKey, KEY); // el panel manda sobre Railway
    assert.equal(s.config.wecall.baseUrl, 'https://railway.ejemplo.com'); // lo no escrito sigue como estaba
    // guardar de nuevo con los campos vacíos no borra nada
    await s.post('/configuracion/wecall', { provider: 'wecall', base_url: '', api_key: '', webhook_secret: '' });
    assert.equal(s.config.wecall.apiKey, KEY);
    // borrar lo del panel devuelve a Railway
    const r = await s.post('/configuracion/wecall', { provider: 'wecall', api_key: '', clear_api_key: '1' });
    assert.equal(r.status, 303);
    assert.equal(s.config.wecall.apiKey, 'clave-de-railway-999');
    assert.equal((await s.db.query("SELECT count(*)::int AS n FROM app_settings WHERE key = 'wecallApiKey'")).rows[0].n, 0);
    const page = await (await s.get('/configuracion')).text();
    assert.match(page, /Falta: Webhook secret de WeCall/);
    assert.ok(!page.includes('clave-de-railway-999'));
  } finally {
    await s.close();
  }
});

test('errores: dirección http o interna, clave con espacios o proveedor inválido no guardan NADA', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const casos = [
      { provider: 'wecall', base_url: 'http://wecall.ejemplo.com', api_key: KEY },
      { provider: 'wecall', base_url: 'https://127.0.0.1', api_key: KEY },
      { provider: 'wecall', base_url: 'https://wecall.ejemplo.com', api_key: 'dos palabras' },
      { provider: 'otro', api_key: KEY },
    ];
    for (const c of casos) {
      const r = await s.post('/configuracion/wecall', c);
      assert.equal(r.status, 303);
      assert.ok(new URL(r.headers.get('location'), s.base).searchParams.get('err'), JSON.stringify(c));
    }
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM app_settings')).rows[0].n, 0);
    assert.equal(s.config.whatsappProvider, 'meta');
  } finally {
    await s.close();
  }
});

test('probar: 404 o 200 = la clave sirve; 401 = rechazada; sin red = aviso; sin datos = pide los datos; nunca envía mensajes', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    assert.match(s.flash(await s.post('/configuracion/wecall/probar', {})), /Faltan la dirección/);
    await s.post('/configuracion/wecall', { provider: 'wecall', base_url: 'https://wecall.ejemplo.com', api_key: KEY, webhook_secret: WH });
    s.calls.length = 0;
    s.setStatus(404);
    assert.match(s.flash(await s.post('/configuracion/wecall/probar', {})), /Conexión correcta/);
    assert.deepEqual(s.calls.map((c) => [c.method, c.url, c.auth]), [['GET', 'https://wecall.ejemplo.com/api/v1/contactos/584000000000/contexto/', `Bearer ${KEY}`]]);
    s.setStatus(401);
    assert.match(s.flash(await s.post('/configuracion/wecall/probar', {})), /rechazó la API key/);
    s.setStatus(500);
    assert.match(s.flash(await s.post('/configuracion/wecall/probar', {})), /respondió 500/);
    s.setStatus('boom');
    assert.match(s.flash(await s.post('/configuracion/wecall/probar', {})), /No se pudo llegar a WeCall/);
    assert.ok(s.calls.every((c) => c.method === 'GET'));
  } finally {
    await s.close();
  }
});

test('acceso: sin sesión no; coordinador no; admin sí; formulario desde otro sitio no', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    assert.equal((await s.get('/configuracion', {})).status, 303); // sin sesión: al login
    assert.equal((await fetch(`${s.base}/configuracion/wecall`, { method: 'POST', headers: FORM, body: 'api_key=x' })).status, 401);
    const cookie = (role) => ({ Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role, pid: 1 })}` });
    const coord = await s.get('/configuracion', cookie('coordinador'));
    assert.equal(coord.status, 403);
    assert.match(await coord.text(), /Solo administración/);
    assert.equal((await s.post('/configuracion/wecall', { api_key: KEY }, cookie('coordinador'))).status, 403);
    assert.equal((await s.get('/configuracion', cookie('admin'))).status, 200);
    assert.equal((await s.post('/configuracion/wecall', { api_key: KEY }, { ...s.admin, Origin: 'https://sitio-malo.example' })).status, 403);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM app_settings')).rows[0].n, 0);
    assert.equal((await s.post('/configuracion/wecall', { provider: 'meta' }, { ...s.admin, Origin: s.base })).status, 303); // desde esta misma página sí
  } finally {
    await s.close();
  }
});

test('al arrancar se aplica lo guardado; si cambió la SESSION_SECRET queda "ilegible" y se usa lo de Railway', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    await s.post('/configuracion/wecall', { provider: 'wecall', base_url: 'https://wecall.ejemplo.com', api_key: KEY, webhook_secret: WH });
    // "reinicio": configuración nueva solo con variables de Railway, y la base con lo guardado
    const config2 = loadConfig(env({ WECALL_API_KEY: 'de-railway-abc' }));
    const ctx2 = { db: s.db, config: config2, channels: createChannels(config2) };
    assert.equal(config2.wecall.apiKey, 'de-railway-abc');
    await settings.apply(ctx2);
    assert.deepEqual([config2.whatsappProvider, config2.wecall.apiKey, config2.wecall.webhookSecret, ctx2.channels.whatsapp.available], ['wecall', KEY, WH, true]);
    // otra SESSION_SECRET: no se puede descifrar; no se rompe, cae a Railway y lo dice
    const config3 = loadConfig(env({ SESSION_SECRET: 'x'.repeat(48), WECALL_API_KEY: 'de-railway-abc' }));
    const ctx3 = { db: s.db, config: config3, channels: createChannels(config3) };
    const stored = await settings.apply(ctx3);
    assert.equal(config3.wecall.apiKey, 'de-railway-abc');
    assert.equal(settings.sourceOf('wecallApiKey', stored, config3), 'ilegible');
    assert.equal(settings.sourceOf('wecallBaseUrl', stored, config3), 'panel'); // la dirección no va cifrada
  } finally {
    await s.close();
  }
});

const KEY2 = 'sk-ant-clave-inventada-0001';

test('validación del asistente: modelo y límite diario', () => {
  assert.equal(settings.parseModel(' claude-sonnet-5-5 ').value, 'claude-sonnet-5-5');
  assert.equal(settings.parseModel('').value, '');
  for (const bad of ['a b', 'x', 'modelo/raro', '../etc', 'a'.repeat(81)]) assert.ok(settings.parseModel(bad).error, bad);
  assert.equal(settings.parseMaxReplies(' 12 ').value, '12');
  assert.equal(settings.parseMaxReplies('').value, '');
  for (const bad of ['0', '101', '-3', '2.5', 'doce', '1000']) assert.ok(settings.parseMaxReplies(bad).error, bad);
});

test('asistente: se guarda cifrado, se aplica al instante y la pantalla nunca muestra la clave', async (t) => {
  const s = await setup(t, { DRY_RUN: 'true' });
  if (!s) return;
  try {
    assert.equal(s.config.agent.enabled, false);
    const antes = await (await s.get('/configuracion')).text();
    assert.match(antes, /No responde todavía/);
    assert.match(antes, /está apagado/);

    const r = await s.post('/configuracion/agente', { enabled: 'si', api_key: ` ${KEY2} `, model: 'claude-sonnet-5-5', max_replies: '8' });
    assert.equal(r.status, 303);
    assert.match(s.flash(r), /Asistente guardado y aplicado\.$/);
    assert.deepEqual([s.config.agent.enabled, s.config.agent.apiKey, s.config.agent.model, s.config.agent.maxRepliesPerDay], [true, KEY2, 'claude-sonnet-5-5', 8]);

    const rows = (await s.db.query("SELECT key, value FROM app_settings WHERE key IN ('anthropicApiKey','agentEnabled','agentMaxReplies')")).rows;
    const key = rows.find((x) => x.key === 'anthropicApiKey').value;
    assert.ok(key.startsWith('enc1:') && !key.includes(KEY2));
    assert.ok(!JSON.stringify(rows).includes(KEY2));

    // con DRY_RUN activo el bot queda "listo pero sin enviar"; nada de esto cambia DRY_RUN
    await s.post('/configuracion/wecall', { provider: 'wecall', base_url: 'https://wecall.ejemplo.com', api_key: KEY, webhook_secret: WH });
    const page = await (await s.get('/configuracion')).text();
    assert.match(page, /Listo, pero en modo prueba \(DRY_RUN\): no envía nada/);
    assert.equal(s.config.dryRun, true);
    assert.ok(!page.includes(KEY2));
    assert.ok(!(await (await s.get('/asistente')).text()).includes(KEY2));

    // apagar y borrar la clave del panel
    await s.post('/configuracion/agente', { enabled: 'no', clear_api_key: '1' });
    assert.deepEqual([s.config.agent.enabled, s.config.agent.apiKey], [false, '']);
  } finally {
    await s.close();
  }
});

test('asistente: el bot responde de verdad solo con todo conectado, y contesta por WeCall al mensaje entrante', async (t) => {
  const s = await setup(t); // DRY_RUN=false
  if (!s) return;
  try {
    const modelCalls = [];
    s.ctx.fetchImpl = async (url, opts) => {
      if (String(url).startsWith('https://api.anthropic.com')) {
        modelCalls.push(url);
        return { status: 200, ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ respuesta: 'Hola, el culto es el domingo.', escalar: false, motivo: '' }) }] }) };
      }
      s.calls.push({ url, auth: opts.headers.Authorization, body: opts.body });
      return { status: 200, ok: true, json: async () => ({ id: 9 }) };
    };
    await s.post('/configuracion/wecall', { provider: 'wecall', base_url: 'https://wecall.ejemplo.com', api_key: KEY, webhook_secret: WH });
    await s.post('/configuracion/agente', { enabled: 'si', api_key: KEY2 });
    assert.match(await (await s.get('/configuracion')).text(), /El asistente responde por WhatsApp/);
    // una persona registrada escribe por WeCall
    await s.db.query("INSERT INTO people (full_name, phone, active) VALUES ('Ana Pérez', '584145551212', TRUE)");
    s.calls.length = 0;
    const body = JSON.stringify({ evento: 'mensaje_nuevo', contacto: { telefono: '0414-555.12.12' }, mensaje: { id: 21, direccion: 'entrante', texto: 'Hola, ¿a qué hora es el culto del domingo?' } });
    const sig = 'sha256=' + crypto.createHmac('sha256', WH).update(body).digest('hex');
    const hook = await fetch(`${s.base}/webhooks/wecall`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WeCall-Signature': sig }, body });
    assert.equal(hook.status, 200);
    assert.equal(modelCalls.length, 1);
    const sent = s.calls.filter((c) => c.url === 'https://wecall.ejemplo.com/api/v1/mensajes/enviar/');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auth, `Bearer ${KEY}`);
    assert.equal(JSON.parse(sent[0].body).telefono, '584145551212');
    assert.match(JSON.parse(sent[0].body).texto, /culto/);
  } finally {
    await s.close();
  }
});

test('asistente: errores no guardan nada; probar la clave del modelo es de solo lectura; solo administración', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    for (const c of [{ enabled: 'quizás' }, { api_key: 'dos palabras' }, { model: 'modelo raro' }, { max_replies: '500' }]) {
      const r = await s.post('/configuracion/agente', c);
      assert.ok(new URL(r.headers.get('location'), s.base).searchParams.get('err'), JSON.stringify(c));
    }
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM app_settings')).rows[0].n, 0);

    assert.match(s.flash(await s.post('/configuracion/agente/probar', {})), /Falta la clave del modelo/);
    await s.post('/configuracion/agente', { api_key: KEY2 });
    const seen = [];
    s.ctx.fetchImpl = async (url, opts) => ((seen.push([url, (opts && opts.method) || 'GET']), { status: seen.length === 1 ? 200 : 401, ok: seen.length === 1 }));
    assert.match(s.flash(await s.post('/configuracion/agente/probar', {})), /Conexión correcta/);
    assert.match(s.flash(await s.post('/configuracion/agente/probar', {})), /rechazó la clave/);
    assert.deepEqual(seen[0], ['https://api.anthropic.com/v1/models?limit=1', 'GET']);

    const coord = { Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role: 'coordinador', pid: 1 })}` };
    assert.equal((await s.post('/configuracion/agente', { enabled: 'si' }, coord)).status, 403);
    assert.equal((await fetch(`${s.base}/configuracion/agente`, { method: 'POST', headers: FORM, body: 'enabled=si' })).status, 401);
  } finally {
    await s.close();
  }
});
