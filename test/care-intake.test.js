'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const intake = require('../src/care-intake');
const { careIntakeRouter } = require('../src/routes/care-intake');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const fakeJpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, fill), Buffer.from([0xff, 0xd9])]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(careIntakeRouter({ db: h.db, config }));
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

const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
const mkGroup = async (db, name, phone = '', leader = 'Líder Registrado') =>
  (await db.query('INSERT INTO care_groups (name, leader_name, leader_phone, token) VALUES ($1,$2,$3,$4) RETURNING *', [name, leader, phone, `tok${Math.random().toString(36).slice(2).padEnd(18, 'x')}`])).rows[0];
const tokenOf = async (db) => (await intake.ensureToken(db)).token;

test('el formulario común lista los grupos activos (solo nombres) y rechaza enlaces malos o apagados', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await mkGroup(db, 'Grupo Visible', '584140000001');
    const off = await mkGroup(db, 'Grupo Apagado');
    await db.query('UPDATE care_groups SET active = FALSE WHERE id = $1', [off.id]);
    const token = await tokenOf(db);

    const r = await get(`/registro/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /Grupo Visible/);
    assert.ok(!html.includes('Grupo Apagado'));
    assert.ok(!html.includes('584140000001') && !html.includes('0414-000.00.01')); // no se filtran teléfonos
    assert.match(html, /capture="user"/);
    assert.match(html, /Mi grupo no está en la lista/);

    assert.equal((await get('/registro/zzzzzzzzzzzzzzzzzzzz')).status, 404);
    assert.equal((await get('/registro/corto')).status, 404);
    assert.equal((await post('/registro/zzzzzzzzzzzzzzzzzzzz', { group_id: '1' })).status, 404);

    await post('/grupos/enlace-comun/desactivar');
    assert.equal((await get(`/registro/${token}`)).status, 404);
    await post('/grupos/enlace-comun/activar');
    assert.equal((await get(`/registro/${token}`)).status, 200);

    await post('/grupos/enlace-comun/nuevo');
    assert.equal((await get(`/registro/${token}`)).status, 404); // el anterior ya no sirve
    assert.equal((await get(`/registro/${await tokenOf(db)}`)).status, 200);
  });
});

test('si el teléfono coincide con el del líder, los datos y la foto se aplican solos', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db, 'Grupo Uno', '584140000001', 'Nombre Viejo');
    const token = await tokenOf(db);
    const r = await post(`/registro/${token}`, {
      group_id: String(g.id), leader_name: 'Nombre Nuevo', leader_phone: '0414-000.00.01', leader_birth_date: '1985-11-05', co_leader_name: 'Pareja Uno',
      meeting_day: 'Lunes', meeting_time: '18:00', place: 'Casa de prueba', photo_data: dataUrl(fakeJpeg(3)),
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /ya quedaron actualizados/);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_name, 'Nombre Nuevo');
    assert.equal(row.leader_birth_date, '1985-11-05');
    assert.equal(row.meeting_day, 'Lunes');
    assert.equal(row.name, 'Grupo Uno');
    assert.equal(row.token, g.token);
    assert.ok(row.profile_updated_at);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_photos WHERE group_id = $1', [g.id])).rows[0].n, 1);
    const sub = (await db.query('SELECT status, auto_applied, photo FROM care_group_submissions')).rows[0];
    assert.equal(sub.status, 'aplicada');
    assert.equal(sub.auto_applied, true);
    assert.equal(sub.photo, null); // la foto ya está en el grupo; no se duplica
    assert.equal((await get('/grupos/respuestas')).status, 200);
  });
});

test('si el teléfono no coincide queda pendiente, no toca el grupo, y al aprobarlo solo copia lo que vino lleno', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db, 'Grupo Dos', '584140000002', 'Líder Registrado');
    await db.query("UPDATE care_groups SET place = 'Lugar viejo', stage = 'Conquista' WHERE id = $1", [g.id]);
    const token = await tokenOf(db);
    const r = await post(`/registro/${token}`, { group_id: String(g.id), leader_name: 'Otra Persona', leader_phone: '0424-000.00.09', meeting_day: 'Jueves', photo_data: dataUrl(fakeJpeg()) });
    assert.match(await r.text(), /La iglesia los revisará/);
    const same = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(same.leader_name, 'Líder Registrado'); // intacto
    assert.equal(same.profile_updated_at, null);

    const list = await (await get('/grupos/respuestas')).text();
    assert.match(list, /Grupo Dos/);
    assert.match(list, /Otra Persona/);
    assert.match(list, /Aprobar y guardar/);
    assert.match(await (await get('/grupos')).text(), /1 respuesta de líderes por revisar/);
    const id = (await db.query('SELECT id FROM care_group_submissions')).rows[0].id;
    assert.equal((await get(`/grupos/respuestas/${id}/foto`)).status, 200);

    const ap = await post(`/grupos/respuestas/${id}/aplicar`);
    assert.equal(ap.status, 303);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_name, 'Otra Persona');
    assert.equal(row.leader_phone, '584240000009');
    assert.equal(row.meeting_day, 'Jueves');
    assert.equal(row.place, 'Lugar viejo'); // vacío en el envío: no se borra
    assert.equal(row.stage, 'Conquista');
    assert.ok(row.profile_updated_at);
    assert.equal((await get(`/grupos/respuestas/${id}/foto`)).status, 404); // ya atendida
    // aplicar dos veces no hace nada
    assert.match(loc(await post(`/grupos/respuestas/${id}/aplicar`)), /ya fue atendida/);
  });
});

test('un grupo que no está en la lista se crea al aprobar; si el nombre ya existe, no se duplica', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await mkGroup(db, 'Grupo Existente');
    const token = await tokenOf(db);
    await post(`/registro/${token}`, { group_id: 'otro', new_group_name: 'Grupo Nuevo de Prueba', leader_name: 'Líder Nuevo', leader_phone: '0414-000.00.05', place: 'Sede' });
    await post(`/registro/${token}`, { group_id: 'otro', new_group_name: 'GRUPO existente', leader_name: 'Otro', leader_phone: '0414-000.00.06' });
    const subs = (await db.query('SELECT id, new_group_name FROM care_group_submissions ORDER BY id')).rows;
    assert.equal(subs.length, 2);

    const ok = await post(`/grupos/respuestas/${subs[0].id}/aplicar`);
    assert.equal(ok.status, 303);
    const created = (await db.query("SELECT * FROM care_groups WHERE name = 'Grupo Nuevo de Prueba'")).rows[0];
    assert.equal(created.leader_name, 'Líder Nuevo');
    assert.equal(created.place, 'Sede');
    assert.match(created.token, /^[A-Za-z0-9_-]{16,}$/);

    const dup = await post(`/grupos/respuestas/${subs[1].id}/aplicar`);
    assert.match(loc(dup), /Ya existe un grupo/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_groups')).rows[0].n, 2); // no se creó otro
    assert.equal((await db.query('SELECT status FROM care_group_submissions WHERE id = $1', [subs[1].id])).rows[0].status, 'pendiente');

    await post(`/grupos/respuestas/${subs[1].id}/descartar`);
    assert.equal((await db.query('SELECT status FROM care_group_submissions WHERE id = $1', [subs[1].id])).rows[0].status, 'descartada');
  });
});

test('envíos malos: 400, nada se guarda y la foto buena se conserva; trampa para robots', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const g = await mkGroup(db, 'Grupo Tres', '584140000003');
    const token = await tokenOf(db);
    const count = async () => (await db.query('SELECT count(*)::int AS n FROM care_group_submissions')).rows[0].n;

    const noGroup = await post(`/registro/${token}`, { leader_name: 'X', leader_phone: '0414-000.00.03' });
    assert.equal(noGroup.status, 400);
    assert.match(await noGroup.text(), /Elige tu grupo/);
    const fake = await post(`/registro/${token}`, { group_id: '999999', leader_name: 'X', leader_phone: '0414-000.00.03' });
    assert.equal(fake.status, 400);
    const noPhone = await post(`/registro/${token}`, { group_id: String(g.id), leader_name: 'X' });
    assert.equal(noPhone.status, 400);
    assert.match(await noPhone.text(), /teléfono/);
    const noName = await post(`/registro/${token}`, { group_id: 'otro', leader_name: 'X', leader_phone: '0414-000.00.03' });
    assert.match(await noName.text(), /nombre de tu grupo/);
    const badDate = await post(`/registro/${token}`, { group_id: String(g.id), leader_name: 'X', leader_phone: '0414-000.00.03', leader_birth_date: '2999-01-01', photo_data: dataUrl(fakeJpeg()) });
    assert.equal(badDate.status, 400);
    assert.ok((await badDate.text()).includes(dataUrl(fakeJpeg()).slice(0, 80)));
    assert.equal((await post(`/registro/${token}`, { group_id: String(g.id), leader_name: 'X', leader_phone: '0414-000.00.03', photo_data: 'data:image/png;base64,AAAA' })).status, 400);
    assert.equal(await count(), 0);

    const bot = await post(`/registro/${token}`, { group_id: String(g.id), leader_name: 'Spam', leader_phone: '0414-000.00.03', web: 'x' });
    assert.equal(bot.status, 200);
    assert.equal(await count(), 0);
  });
});

test('borrar un grupo borra sus respuestas (cascada) y las páginas del panel escapan el texto', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db, 'Grupo Cuatro', '584140000004');
    const token = await tokenOf(db);
    await post(`/registro/${token}`, { group_id: String(g.id), leader_name: '<img src=x onerror=alert(1)>', leader_phone: '0424-000.00.08' });
    const html = await (await get('/grupos/respuestas')).text();
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;img/);
    await db.query('DELETE FROM care_groups WHERE id = $1', [g.id]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_submissions')).rows[0].n, 0);
  });
});
