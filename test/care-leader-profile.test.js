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
const required = { leader_name: 'Líder Uno', leader_phone: '0414-000.00.01', leader_email: 'lider@ejemplo.com', advisor_name: 'Asesor Uno' };
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
    assert.match(html, /type="date" name="leader_birth_date"/);
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
