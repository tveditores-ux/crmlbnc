'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { adminRouter } = require('../src/routes/admin');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, sendWindowStart: 8, sendWindowEnd: 20, whatsapp: {}, email: {}, agent: {} };

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(adminRouter({ db: h.db, config, channels: { whatsapp: { available: false }, email: { available: false } } }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}

test('la congregación se cambia desde la ficha de la persona (de Jóvenes adultos a Mujeres)', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const id = (
      await db.query("INSERT INTO people (full_name, phone, congregation) VALUES ('Raquel de Prueba', '584140000088', 'Jóvenes adultos') RETURNING id")
    ).rows[0].id;

    // el formulario de la ficha trae la congregación actual elegida y ofrece las demás
    const ficha = await get(`/personas/${id}`);
    assert.equal(ficha.status, 200);
    const html = await ficha.text();
    assert.match(html, /name="congregation"/);
    assert.match(html, /<option selected>Jóvenes adultos<\/option>/);
    assert.match(html, /<option>Mujeres<\/option>/);

    // guardar la ficha con Mujeres: la congregación cambia y lo demás queda
    const save = await post(`/personas/${id}`, {
      full_name: 'Raquel de Prueba', phone: '0414-0000088', email: '', role: '', preferred_channel: 'whatsapp', congregation: 'Mujeres',
    });
    assert.equal(save.status, 303);
    const row = (await db.query('SELECT full_name, phone, congregation FROM people WHERE id = $1', [id])).rows[0];
    assert.equal(row.congregation, 'Mujeres');
    assert.equal(row.full_name, 'Raquel de Prueba');
    assert.equal(row.phone, '584140000088');

    // y la ficha ya la muestra en sus datos
    const ficha2 = await get(`/personas/${id}`);
    assert.match(await ficha2.text(), /Congregación:<\/span> Mujeres/);
  });
});

test('un guardado que no trae congregación no la borra', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const id = (
      await db.query("INSERT INTO people (full_name, phone, congregation) VALUES ('Otra Persona', '584140000077', 'Jóvenes adultos') RETURNING id")
    ).rows[0].id;
    const repo = require('../src/repo');
    const { value, errors } = repo.validatePerson({ full_name: 'Otra Persona', phone: '0414-0000077' }, '58');
    assert.deepEqual(errors, []);
    assert.equal(value.congregation, undefined);
    await repo.savePerson(db, id, value);
    const row = (await db.query('SELECT congregation FROM people WHERE id = $1', [id])).rows[0];
    assert.equal(row.congregation, 'Jóvenes adultos');
  });
});
