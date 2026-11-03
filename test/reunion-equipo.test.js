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
