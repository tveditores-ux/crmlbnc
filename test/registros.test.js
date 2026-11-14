'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registrosRouter } = require('../src/routes/registros');
const { ministryLeaderIntakeRouter } = require('../src/routes/ministry-leader-intake');
const { pastorIntakeRouter } = require('../src/routes/pastor-intake');
const { reporteComunRouter } = require('../src/routes/reporte-comun');
const desarrollo = require('../src/ministry-leader-intake');
const pastores = require('../src/pastor-intake');
const reporte = require('../src/care-report-link');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(ministryLeaderIntakeRouter({ db: h.db, config }));
  app.use(pastorIntakeRouter({ db: h.db, config }));
  app.use(reporteComunRouter({ db: h.db, config }));
  app.use(registrosRouter({ db: h.db, config }));
  const server = app.listen(0);
  const b = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(b + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(fields)), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}

test('la pestaña Registros reúne los cinco enlaces de registro, cada uno con su mensaje', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const r = await get('/registros');
    assert.equal(r.status, 200);
    const html = await r.text();
    for (const title of ['Líderes de ministerios de desarrollo', 'Registro ministerial (pastores y servidores)', 'Datos de las personas («Mis datos»)', 'Datos de los líderes de grupos de cuidado', 'Reporte semanal de grupos de cuidado']) assert.ok(html.includes(title), title);
    const dev = await desarrollo.ensureToken(db);
    assert.ok(html.includes(`http://prueba.local/desarrollo/${dev.token}`));
    const pas = await pastores.ensureToken(db);
    assert.ok(html.includes(`http://prueba.local/pastores/${pas.token}`));
    const rep = await reporte.ensureLink(db);
    assert.ok(html.includes(`http://prueba.local/reportes/${rep.token}`));
    assert.match(html, /Elegir chat en WhatsApp/);
    assert.match(html, /Generar enlace nuevo/);
  });
});

test('apagar, encender y regenerar desde Registros manda sobre el mismo enlace de cada remoto', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await get('/registros'); // genera los tokens
    const dev = await desarrollo.ensureToken(db);
    assert.equal((await get(`/desarrollo/${dev.token}`)).status, 200);
    const off = await post('/registros/desarrollo/apagar');
    assert.equal(off.status, 303);
    assert.equal((await get(`/desarrollo/${dev.token}`)).status, 404);
    await post('/registros/desarrollo/encender');
    assert.equal((await get(`/desarrollo/${dev.token}`)).status, 200);

    const before = (await pastores.ensureToken(db)).token;
    assert.equal((await get(`/pastores/${before}`)).status, 200);
    await post('/registros/pastores/nuevo');
    const after = (await pastores.ensureToken(db)).token;
    assert.notEqual(after, before);
    assert.equal((await get(`/pastores/${before}`)).status, 404);
    assert.equal((await get(`/pastores/${after}`)).status, 200);

    const rep = await reporte.ensureLink(db);
    assert.equal((await get(`/reportes/${rep.token}`)).status, 200);
    await post('/registros/reporte/apagar');
    assert.equal((await get(`/reportes/${rep.token}`)).status, 404);

    const bad = await post('/registros/no-existe/apagar');
    assert.equal(bad.status, 303); // vuelve a Registros con el aviso, sin romper nada
  });
});
