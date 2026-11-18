'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { adminRouter } = require('../src/routes/admin');
const { memberRequestsRouter } = require('../src/routes/member-requests');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, sendWindowStart: 8, sendWindowEnd: 20, whatsapp: {}, email: {}, agent: {} };

const jpeg = (n, fill) =>
  `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
const JPEG1 = jpeg(400, 7);
const JPEG2 = jpeg(500, 9);

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(memberRequestsRouter({ db: h.db, config }));
  app.use(adminRouter({ db: h.db, config, channels: { whatsapp: { available: false }, email: { available: false } } }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

test('el administrador cambia y quita la foto de una persona desde su ficha', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const id = (await db.query("INSERT INTO people (full_name, phone) VALUES ('Persona Foto', '584140000099') RETURNING id")).rows[0].id;

    // la ficha trae la tarjeta de la foto, todavía sin foto
    const ficha = await get(`/personas/${id}`);
    assert.equal(ficha.status, 200);
    const html = await ficha.text();
    assert.match(html, /Su foto/);
    assert.match(html, /Todavía no tiene foto/);
    assert.equal((await get(`/personas/${id}/foto`)).status, 404);

    // sin foto elegida: no guarda nada y avisa
    const vacio = await post(`/personas/${id}/foto`, { photo_data: '' });
    assert.match(loc(vacio), /Elige primero la foto nueva/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people_photos')).rows[0].n, 0);

    // foto que no es JPEG válido: tampoco
    const malo = await post(`/personas/${id}/foto`, { photo_data: `data:image/jpeg;base64,${Buffer.alloc(400, 1).toString('base64')}` });
    assert.match(loc(malo), /no es válida/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people_photos')).rows[0].n, 0);

    // guardar la primera foto
    const ok1 = await post(`/personas/${id}/foto`, { photo_data: JPEG1 });
    assert.match(loc(ok1), /Foto actualizada/);
    const servida = await get(`/personas/${id}/foto`);
    assert.equal(servida.status, 200);
    assert.match(servida.headers.get('content-type'), /image\/jpeg/);

    // cambiarla por otra: sigue habiendo UNA sola foto, con los bytes nuevos
    const ok2 = await post(`/personas/${id}/foto`, { photo_data: JPEG2 });
    assert.match(loc(ok2), /Foto actualizada/);
    const rows = (await db.query('SELECT data FROM people_photos WHERE person_id = $1', [id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.length, 506);

    // quitarla
    const fuera = await post(`/personas/${id}/foto/eliminar`, {});
    assert.match(loc(fuera), /Foto quitada/);
    assert.equal((await get(`/personas/${id}/foto`)).status, 404);

    // persona inexistente: no crea nada
    const noExiste = await post('/personas/999999/foto', { photo_data: JPEG1 });
    assert.match(loc(noExiste), /No existe esa persona/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people_photos')).rows[0].n, 0);
  });
});
