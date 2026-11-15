'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const { openTestDb } = require('./helpers/db');
const auth = require('../src/auth');
const chat = require('../src/chat-lideres');
const webpush = require('../src/web-push');
const { chatLideresRouter } = require('../src/routes/chat-lideres');
const { chatLideresPanelRouter } = require('../src/routes/chat-lideres-panel');

// Todos los datos de estas pruebas son inventados.
const SECRET = 'secreto-de-prueba';
const config = {
  timezone: 'America/Caracas',
  defaultCountryCode: '58',
  churchName: 'Iglesia de Prueba',
  publicUrl: 'http://prueba.local',
  sessionSecret: SECRET,
  dryRun: false,
  agent: { apiKey: 'clave-de-prueba', model: 'modelo-x', reviewer: false, pastoralPhones: '' },
  whatsapp: { templateLang: 'es' },
};

// El modelo falso: responde siempre lo mismo, con la forma de la API de Anthropic.
const fetchImpl = async (url) => {
  if (String(url).includes('anthropic')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ respuesta: 'Respuesta de Grace de prueba.', escalar: false, motivo: '' }) }],
        stop_reason: 'end_turn',
      }),
    };
  }
  return { ok: true, status: 201, json: async () => ({}) }; // servicio de push falso
};

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  const ctx = { db: h.db, config, channels: {}, fetchImpl };
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(chatLideresRouter(ctx));
  app.use(chatLideresPanelRouter(ctx));
  const server = app.listen(0);
  const b = `http://127.0.0.1:${server.address().port}`;
  const admin = { Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role: 'admin' })}` };
  const get = (p, headers = {}) => fetch(b + p, { redirect: 'manual', headers });
  const postJson = (p, body = {}) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const postForm = (p, fields = {}) =>
    fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...admin }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, ctx, get, postJson, postForm, admin });
  } finally {
    server.close();
    await h.close();
  }
}

const mkPerson = async (db, name, phone) =>
  (await db.query('INSERT INTO people (full_name, phone, opt_in, active) VALUES ($1, $2, TRUE, TRUE) RETURNING id', [name, phone])).rows[0].id;

test('el enlace es personal: se crea, resuelve a su dueño, se apaga y se regenera', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  const db = h.db;
  const pid = await mkPerson(db, 'Ana Líder', '584140000001');
  const link = await chat.ensureLink(db, pid);
  assert.ok(link.token.length >= 20);
  assert.equal((await chat.ensureLink(db, pid)).token, link.token); // no se duplica
  const found = await chat.byToken(db, link.token);
  assert.equal(found.person.id, pid);
  assert.equal(found.person.full_name, 'Ana Líder');
  await chat.setActive(db, pid, false);
  assert.equal(await chat.byToken(db, link.token), null);
  const nuevo = await chat.regenerate(db, pid);
  assert.notEqual(nuevo.token, link.token);
  assert.equal((await chat.byToken(db, nuevo.token)).person.id, pid);
  await h.close();
});

test('la app: página, manifiesto y service worker; enlace malo da la página de enlace no válido', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const pid = await mkPerson(db, 'Ana Líder', '584140000001');
    const link = await chat.ensureLink(db, pid);
    const bad = await get('/chat/no-existe-este-token');
    assert.equal(bad.status, 404);
    assert.match(await bad.text(), /Enlace no válido/);
    const pageRes = await get(`/chat/${link.token}`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, /Chat de líderes/);
    assert.match(html, /manifest\.webmanifest/);
    assert.match(html, /Preguntar a Grace/);
    const man = await (await get(`/chat/${link.token}/manifest.webmanifest`)).json();
    assert.equal(man.start_url, `/chat/${link.token}`);
    assert.equal(man.display, 'standalone');
    const sw = await (await get(`/chat/${link.token}/sw.js`)).text();
    assert.match(sw, /addEventListener\('push'/);
    const icon = await get(`/chat/${link.token}/icono-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
  });
});

test('los líderes conversan entre ellos en la misma sala', async (t) => {
  await withApp(t, async ({ db, get, postJson }) => {
    const a = await mkPerson(db, 'Ana Líder', '584140000001');
    const b = await mkPerson(db, 'Luis Servidor', '584140000002');
    const la = await chat.ensureLink(db, a);
    const lb = await chat.ensureLink(db, b);
    const r = await postJson(`/chat/${la.token}/mensaje`, { texto: 'Hola a todos, ¿cómo están?' });
    assert.equal(r.status, 200);
    const seenByB = await (await get(`/chat/${lb.token}/mensajes?desde=0`)).json();
    assert.equal(seenByB.yo_id, b);
    assert.equal(seenByB.miembros, 2);
    const msg = seenByB.mensajes.find((m) => m.body.includes('Hola a todos'));
    assert.ok(msg);
    assert.equal(msg.author_name, 'Ana Líder');
    assert.equal(msg.person_id, a);
  });
});

test('Grace responde en la sala con límite diario por persona', async (t) => {
  await withApp(t, async ({ db, get, postJson }) => {
    const a = await mkPerson(db, 'Ana Líder', '584140000001');
    const b = await mkPerson(db, 'Luis Servidor', '584140000002');
    const la = await chat.ensureLink(db, a);
    const lb = await chat.ensureLink(db, b);
    await chat.setGraceLimit(db, 2);
    const ask = (token) => postJson(`/chat/${token}/mensaje`, { texto: 'Grace, ¿a qué hora es el servicio?', para_grace: true }).then((x) => x.json());
    const r1 = await ask(la.token);
    assert.equal(r1.mensajes.filter((m) => m.kind === 'grace').length, 1);
    assert.equal(r1.limite.restantes, 1);
    const r2 = await ask(la.token);
    assert.equal(r2.limite.restantes, 0);
    const r3 = await ask(la.token);
    assert.match(r3.aviso, /Ya usaste tus 2 preguntas a Grace de hoy/);
    assert.equal(r3.mensajes.filter((m) => m.kind === 'grace').length, 0);
    const rb = await ask(lb.token); // el límite es por persona: Luis aún puede
    assert.equal(rb.mensajes.filter((m) => m.kind === 'grace').length, 1);
    const all = await (await get(`/chat/${la.token}/mensajes?desde=0`)).json();
    assert.equal(all.mensajes.filter((m) => m.kind === 'grace' && m.pregunta_de === a).length, 2);
  });
});

test('un mensaje de crisis no se publica en la sala: la respuesta llega solo a la persona', async (t) => {
  await withApp(t, async ({ db, get, postJson }) => {
    const a = await mkPerson(db, 'Ana Líder', '584140000001');
    const la = await chat.ensureLink(db, a);
    const r = await (await postJson(`/chat/${la.token}/mensaje`, { texto: 'a veces siento que quiero morir' })).json();
    assert.ok(r.crisis && r.crisis.length > 20);
    const all = await (await get(`/chat/${la.token}/mensajes?desde=0`)).json();
    assert.equal(all.mensajes.length, 0); // nada quedó en la sala
  });
});

test('web push: el cifrado se puede descifrar como lo haría el navegador y el JWT de VAPID verifica', async () => {
  // claves del «navegador» (suscripción)
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const subscription = {
    endpoint: 'https://push.example.com/abc',
    keys: {
      p256dh: ua.getPublicKey(null, 'uncompressed').toString('base64url'),
      auth: authSecret.toString('base64url'),
    },
  };
  const payload = JSON.stringify({ title: 'Chat de líderes', body: 'Ana: hola', url: '/chat/x' });
  const body = webpush.encryptPayload(payload, subscription);
  // descifrado del lado del navegador (RFC 8188/8291 a la inversa)
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdhSecret = ua.computeSecret(asPublic);
  const extract = (s, ikm) => crypto.createHmac('sha256', s).update(ikm).digest();
  const expand = (prk, info, len) =>
    crypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([info, Buffer.from([1])]))
      .digest()
      .subarray(0, len);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ua.getPublicKey(null, 'uncompressed'), asPublic]);
  const ikm = expand(extract(authSecret, ecdhSecret), keyInfo, 32);
  const prk = extract(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(plain.subarray(0, plain.length - 1).toString('utf8'), payload);
  assert.equal(plain[plain.length - 1], 0x02);

  // VAPID: el JWT firma con la privada y verifica con la pública
  const keys = webpush.generateVapidKeys();
  const jwt = webpush.vapidJwt('https://push.example.com/abc', keys, 'https://crm.example.com');
  const [h64, c64, s64] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c64, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://push.example.com');
  const point = webpush.fromB64u(keys.publicKey);
  const pubKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: webpush.b64u(point.subarray(1, 33)), y: webpush.b64u(point.subarray(33, 65)) },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h64}.${c64}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, webpush.fromB64u(s64)));
});

test('avisos de la app: se avisa a los demás, con pausa de 15 minutos, y al dueño de la pregunta siempre', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  const db = h.db;
  const a = await mkPerson(db, 'Ana Líder', '584140000001');
  const b = await mkPerson(db, 'Luis Servidor', '584140000002');
  await chat.ensureLink(db, a);
  await chat.ensureLink(db, b);
  const pushes = [];
  const ctx = {
    db,
    config,
    fetchImpl: async (url) => {
      pushes.push(url);
      return { status: 201 };
    },
  };
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  await chat.saveSubscription(db, b, {
    endpoint: 'https://push.example.com/luis',
    keys: { p256dh: ua.getPublicKey(null, 'uncompressed').toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  });
  // el fetch es falso (nadie sale a internet); lo que se verifica es a quién se avisa y la pausa
  const n1 = await chat.notifyRoom(ctx, { exceptPersonId: a, title: 'Chat de líderes', bodyText: 'Ana: hola' });
  assert.equal(n1, 1);
  assert.equal(pushes.length, 1);
  const n2 = await chat.notifyRoom(ctx, { exceptPersonId: a, title: 'Chat de líderes', bodyText: 'Ana: otra cosa' });
  assert.equal(n2, 0); // pausa de 15 minutos
  const n3 = await chat.notifyRoom(ctx, { urgentFor: b, title: 'Grace respondió tu pregunta', bodyText: '…' });
  assert.equal(n3, 1); // urgente: sin pausa
  await h.close();
});

test('el panel: la ficha da el acceso personal y la sala se administra (límite de Grace)', async (t) => {
  await withApp(t, async ({ db, get, postForm, admin }) => {
    const a = await mkPerson(db, 'Ana Líder', '584140000001');
    const r = await get(`/personas/${a}/chat`, admin);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Su acceso al chat de líderes/);
    const link = await chat.getLink(db, a);
    assert.ok(html.includes(`/chat/${link.token}`));
    const sala = await get('/chat-lideres', admin);
    assert.equal(sala.status, 200);
    const salaHtml = await sala.text();
    assert.match(salaHtml, /Ana Líder/);
    const upd = await postForm('/chat-lideres/limite', { limite: '3' });
    assert.equal(upd.status, 303);
    assert.equal(await chat.getGraceLimit(db), 3);
  });
});
