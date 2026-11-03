'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { reunionEquipoRouter, reunionRemotaRouter } = require('../src/routes/reunion-equipo');
const { openTestDb } = require('./helpers/db');

const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: false };

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(reunionRemotaRouter({ db: h.db, config }));
  app.use(reunionEquipoRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const save = (k, v) => fetch(base + '/reunion-equipo/guardar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k, v }) });
  try {
    await fn({ db: h.db, get, save, base });
  } finally {
    server.close();
    await h.close();
  }
}

test('guarda una casilla, la muestra escapada y un texto vacío la borra', async (t) => {
  await withApp(t, async ({ db, get, save }) => {
    assert.equal((await save('t1a', 'Funciona <b>bien</b>')).status, 204);
    const html = await (await get('/reunion-equipo')).text();
    assert.ok(html.includes('Funciona &lt;b&gt;bien&lt;/b&gt;'));
    assert.ok(!html.includes('<b>bien</b>'));
    assert.equal((await save('t1a', '  ')).status, 204);
    const { rows } = await db.query('SELECT * FROM reunion_equipo');
    assert.equal(rows.length, 0);
  });
});

test('rechaza claves que no existen y recorta textos largos', async (t) => {
  await withApp(t, async ({ db, save }) => {
    assert.equal((await save('inventada', 'x')).status, 400);
    assert.equal((await save('ac1', 'a'.repeat(9000))).status, 204);
    const { rows } = await db.query("SELECT length(value) AS n FROM reunion_equipo WHERE key = 'ac1'");
    assert.equal(rows[0].n, 5000);
    assert.equal((await db.query('SELECT 1 FROM reunion_equipo')).rows.length, 1);
  });
});

test('borrar todo vacía la hoja y no toca otras tablas', async (t) => {
  await withApp(t, async ({ db, save, base }) => {
    await save('e1', 'uno');
    await save('ac2r', 'Silmar');
    const r = await fetch(base + '/reunion-equipo/borrar', { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal((await db.query('SELECT 1 FROM reunion_equipo')).rows.length, 0);
  });
});

const tokenOf = (html) => /\/reunion\/([A-Za-z0-9_-]{16,64})/.exec(html)[1];

test('enlace remoto: abre la libreta con el token, no muestra lo guardado en el panel y no guarda nada', async (t) => {
  await withApp(t, async ({ db, get, save }) => {
    await save('t1a', 'texto privado del panel');
    const token = tokenOf(await (await get('/reunion-equipo')).text());
    const res = await get(`/reunion/${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('noindex'));
    assert.ok(html.includes('Entrevista cruzada'));
    assert.ok(!html.includes('texto privado del panel'));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await db.query('SELECT 1 FROM reunion_equipo')).rows.length, 1);
  });
});

test('enlace remoto: token inválido, apagado y regenerado dejan de abrir', async (t) => {
  await withApp(t, async ({ get, base }) => {
    const token = tokenOf(await (await get('/reunion-equipo')).text());
    assert.equal((await get('/reunion/no-es-el-token-1234567890')).status, 404);
    const post = (a) => fetch(`${base}/reunion-equipo/enlace/${a}`, { method: 'POST', redirect: 'manual' });
    await post('apagar');
    assert.equal((await get(`/reunion/${token}`)).status, 404);
    await post('encender');
    assert.equal((await get(`/reunion/${token}`)).status, 200);
    await post('regenerar');
    assert.equal((await get(`/reunion/${token}`)).status, 404);
    const nuevo = tokenOf(await (await get('/reunion-equipo')).text());
    assert.notEqual(nuevo, token);
    assert.equal((await get(`/reunion/${nuevo}`)).status, 200);
    assert.equal((await post('otra')).status, 404);
  });
});

const DEV = 'dispositivo-prueba-0001';
const sendTo = (base, token, body) => fetch(`${base}/reunion/${token}/enviar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('respuestas: se guardan por aparato, reenviar corrige y el panel las muestra escapadas', async (t) => {
  await withApp(t, async ({ db, get, base }) => {
    const token = tokenOf(await (await get('/reunion-equipo')).text());
    const r1 = await sendTo(base, token, { device: DEV, name: 'Silmar', answers: { t2a: 'Anuncios <i>claros</i>', ac1: 'Acuerdo uno', ac1r: 'Laura', inventada: 'x' } });
    assert.equal(r1.status, 204);
    const r2 = await sendTo(base, token, { device: DEV, name: 'Silmar A.', answers: { t2a: 'Versión corregida' } });
    assert.equal(r2.status, 204);
    const { rows } = await db.query('SELECT name, answers FROM reunion_respuestas');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Silmar A.');
    assert.deepEqual(rows[0].answers, { t2a: 'Versión corregida' });
    await sendTo(base, token, { device: 'otro-aparato-00000002', name: 'Laura', answers: { t2a: 'Tarde <script>x</script>' } });
    const tema = await (await get('/reunion-equipo/respuestas')).text();
    assert.ok(tema.includes('Versión corregida') && tema.includes('Laura'));
    assert.ok(!tema.includes('<script>x'));
    const per = await (await get('/reunion-equipo/respuestas?ver=persona')).text();
    assert.ok(per.includes('Silmar A.'));
    const panel = await (await get('/reunion-equipo')).text();
    assert.ok(panel.includes('Respuestas del equipo (2)'));
  });
});

test('respuestas: rechaza sin nombre, vacías, aparato inválido, token malo o enlace apagado; no toca people', async (t) => {
  await withApp(t, async ({ db, get, base }) => {
    const token = tokenOf(await (await get('/reunion-equipo')).text());
    assert.equal((await sendTo(base, token, { device: DEV, name: '', answers: { e1: 'x' } })).status, 400);
    assert.equal((await sendTo(base, token, { device: DEV, name: 'Ana', answers: {} })).status, 400);
    assert.equal((await sendTo(base, token, { device: 'corto', name: 'Ana', answers: { e1: 'x' } })).status, 400);
    assert.equal((await sendTo(base, 'token-que-no-existe-123456', { device: DEV, name: 'Ana', answers: { e1: 'x' } })).status, 404);
    await fetch(`${base}/reunion-equipo/enlace/apagar`, { method: 'POST', redirect: 'manual' });
    assert.equal((await sendTo(base, token, { device: DEV, name: 'Ana', answers: { e1: 'x' } })).status, 404);
    assert.equal((await db.query('SELECT 1 FROM reunion_respuestas')).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM people')).rows.length, 0);
  });
});

test('respuestas: borrar una respuesta desde el panel', async (t) => {
  await withApp(t, async ({ db, base, get }) => {
    const token = tokenOf(await (await get('/reunion-equipo')).text());
    await sendTo(base, token, { device: DEV, name: 'Ana', answers: { e1: 'hola' } });
    const { rows } = await db.query('SELECT id FROM reunion_respuestas');
    const r = await fetch(`${base}/reunion-equipo/respuestas/${rows[0].id}/borrar`, { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal((await db.query('SELECT 1 FROM reunion_respuestas')).rows.length, 0);
  });
});
