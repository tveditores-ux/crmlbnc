'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cg = require('../src/care-groups');
const { careRemoteRouter } = require('../src/routes/care-remote');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

// "JPEG" mínimo para las pruebas: empieza con FFD8FF, termina con FFD9 y pasa el tamaño mínimo.
// lo obligatorio del formulario por grupo (el nacimiento y la foto se prueban aparte)
const required = { leader_name: 'Líder Uno', leader_cedula: 'V-12345678', leader_address: 'Calle de prueba 1', leader_phone: '0414-000.00.01', leader_email: 'lider@ejemplo.com' };
const fakeJpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, fill), Buffer.from([0xff, 0xd9])]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

test('fecha de nacimiento: vacía vale, y rechaza fechas que no existen, futuras o con año absurdo', () => {
  assert.deepEqual(cg.parseBirthDate('', TODAY), { value: '' });
  assert.deepEqual(cg.parseBirthDate('1985-07-04', TODAY), { value: '1985-07-04' });
  for (const bad of ['1985-02-30', '2999-01-01', '1850-01-01', 'ayer', '04/07/1985']) {
    assert.ok(cg.parseBirthDate(bad, TODAY).error, bad);
  }
  assert.ok(cg.parseBirthDate('1985-02-30', TODAY, 'del líder').error.includes('del líder'));
});

test('foto: solo JPEG en data URL, con firma válida y tamaño razonable', () => {
  assert.deepEqual(cg.parsePhoto(''), { buffer: null });
  assert.ok(cg.parsePhoto(dataUrl(fakeJpeg())).buffer.length > 400);
  assert.ok(cg.parsePhoto('data:image/png;base64,AAAA').error);
  assert.ok(cg.parsePhoto('data:image/jpeg;base64,@@@').error);
  assert.ok(cg.parsePhoto(dataUrl(Buffer.from('esto no es una imagen, ni de lejos. '.repeat(20)))).error); // sin firma JPEG
  assert.ok(cg.parsePhoto(dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).error); // demasiado pequeña
  assert.ok(cg.parsePhoto(dataUrl(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(cg.MAX_PHOTO_BYTES), Buffer.from([0xff, 0xd9])]))).error); // demasiado grande
});

test('próximos cumpleaños: hoy primero, año siguiente, 29 de febrero y grupos inactivos', () => {
  const groups = [
    { name: 'G1', active: true, leader_name: 'Ana', leader_birth_date: '1980-11-05' },
    { name: 'G2', active: true, leader_name: 'Pia', leader_birth_date: '1990-10-29' },
    { name: 'G5', active: true, leader_name: 'Luis', leader_birth_date: '1979-02-14' },
    { name: 'G3', active: false, leader_name: 'Inactivo', leader_birth_date: '1980-10-30' },
    { name: 'G4', active: true, leader_name: 'Bisiesto', leader_birth_date: '1980-02-29' },
  ];
  const out = cg.upcomingBirthdays(groups, '2026-10-29', 45);
  assert.deepEqual(out.map((b) => [b.who, b.inDays]), [['Pia', 0], ['Ana', 7]]); // Luis (14 de febrero) queda fuera de los 45 días
  assert.equal(out[0].turns, 36);
  assert.ok(!out.some((b) => b.group === 'G3'));
  // a fin de diciembre se ve el año que viene; el 29 de febrero cae el 28 en año no bisiesto
  const dec = cg.upcomingBirthdays(groups, '2026-12-28', 90);
  assert.ok(dec.some((b) => b.who === 'Luis' && b.month === 2 && b.day === 14 && b.turns === 48));
  assert.deepEqual(dec.find((b) => b.who === 'Bisiesto'), { group: 'G4', who: 'Bisiesto', month: 2, day: 28, turns: 47, inDays: 62 });
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(careRemoteRouter({ db: h.db, config }));
  app.use(careGroupsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(fields)), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}

const mkGroup = async (db, name = 'GdC Perfil', token = 'tokenperfil1234567890') =>
  (await db.query('INSERT INTO care_groups (name, leader_name, token) VALUES ($1, $2, $3) RETURNING *', [name, 'Líder Uno', token])).rows[0];

test('el líder envía su nacimiento y su foto; se guardan, se ven en el panel y la foto solo sale con enlace o sesión', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db);
    const T = `/g/${g.token}`;
    const html = await (await get(`${T}/datos`)).text();
    assert.match(html, /capture="user"/); // abre la cámara frontal
    // la fecha de nacimiento se elige con tres selectores (día, mes y año)
    for (const n of ['bd_day', 'bd_month', 'bd_year']) assert.match(html, new RegExp(`<select name="${n}"`));
    assert.ok(!html.includes('type="date"'));
    assert.equal((await get(`${T}/foto`)).status, 404); // aún no hay

    const photo = fakeJpeg(9);
    const ok = await post(`${T}/datos`, { ...required, leader_birth_date: '1985-11-05', photo_data: dataUrl(photo) });
    assert.equal(ok.status, 200);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_birth_date, '1985-11-05');

    const img = await get(`${T}/foto`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), photo);
    assert.equal((await get('/g/zzzzzzzzzzzzzzzzzzzz/foto')).status, 404);

    const panel = await (await get(`/grupos/${g.id}`)).text();
    assert.match(panel, /nació el 05\/11\/1985/);
    assert.match(panel, /C\.I\. V-12345678/);
    assert.match(panel, /Calle de prueba 1/);
    assert.ok(!panel.includes('Pareja'));
    assert.match(panel, new RegExp(`/grupos/${g.id}/foto`));
    const adminImg = await get(`/grupos/${g.id}/foto`);
    assert.equal(adminImg.status, 200);

    // reenviar sin foto nueva conserva la que había
    assert.equal((await post(`${T}/datos`, { ...required, leader_birth_date: '1985-11-05' })).status, 200);
    assert.equal((await get(`${T}/foto`)).status, 200);
    const list = await (await get('/grupos')).text();
    assert.match(list, new RegExp(`<img src="/grupos/${g.id}/foto"`));
  });
});

test('datos malos de nacimiento o foto: 400, no se guarda nada y la foto buena no se pierde al corregir', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db);
    const T = `/g/${g.token}`;
    const badDate = await post(`${T}/datos`, { ...required, leader_birth_date: '1985-02-30', photo_data: dataUrl(fakeJpeg()) });
    assert.equal(badDate.status, 400);
    const html = await badDate.text();
    assert.match(html, /no existe/);
    assert.ok(html.includes(dataUrl(fakeJpeg()).slice(0, 80))); // la foto sigue en el formulario
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_birth_date, '');
    assert.equal(row.profile_updated_at, null);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_photos')).rows[0].n, 0);

    const badPhoto = await post(`${T}/datos`, { ...required, photo_data: 'data:image/png;base64,AAAA' });
    assert.equal(badPhoto.status, 400);
    assert.match(await badPhoto.text(), /No pude leer la foto/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_photos')).rows[0].n, 0);

    assert.equal((await post(`${T}/datos`, { ...required, leader_birth_date: '2999-01-01', photo_data: dataUrl(fakeJpeg()) })).status, 400);
  });
});

test('la lista muestra los cumpleaños próximos y borrar el grupo borra la foto (cascada)', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db);
    const soon = new Date(Date.now() + 5 * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });
    await db.query('UPDATE care_groups SET leader_birth_date = $2 WHERE id = $1', [g.id, `1980-${soon.slice(5)}`]);
    assert.match(await (await get('/grupos')).text(), /Próximos cumpleaños de líderes/);
    await db.query('INSERT INTO care_group_photos (group_id, data) VALUES ($1, $2)', [g.id, fakeJpeg()]);
    await db.query('DELETE FROM care_groups WHERE id = $1', [g.id]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_photos')).rows[0].n, 0);
  });
});

test('nacimiento con selectores: arma la fecha, exige las tres partes y rechaza fechas imposibles', () => {
  const parse = (extra) => cg.parseLeaderProfile({ name: 'x', leader_name: 'Ana Uno', ...extra }, '58', TODAY);
  assert.equal(parse({ bd_day: '5', bd_month: '11', bd_year: '1985' }).value.leader_birth_date, '1985-11-05');
  assert.equal(parse({ bd_day: '05', bd_month: '07', bd_year: '1990' }).value.leader_birth_date, '1990-07-05');
  assert.equal(parse({ leader_birth_date: '1985-11-05' }).value.leader_birth_date, '1985-11-05'); // la fecha armada también vale
  assert.equal(parse({}).value.leader_birth_date, ''); // opcional
  assert.ok(parse({ bd_day: '5', bd_month: '', bd_year: '1985' }).errors.some((e) => /Completa el día, el mes y el año/.test(e)));
  assert.ok(parse({ bd_day: '31', bd_month: '02', bd_year: '1985' }).errors.some((e) => /no existe/.test(e)));
});

test('el formulario muestra la fecha guardada en los tres selectores y años de más reciente a más antiguo', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db);
    await db.query("UPDATE care_groups SET leader_birth_date = '1985-11-05' WHERE id = $1", [g.id]);
    const html = await (await get(`/g/${g.token}/datos`)).text();
    assert.match(html, /<option value="05" selected>5<\/option>/);
    assert.match(html, /<option value="11" selected>noviembre<\/option>/);
    assert.match(html, /<option value="1985" selected>1985<\/option>/);
    const years = [...html.matchAll(/<option value="(\d{4})"/g)].map((m) => +m[1]);
    assert.ok(years[0] > years[1] && years[years.length - 1] === 1910);
    assert.ok(years[0] <= Number(TODAY.slice(0, 4)) - 10);
  });
});

test('vaciar los datos de grupos: pide escribir BORRAR, borra todo en cascada y deja intacto el enlace común', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const intake = require('../src/care-intake');
    const token = (await intake.ensureToken(db)).token;
    const g = await mkGroup(db);
    await db.query('INSERT INTO care_group_reports (group_id, meeting_date, attendance) VALUES ($1, $2, 4)', [g.id, TODAY]);
    await db.query("INSERT INTO care_group_people (group_id, name) VALUES ($1, 'A')", [g.id]);
    await db.query('INSERT INTO care_group_photos (group_id, data) VALUES ($1, $2)', [g.id, fakeJpeg()]);
    await db.query("INSERT INTO care_group_submissions (group_id, leader_name) VALUES ($1, 'B'), (NULL, 'C')", [g.id]);
    await db.query("INSERT INTO people (full_name, phone) VALUES ('Persona Intacta', '584149990000')");

    const page = await (await get('/grupos/borrar-todo')).text();
    assert.match(page, /<strong>1<\/strong> grupos/);
    assert.match(page, /BORRAR/);

    for (const confirmar of ['', 'borrar', 'si']) {
      const r = await post('/grupos/borrar-todo', { confirmar });
      assert.equal(r.status, 303);
      assert.match(decodeURIComponent(r.headers.get('location').replaceAll('+', ' ')), /No se borró nada/);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_groups')).rows[0].n, 1);

    const ok = await post('/grupos/borrar-todo', { confirmar: 'BORRAR' });
    assert.equal(ok.status, 303);
    for (const tb of ['care_groups', 'care_group_reports', 'care_group_people', 'care_group_photos', 'care_group_submissions']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${tb}`)).rows[0].n, 0, tb);
    }
    assert.equal((await intake.ensureToken(db)).token, token); // el enlace común sigue siendo el mismo
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 1); // las personas no se tocan
    assert.match(await (await get('/grupos')).text(), /Aún no hay grupos/);
  });
});
