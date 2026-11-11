'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const intake = require('../src/pastor-intake');
const { pastorIntakeRouter } = require('../src/routes/pastor-intake');
const { pastorRequestsRouter } = require('../src/routes/pastor-requests');
const { adminRouter } = require('../src/routes/admin');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const fakeJpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, fill), Buffer.from([0xff, 0xd9])]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

// la ficha del líder + estado civil + función: todo obligatorio menos correo y foto
const base = {
  funcion: 'Pastor', full_name: 'José Hernández', phone: '0414-000.00.11', bd_day: '20', bd_month: '03', bd_year: '1980',
  cedula: 'V-11222333', address: 'Casa pastoral, calle 2', civil_status: 'Casado(a)', congregation: 'Hombres',
};

test('validación: la función manda y la ficha es la del líder más el estado civil', () => {
  const parse = (extra) => intake.parseSubmission({ ...base, ...extra }, '58', TODAY);
  const ok = parse({});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.phone, '584140000011');
  assert.equal(ok.value.birth_date, '1980-03-20');
  assert.equal(ok.value.cedula, 'V-11222333');
  assert.equal(ok.value.funcion, 'Pastor');
  assert.equal(parse({ funcion: 'Pastor asistente' }).value.funcion, 'Pastor asistente');

  assert.ok(parse({ funcion: '' }).errors.includes('Elige tu función: Pastor o Pastor asistente.'));
  assert.ok(parse({ funcion: 'Obispo' }).errors.includes('Elige tu función: Pastor o Pastor asistente.'));
  assert.ok(parse({ cedula: '' }).errors.includes('Escribe tu cédula de identidad.'));
  assert.ok(parse({ cedula: 'abc' }).errors.some((e) => /cédula/i.test(e)));
  assert.ok(parse({ address: '' }).errors.includes('Escribe tu dirección.'));
  assert.ok(parse({ civil_status: '' }).errors.includes('Elige tu estado civil.'));
  assert.ok(parse({ civil_status: 'Inventado' }).errors.includes('Elige tu estado civil.'));
  assert.ok(parse({ congregation: '' }).errors.includes('Elige tu congregación.'));
  assert.ok(parse({ full_name: 'Solonombre' }).errors.includes('Escribe tu nombre y tu apellido.'));
  assert.equal(parse({ photo_data: '' }).photo.buffer, null); // la foto es opcional
  assert.ok(parse({ photo_data: 'data:image/png;base64,AAAA' }).errors.length);
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(pastorIntakeRouter({ db: h.db, config }));
  app.use(pastorRequestsRouter({ db: h.db, config }));
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

const tokenOf = async (db) => (await intake.ensureToken(db)).token;
const person = async (db, phone) => (await db.query('SELECT * FROM people WHERE phone = $1', [phone])).rows[0];
const count = async (db, table, where = '') => (await db.query(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;

test('el formulario público: pide función, cédula y estado civil; enlaces malos o apagados no abren', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const token = await tokenOf(db);
    const r = await get(`/pastores/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /Registro pastoral/);
    assert.match(html, /¿Cuál es tu función\?/);
    assert.match(html, /<option[^>]*>Pastor<\/option>/);
    assert.match(html, /Pastor asistente/);
    assert.match(html, /Cédula de identidad \(C\.I\.\)/);
    assert.match(html, /Estado civil/);
    assert.match(html, /Casado\(a\)/);
    for (const n of ['bd_day', 'bd_month', 'bd_year']) assert.match(html, new RegExp(`<select name="${n}"`));

    assert.equal((await get('/pastores/zzzzzzzzzzzzzzzzzzzz')).status, 404);
    assert.equal((await post('/pastores/zzzzzzzzzzzzzzzzzzzz', base)).status, 404);
    await post('/personas/pastores/enlace/desactivar');
    assert.equal((await get(`/pastores/${token}`)).status, 404);
    await post('/personas/pastores/enlace/activar');
    assert.equal((await get(`/pastores/${token}`)).status, 200);
  });
});

test('un pastor nuevo queda pendiente; al aprobar entra a Personas con su función como rol y sin consentimiento', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const token = await tokenOf(db);
    const r = await post(`/pastores/${token}`, { ...base, email: 'jose@ejemplo.com', wants_messages: '1', photo_data: dataUrl(fakeJpeg(4)) });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Recibimos tu registro/);
    assert.equal(await count(db, 'people'), 0);

    const list = await (await get('/personas/pastores/respuestas')).text();
    assert.match(list, /José Hernández/);
    assert.match(list, /Persona nueva/);
    assert.match(list, /V-11222333/);
    const id = (await db.query('SELECT id FROM pastor_submissions')).rows[0].id;
    assert.equal((await get(`/personas/pastores/respuestas/${id}/foto`)).status, 200);

    const ok = await post(`/personas/pastores/respuestas/${id}/aplicar`, {}); // sin marcar consentimiento
    assert.equal(ok.status, 303);
    const p = await person(db, '584140000011');
    assert.equal(p.role, 'Pastor');
    assert.equal(p.civil_status, 'Casado(a)');
    assert.equal(p.cedula, 'V-11222333');
    assert.equal(p.birth_date, '1980-03-20');
    assert.equal(p.address, 'Casa pastoral, calle 2');
    assert.equal(p.congregation, 'Hombres');
    assert.deepEqual([p.opt_in, p.active], [false, true]);
    assert.equal(await count(db, 'people_photos'), 1);
    const done = (await db.query('SELECT * FROM pastor_submissions')).rows[0];
    assert.deepEqual([done.status, done.cedula, done.address, done.birth_date, done.photo], ['aplicada', '', '', '', null]);
    const panel = await (await get('/personas/pastores')).text();
    assert.match(panel, new RegExp(`/pastores/${token}`));
  });
});

test('quien ya está en Personas sin rol y sin conflictos se completa solo, con su función como rol', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await db.query("INSERT INTO people (full_name, phone, opt_in, active) VALUES ('José Hernández', '584140000011', FALSE, TRUE)");
    const token = await tokenOf(db);
    const r = await post(`/pastores/${token}`, { ...base, funcion: 'Pastor asistente' });
    assert.match(await r.text(), /Tu registro quedó guardado/);
    const p = await person(db, '584140000011');
    assert.equal(p.role, 'Pastor asistente');
    assert.equal(p.cedula, 'V-11222333');
    assert.equal(p.opt_in, false); // el consentimiento nunca se aplica solo
    assert.equal((await db.query('SELECT status, auto_applied FROM pastor_submissions')).rows[0].auto_applied, true);
  });
});

test('una función distinta a su rol actual espera revisión; al aprobar, el rol pasa a ser la función', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await db.query("INSERT INTO people (full_name, phone, role, opt_in, active) VALUES ('José Hernández', '584140000011', 'Líder', TRUE, TRUE)");
    const token = await tokenOf(db);
    await post(`/pastores/${token}`, base);
    assert.equal((await person(db, '584140000011')).role, 'Líder'); // nada cambió solo
    const html = await (await get('/personas/pastores/respuestas')).text();
    assert.match(html, /Ya está en Personas, con datos distintos/);
    assert.match(html, /Función/);
    const id = (await db.query('SELECT id FROM pastor_submissions')).rows[0].id;
    await post(`/personas/pastores/respuestas/${id}/aplicar`);
    assert.equal((await person(db, '584140000011')).role, 'Pastor');
    assert.equal((await person(db, '584140000011')).opt_in, true); // su consentimiento previo no se toca
  });
});

test('la página de Personas tiene el botón «Registro pastoral» que lleva a la página del enlace', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(adminRouter({ db: h.db, config, channels: { whatsapp: { available: false }, email: { available: false } } }));
  app.use(pastorRequestsRouter({ db: h.db, config }));
  const server = app.listen(0);
  try {
    const b = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(b + '/personas')).text();
    assert.match(html, /<a class="btn sec" href="\/personas\/pastores">Registro pastoral<\/a>/);
    assert.equal((await fetch(b + '/personas/pastores')).status, 200);
  } finally {
    server.close();
    await h.close();
  }
});

test('envíos malos: 400 y nada se guarda; robots no guardan nada', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const token = await tokenOf(db);
    assert.equal((await post(`/pastores/${token}`, { ...base, funcion: '' })).status, 400);
    assert.equal((await post(`/pastores/${token}`, { ...base, cedula: '' })).status, 400);
    assert.equal((await post(`/pastores/${token}`, { ...base, civil_status: '' })).status, 400);
    assert.equal(await count(db, 'pastor_submissions'), 0);
    assert.equal((await post(`/pastores/${token}`, { ...base, web: 'x' })).status, 200);
    assert.equal(await count(db, 'pastor_submissions'), 0);
  });
});
