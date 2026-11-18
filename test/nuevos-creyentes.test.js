'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { nuevosCreyentesRouter } = require('../src/routes/nuevos-creyentes');
const { nuevaVidaRouter } = require('../src/routes/nueva-vida');
const nb = require('../src/new-believer-intake');
const auth = require('../src/auth');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const SECRET = 'secreto-de-prueba';

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(nuevosCreyentesRouter({ db: h.db, config }));
  app.use(nuevaVidaRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role: 'admin' })}` };
  const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
  const post = (p, fields = {}, headers = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post, admin });
  } finally {
    server.close();
    await h.close();
  }
}

test('parseSubmission: lo esencial es obligatorio y la fecha no puede ser futura', () => {
  const empty = nb.parseSubmission({}, '58', TODAY);
  assert.ok(empty.errors.some((e) => /nombre y el apellido/.test(e)));
  assert.ok(empty.errors.some((e) => /WhatsApp/.test(e)));
  assert.ok(empty.errors.some((e) => /sede/.test(e)));
  const manana = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: config.timezone });
  const future = nb.parseSubmission(
    { full_name: 'María Pérez', phone: '0414-0000001', decision_date: manana, sede: 'Las Mercedes', how_arrived: 'Otro' },
    '58',
    TODAY
  );
  assert.ok(future.errors.some((e) => /futura/.test(e)));
  const sinServicio = nb.parseSubmission(
    { full_name: 'María Pérez', phone: '0414-0000001', decision_date: TODAY, sede: 'Las Mercedes', how_arrived: 'Otro' },
    '58',
    TODAY
  );
  assert.ok(sinServicio.errors.some((e) => /en qué servicio/.test(e)));
  const ok = nb.parseSubmission(
    { full_name: 'María Pérez', phone: '0414-0000001', decision_date: TODAY, sede: 'Las Mercedes', service: 'Domingo · 2do servicio', first_time: 'Primera vez', decision_type: 'Conversión', how_arrived: 'Invitado por un familiar' },
    '58',
    TODAY
  );
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.phone, '584140000001');
  assert.equal(ok.value.decision_date, TODAY);
  assert.equal(ok.value.service, 'Domingo · 2do servicio');
  assert.equal(ok.value.first_time, 'Primera vez');
  assert.equal(ok.value.decision_type, 'Conversión');
  const sinDatos = nb.parseSubmission(
    { full_name: 'María Pérez', phone: '0414-0000001', decision_date: TODAY, sede: 'Las Mercedes', service: 'Miércoles', how_arrived: 'Otro' },
    '58',
    TODAY
  );
  assert.ok(sinDatos.errors.some((e) => /primera vez/.test(e)));
  assert.ok(sinDatos.errors.some((e) => /conversión o reconciliación/.test(e)));
});

test('el remoto: enlace malo no abre; el registro entra a Nueva Vida por revisar, con la fecha de hoy', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    assert.equal((await get('/nuevos-creyentes/no-existe-este-token')).status, 404);

    const link = await nb.ensureLink(db);
    const page = await get(`/nuevos-creyentes/${link.token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Registro de nuevo creyente/);
    assert.ok(html.includes(`value="${TODAY}"`)); // la fecha ya viene en hoy: se llena el día de la conversión
    assert.match(html, /¿En qué servicio se convirtió\?/);
    assert.match(html, /Domingo · 1er servicio/);
    assert.match(html, /Miércoles/);
    assert.match(html, /Nuarito/); // las sedes son las dos que dictó el pastor
    assert.match(html, /Las Mercedes/);
    assert.match(html, /¿Es tu primera vez en la iglesia\?/);
    assert.match(html, /¿Fue conversión o reconciliación\?/);

    // falta el teléfono: vuelve al formulario con el aviso y no guarda nada
    const bad = await post(`/nuevos-creyentes/${link.token}`, { full_name: 'María Pérez', decision_date: TODAY, sede: 'Las Mercedes', how_arrived: 'Otro' });
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /WhatsApp/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida')).rows[0].n, 0);

    // registro completo: entra a la lista, por revisar y con su fuente
    const ok = await post(`/nuevos-creyentes/${link.token}`, {
      full_name: 'María Pérez', phone: '0414-0000001', decision_date: TODAY, sede: 'Las Mercedes',
      service: 'Miércoles', first_time: 'Ya ha venido antes', decision_type: 'Reconciliación', how_arrived: 'Invitado por un familiar', age: '33', civil_status: 'Casado(a)',
    });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /familia de Dios/);
    const rows = (await db.query('SELECT * FROM nueva_vida')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].full_name, 'María Pérez');
    assert.equal(rows[0].service, 'Miércoles');
    assert.equal(rows[0].first_time, 'Ya ha venido antes');
    assert.equal(rows[0].decision_type, 'Reconciliación');
    assert.equal(rows[0].phone, '584140000001');
    assert.equal(rows[0].decision_date.toISOString().slice(0, 10), TODAY);
    assert.equal(rows[0].needs_review, true);
    assert.equal(rows[0].source, 'Enlace del día de conversión');
    assert.equal(await nb.countPending(db), 1);

    // apagado: el enlace deja de abrir
    await nb.setLinkActive(db, false);
    assert.equal((await get(`/nuevos-creyentes/${link.token}`)).status, 404);
  });
});

test('el remoto: el mismo teléfono el mismo día NO se duplica; otro día sí puede registrarse', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const link = await nb.ensureLink(db);
    const datos = {
      full_name: 'María Pérez', phone: '0414-0000001', decision_date: TODAY, sede: 'Las Mercedes',
      service: 'Miércoles', first_time: 'Primera vez', decision_type: 'Conversión', how_arrived: 'Invitado por un familiar',
    };
    const uno = await post(`/nuevos-creyentes/${link.token}`, datos);
    assert.equal(uno.status, 200);
    assert.match(await uno.text(), /familia de Dios/);

    // segundo envío idéntico (doble toque, reintento o dos personas del equipo): avisa y no crea otra fila
    const dos = await post(`/nuevos-creyentes/${link.token}`, datos);
    assert.equal(dos.status, 200);
    assert.match(await dos.text(), /Ya quedó registrado hoy/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida')).rows[0].n, 1);

    // la misma persona, otro día (una reconciliación posterior): sí entra
    const ayer = new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: config.timezone });
    const tres = await post(`/nuevos-creyentes/${link.token}`, { ...datos, decision_date: ayer, decision_type: 'Reconciliación' });
    assert.equal(tres.status, 200);
    assert.match(await tres.text(), /familia de Dios/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida')).rows[0].n, 2);
  });
});

test('el panel: la página del enlace lo genera y la lista de Nueva Vida lleva a ella', async (t) => {
  await withApp(t, async ({ get, admin }) => {
    const p = await get('/nueva-vida/enlace', admin);
    assert.equal(p.status, 200);
    const html = await p.text();
    assert.match(html, /Enlace del día de conversión/);
    assert.match(html, /\/nuevos-creyentes\//);
    const list = await get('/nueva-vida', admin);
    assert.equal(list.status, 200);
    assert.ok((await list.text()).includes('/nueva-vida/enlace'));
  });
});
