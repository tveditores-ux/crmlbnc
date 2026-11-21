'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { childIntakeRouter } = require('../src/routes/child-intake');
const { childRequestsRouter } = require('../src/routes/child-requests');
const intake = require('../src/child-intake');
const auth = require('../src/auth');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const SECRET = 'secreto-de-prueba';
const fakeJpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, fill), Buffer.from([0xff, 0xd9])]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

/** Las partes (día, mes, año) de una fecha de nacimiento de hace exactamente n años. */
function haceAnios(n) {
  const [y, m, d] = TODAY.split('-').map(Number);
  return { bd_day: String(d), bd_month: String(m), bd_year: String(y - n) };
}
const base = (edad = 7) => ({
  child_name: 'Samuel Prueba',
  ...haceAnios(edad),
  parent_name: 'Marta Prueba',
  parent_relation: 'Mamá',
  parent_phone: '0414-555.01.01',
  photo_child_data: dataUrl(fakeJpeg(5)),
  photo_parent_data: dataUrl(fakeJpeg(6)),
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '8mb' }));
  app.use(childIntakeRouter({ db: h.db, config }));
  app.use(childRequestsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base0 = `http://127.0.0.1:${server.address().port}`;
  const admin = { Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role: 'admin' })}` };
  const get = (p, headers = {}) => fetch(base0 + p, { redirect: 'manual', headers });
  const post = (p, fields = {}, headers = {}) =>
    fetch(base0 + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post, admin });
  } finally {
    server.close();
    await h.close();
  }
}

test('la congregación sale de la edad: Niños 3–10, Preadolescentes 11–13, Adolescentes 14–17', () => {
  assert.equal(intake.congregationForAge(3), 'Niños');
  assert.equal(intake.congregationForAge(10), 'Niños');
  assert.equal(intake.congregationForAge(11), 'Preadolescentes');
  assert.equal(intake.congregationForAge(13), 'Preadolescentes');
  assert.equal(intake.congregationForAge(14), 'Adolescentes');
  assert.equal(intake.congregationForAge(17), 'Adolescentes');
  assert.equal(intake.congregationForAge(2), '');
  assert.equal(intake.congregationForAge(18), '');
  for (const [edad, cong] of [[7, 'Niños'], [12, 'Preadolescentes'], [15, 'Adolescentes']]) {
    const r = intake.parseSubmission(base(edad), '58', TODAY);
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.congregation, cong);
  }
  const fuera = intake.parseSubmission(base(19), '58', TODAY);
  assert.ok(fuera.errors.some((e) => /de 3 a 17 años/.test(e)));
});

test('parseSubmission: faltan las dos fotos o el representante y no pasa', () => {
  const sinFotoNino = intake.parseSubmission({ ...base(), photo_child_data: '' }, '58', TODAY);
  assert.ok(sinFotoNino.errors.some((e) => /Falta la foto del niño/.test(e)));
  const sinFotoPadre = intake.parseSubmission({ ...base(), photo_parent_data: '' }, '58', TODAY);
  assert.ok(sinFotoPadre.errors.some((e) => /Falta tu foto/.test(e)));
  const sinRelacion = intake.parseSubmission({ ...base(), parent_relation: '' }, '58', TODAY);
  assert.ok(sinRelacion.errors.some((e) => /papá, mamá o representante/.test(e)));
});

test('remoto: registra, el panel aplica y el niño entra en Personas con su congregación y su foto', async (t) => {
  await withApp(t, async ({ db, get, post, admin }) => {
    const { token } = await intake.ensureLink(db);
    const form = await get(`/ninos/${token}`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /Si tu hijo asiste a nuestra congregación/);

    const r = await post(`/ninos/${token}`, base(7));
    assert.equal(r.status, 200);
    assert.match(await r.text(), /congregación de <strong>Niños<\/strong>/);
    assert.equal(await intake.countPending(db), 1);

    const panel = await get('/ninos', admin);
    assert.equal(panel.status, 200);
    const html = await panel.text();
    assert.match(html, /Samuel Prueba/);
    assert.match(html, /Marta Prueba/);
    const sub = (await db.query("SELECT * FROM child_submissions WHERE status = 'pendiente'")).rows[0];
    const foto = await get(`/ninos/respuestas/${sub.id}/foto-hijo`, admin);
    assert.equal(foto.status, 200);

    const ap = await post(`/ninos/respuestas/${sub.id}/aplicar`, {}, admin);
    assert.equal(ap.status, 303);
    const person = (await db.query("SELECT * FROM people WHERE full_name = 'Samuel Prueba'")).rows[0];
    assert.ok(person, 'la ficha del niño existe');
    assert.equal(person.congregation, 'Niños');
    assert.equal(person.phone, null);
    assert.equal(person.opt_in, false);
    assert.match(person.notes, /Representante: Marta Prueba \(Mamá\)/);
    const fotoFicha = (await db.query('SELECT data FROM people_photos WHERE person_id = $1', [person.id])).rows[0];
    assert.ok(fotoFicha && fotoFicha.data.length > 0, 'la foto del niño quedó en su ficha');
  });
});

test('el mismo niño otra vez pregunta si es una actualización; un hermano con el mismo teléfono entra directo', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const { token } = await intake.ensureLink(db);
    await post(`/ninos/${token}`, base(7));
    assert.equal(await intake.countPending(db), 1);

    // el mismo niño de nuevo: pregunta antes de guardar otro envío
    const otra = await post(`/ninos/${token}`, base(7));
    assert.equal(otra.status, 200);
    assert.match(await otra.text(), /actualizar sus datos/);
    assert.equal(await intake.countPending(db), 1, 'sin confirmación no se guarda nada');

    // confirmado: se guarda como actualización por revisar
    const conf = await post(`/ninos/${token}`, { ...base(7), es_actualizacion: '1' });
    assert.match(await conf.text(), /Registramos a Samuel Prueba/);
    assert.equal(await intake.countPending(db), 2);

    // un hermano (otro nombre y otra fecha) con el mismo teléfono del representante: entra directo
    const hermano = await post(`/ninos/${token}`, { ...base(5), child_name: 'Rut Prueba' });
    assert.equal(hermano.status, 200);
    const txt = await hermano.text();
    assert.match(txt, /Registramos a Rut Prueba/);
    assert.doesNotMatch(txt, /actualizar sus datos/);
    assert.equal(await intake.countPending(db), 3);
  });
});
