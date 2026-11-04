'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const letters = require('../src/nuevavida/letters');
const { nuevaVidaRouter } = require('../src/routes/nueva-vida');
const { cartasRouter } = require('../src/routes/cartas');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };

test('números a mano: uno por línea o separados, con nombre opcional, sin repetidos y avisando los que no sirven', () => {
  const r = letters.parseNumbers('0414-000.00.01\nAna 0424-000.00.02, 58 414 0000003; basura; 0414-000.00.01\n+58 (414) 000-00-04 - Luis\n12');
  assert.deepEqual(r.recipients, [
    { phone: '584140000001', name: '' },
    { phone: '584240000002', name: 'Ana' },
    { phone: '584140000003', name: '' },
    { phone: '584140000004', name: 'Luis' },
  ]);
  assert.deepEqual(r.invalid, ['basura', '12']);
  assert.deepEqual(letters.parseNumbers('', '58'), { recipients: [], invalid: [] });
});

test('mensaje: saluda por el primer nombre, sin nombre queda "Hola,", y siempre lleva el enlace de la carta', () => {
  const url = 'http://prueba.local/cartas/bienvenida-dama.pdf';
  const tpl = letters.defaultTemplate('Iglesia de Prueba');
  assert.match(letters.buildMessage(tpl, 'María José Pérez', url), /^Hola María, la paz del Señor\./);
  assert.match(letters.buildMessage(tpl, '', url), /^Hola, la paz del Señor\./);
  assert.ok(letters.buildMessage(tpl, 'Ana', url).includes(url));
  assert.ok(letters.buildMessage('Te escribimos de la iglesia', 'Ana', url).endsWith(url)); // sin {enlace}, se agrega
  assert.equal(letters.buildMessage('{nombre}, mira {enlace}', 'Ana', url), `Ana, mira ${url}`);
  assert.equal(letters.waLink('584140000001', 'Hola ñandú & más'), 'https://wa.me/584140000001?text=Hola%20%C3%B1and%C3%BA%20%26%20m%C3%A1s');
});

test('la carta (PDF) se lee sin sesión; solo se sirven los archivos de la lista', async (t) => {
  const app = express();
  app.use(cartasRouter());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/cartas/bienvenida-dama.pdf`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /^inline/);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'cartas', 'bienvenida-dama.pdf')));
    for (const bad of ['otra.pdf', '..%2Fapp.js', '..%2F..%2Fpackage.json', 'bienvenida-dama.pdf%00.txt', '']) {
      assert.equal((await fetch(`${base}/cartas/${bad}`)).status, 404, bad);
    }
  } finally {
    server.close();
  }
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(nuevaVidaRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
    return fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  };
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

const addNv = async (db, name, phone) => (await db.query('INSERT INTO nueva_vida (full_name, phone, decision_date) VALUES ($1, $2, current_date) RETURNING id', [name, phone])).rows[0].id;

test('la pestaña Nueva Vida muestra la carta con su enlace y el botón para enviarla por WhatsApp', async (t) => {
  await withApp(t, async ({ get }) => {
    const html = await (await get('/nueva-vida')).text();
    assert.match(html, /Carta de bienvenida/);
    assert.match(html, /href="\/cartas\/bienvenida-dama\.pdf"/);
    assert.match(html, /href="\/nueva-vida\/carta"/);
    assert.match(html, /Enviar por WhatsApp/);
  });
});

test('elegir a quién enviar: lista solo a quienes tienen teléfono y permite buscar', async (t) => {
  await withApp(t, async ({ db, get }) => {
    await addNv(db, 'Con Teléfono Uno', '584140000001');
    await db.query("INSERT INTO nueva_vida (full_name) VALUES ('Sin Teléfono')");
    const html = await (await get('/nueva-vida/carta')).text();
    assert.match(html, /Con Teléfono Uno/);
    assert.ok(!html.includes('Sin Teléfono'));
    assert.match(html, /name="numeros"/);
    assert.match(html, /\{nombre\}/);
    assert.match(html, /Iglesia de Prueba/); // el mensaje usa el nombre de la iglesia
    assert.match(html, /id="find"/);
    const pre = await (await get('/nueva-vida/carta?id=' + (await db.query("SELECT id FROM nueva_vida WHERE phone = '584140000001'")).rows[0].id)).text();
    assert.match(pre, /value="\d+" checked/); // viene marcada la persona que se pidió
  });
});

test('preparar el envío: enlace de WhatsApp por número con el mensaje y la carta; junta lista y números sin repetir', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const id = await addNv(db, 'Beatriz Gómez', '584140000001');
    const r = await post('/nueva-vida/carta', {
      carta: 'dama', mensaje: letters.defaultTemplate('Iglesia de Prueba'),
      numeros: '0414-000.00.01\nCarla 0424-000.00.02\nno-es-un-numero', ids: [String(id)],
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    const links = [...html.matchAll(/href="(https:\/\/wa\.me\/(\d+)\?text=([^"]+))"/g)];
    assert.deepEqual(links.map((m) => m[2]), ['584140000001', '584240000002']); // el repetido se junta; gana el nombre de la lista
    const msg1 = decodeURIComponent(links[0][3].replaceAll('&amp;', '&'));
    assert.match(msg1, /^Hola Beatriz, la paz del Señor/);
    assert.ok(msg1.includes('http://prueba.local/cartas/bienvenida-dama.pdf'));
    assert.match(decodeURIComponent(links[1][3]), /^Hola Carla,/);
    assert.match(html, /no-es-un-numero/); // se avisa lo que no se reconoció
    assert.match(html, /2 personas/);
    // preparar no registra nada ni toca otras tablas
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida_cartas')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n, 0); // ningún envío del sistema

    const none = await post('/nueva-vida/carta', { carta: 'dama', numeros: 'solo texto' });
    assert.match(loc(none), /No reconocí ningún número: solo texto/);
    assert.match(loc(await post('/nueva-vida/carta', { carta: 'dama' })), /al menos un número/);
    assert.match(loc(await post('/nueva-vida/carta', { carta: 'inventada', numeros: '0414-000.00.01' })), /Elige una carta/);
  });
});

test('marcar como enviada: queda registrado, la lista lo muestra y al preparar de nuevo avisa que ya se envió', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const id = await addNv(db, 'Beatriz Gómez', '584140000001');
    assert.equal((await post('/nueva-vida/carta/enviada', { phone: '584140000001', name: 'Beatriz Gómez', nv: String(id), carta: 'dama' })).status, 204);
    const row = (await db.query('SELECT * FROM nueva_vida_cartas')).rows[0];
    assert.deepEqual([row.phone, row.name, row.nueva_vida_id, row.letter], ['584140000001', 'Beatriz Gómez', id, 'dama']);

    assert.match(await (await get('/nueva-vida/carta')).text(), /Enviada \d{2}\/\d{2}\/\d{4}/);
    const again = await (await post('/nueva-vida/carta', { carta: 'dama', ids: [String(id)] })).text();
    assert.match(again, /Ya se le envió antes/);

    // datos malos no se registran
    assert.equal((await post('/nueva-vida/carta/enviada', { phone: 'abc', carta: 'dama' })).status, 400);
    assert.equal((await post('/nueva-vida/carta/enviada', { phone: '584140000001', carta: 'inventada' })).status, 400);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida_cartas')).rows[0].n, 1);
    // un número suelto (sin ficha) también se registra, y un id inexistente no rompe nada
    assert.equal((await post('/nueva-vida/carta/enviada', { phone: '584240000009', nv: '99999', carta: 'dama' })).status, 204);
    assert.equal((await db.query('SELECT nueva_vida_id FROM nueva_vida_cartas WHERE phone = $1', ['584240000009'])).rows[0].nueva_vida_id, null);
  });
});

test('el nombre del mensaje se escapa en la página (no se ejecuta HTML)', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const id = await addNv(db, '<img src=x onerror=alert(1)> Pérez', '584140000001');
    const html = await (await post('/nueva-vida/carta', { carta: 'dama', ids: [String(id)] })).text();
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;img/);
  });
});
