'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const intake = require('../src/care-intake');
const { CONGREGATIONS } = require('../src/care-groups');
const { careIntakeRouter } = require('../src/routes/care-intake');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
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
const mkGroup = async (db, name, phone = '', leader = 'Líder Registrado', congregation = '') =>
  (await db.query('INSERT INTO care_groups (name, leader_name, leader_phone, congregation, token) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, leader, phone, congregation, `tok${Math.random().toString(36).slice(2).padEnd(18, 'x')}`])).rows[0];
const tokenOf = async (db) => (await intake.ensureToken(db)).token;
const base = { leader_name: 'Líder X', leader_phone: '0414-000.00.01', congregation: 'Mujeres' };

test('reconocer el grupo por el teléfono: uno solo, varios (desempatan nombre o congregación) o ninguno', () => {
  const groups = [
    { id: 1, name: 'Mujeres · Ana', leader_phone: '584140000001', congregation: 'Mujeres' },
    { id: 2, name: 'Jóvenes · Hombres', leader_phone: '584140000002', congregation: 'Jóvenes' },
    { id: 3, name: 'Jóvenes · Chicas', leader_phone: '584140000002', congregation: 'Jóvenes' },
    { id: 4, name: 'Matrimonios · Pablo', leader_phone: '584140000003', congregation: 'Matrimonios' },
    { id: 5, name: 'Mujeres · Pablo', leader_phone: '584140000003', congregation: 'Mujeres' },
  ];
  const parse = (extra) => intake.parseSubmission({ ...base, ...extra }, groups, '58', TODAY);
  assert.equal(parse({}).groupId, 1);
  assert.equal(parse({ leader_phone: '0414-000.00.02', congregation: 'Jóvenes' }).groupId, null); // dos grupos iguales: ambiguo
  assert.equal(parse({ leader_phone: '0414-000.00.02', congregation: 'Jóvenes', group_name: 'jóvenes · chicas' }).groupId, 3); // lo desempata el nombre
  assert.equal(parse({ leader_phone: '0414-000.00.03', congregation: 'Matrimonios' }).groupId, 4); // lo desempata la congregación
  assert.equal(parse({ leader_phone: '0424-999.99.99' }).groupId, null); // teléfono desconocido
  const nuevo = parse({ leader_phone: '0424-999.99.99', congregation: 'Hombres', group_name: ' Grupo   Nuevo ' });
  assert.equal(nuevo.newGroupName, 'Grupo Nuevo');
  assert.equal(parse({ leader_phone: '0424-999.99.99', congregation: 'Hombres' }).newGroupName, 'Hombres · Líder X');
});

test('la congregación es obligatoria y solo vale una de la lista', () => {
  assert.deepEqual(CONGREGATIONS, ['Niños', 'Adolescentes', 'Jóvenes', 'Jóvenes adultos', 'Matrimonios', 'Mujeres', 'Hombres']);
  const parse = (extra) => intake.parseSubmission({ ...base, ...extra }, [], '58', TODAY);
  assert.deepEqual(parse({}).errors, []);
  assert.ok(parse({ congregation: '' }).errors.includes('Elige tu congregación.'));
  assert.ok(parse({ congregation: 'Inventada' }).errors.includes('Elige tu congregación.'));
  assert.ok(parse({ leader_phone: '' }).errors.some((e) => /teléfono/.test(e)));
  assert.ok(parse({ leader_name: '' }).errors.some((e) => /nombre del líder/.test(e)));
});

test('el formulario común pide la congregación, no lista grupos ni teléfonos, y rechaza enlaces malos o apagados', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await mkGroup(db, 'Grupo Secreto', '584140000001');
    const token = await tokenOf(db);

    const r = await get(`/registro/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /¿Cuál es tu congregación\?/);
    for (const c of CONGREGATIONS) assert.ok(html.includes(`<option >${c}</option>`) || html.includes(`>${c}</option>`), c);
    assert.ok(!html.includes('¿Cuál es tu grupo?'));
    assert.ok(!html.includes('Grupo Secreto')); // ya no se muestran los grupos
    assert.ok(!html.includes('584140000001') && !html.includes('0414-000.00.01'));
    assert.match(html, /capture="user"/);

    assert.equal((await get('/registro/zzzzzzzzzzzzzzzzzzzz')).status, 404);
    assert.equal((await get('/registro/corto')).status, 404);
    assert.equal((await post('/registro/zzzzzzzzzzzzzzzzzzzz', base)).status, 404);

    await post('/grupos/enlace-comun/desactivar');
    assert.equal((await get(`/registro/${token}`)).status, 404);
    await post('/grupos/enlace-comun/activar');
    assert.equal((await get(`/registro/${token}`)).status, 200);
    await post('/grupos/enlace-comun/nuevo');
    assert.equal((await get(`/registro/${token}`)).status, 404);
    assert.equal((await get(`/registro/${await tokenOf(db)}`)).status, 200);
  });
});

test('con el teléfono del líder, los datos y la foto se aplican solos al grupo y se guarda su congregación', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db, 'Grupo Uno', '584140000001', 'Nombre Viejo');
    const token = await tokenOf(db);
    const r = await post(`/registro/${token}`, {
      ...base, leader_name: 'Nombre Nuevo', leader_birth_date: '1985-11-05', co_leader_name: 'Pareja Uno', meeting_day: 'Lunes', meeting_time: '18:00', place: 'Casa de prueba', photo_data: dataUrl(fakeJpeg(3)),
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /ya quedaron actualizados/);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_name, 'Nombre Nuevo');
    assert.equal(row.congregation, 'Mujeres');
    assert.equal(row.leader_birth_date, '1985-11-05');
    assert.equal(row.meeting_day, 'Lunes');
    assert.equal(row.name, 'Grupo Uno'); // el nombre del grupo no cambia
    assert.equal(row.token, g.token);
    assert.ok(row.profile_updated_at);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_photos WHERE group_id = $1', [g.id])).rows[0].n, 1);
    const sub = (await db.query('SELECT status, auto_applied, photo FROM care_group_submissions')).rows[0];
    assert.deepEqual([sub.status, sub.auto_applied, sub.photo], ['aplicada', true, null]);
    assert.equal((await get('/grupos/respuestas')).status, 200);
  });
});

test('con un teléfono desconocido queda pendiente; se aprueba como grupo nuevo o asignada a un grupo existente', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db, 'Grupo Dos', '584140000002', 'Líder Registrado');
    await db.query("UPDATE care_groups SET place = 'Lugar viejo', stage = 'Conquista' WHERE id = $1", [g.id]);
    const token = await tokenOf(db);

    // 1) el líder cambió de número: se asigna a su grupo existente desde el panel
    const r = await post(`/registro/${token}`, { ...base, leader_name: 'Otra Persona', leader_phone: '0424-000.00.09', meeting_day: 'Jueves', group_name: 'Grupo Dos', photo_data: dataUrl(fakeJpeg()) });
    assert.match(await r.text(), /La iglesia los revisará/);
    const same = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(same.leader_name, 'Líder Registrado'); // intacto hasta que se apruebe
    assert.equal(same.profile_updated_at, null);

    const list = await (await get('/grupos/respuestas')).text();
    assert.match(list, /Otra Persona/);
    assert.match(list, /Es el grupo: Grupo Dos/);
    assert.match(await (await get('/grupos')).text(), /1 respuesta de líderes por revisar/);
    const id = (await db.query('SELECT id FROM care_group_submissions')).rows[0].id;
    assert.equal((await get(`/grupos/respuestas/${id}/foto`)).status, 200);

    const ap = await post(`/grupos/respuestas/${id}/aplicar`, { group_id: String(g.id) });
    assert.equal(ap.status, 303);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_name, 'Otra Persona');
    assert.equal(row.leader_phone, '584240000009');
    assert.equal(row.meeting_day, 'Jueves');
    assert.equal(row.place, 'Lugar viejo'); // vacío en el envío: no se borra
    assert.equal(row.stage, 'Conquista');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_groups')).rows[0].n, 1);
    assert.equal((await get(`/grupos/respuestas/${id}/foto`)).status, 404); // ya atendida
    assert.match(loc(await post(`/grupos/respuestas/${id}/aplicar`, { group_id: 'nuevo' })), /ya fue atendida/);

    // 2) un grupo nuevo: se crea con el nombre que escribió
    await post(`/registro/${token}`, { ...base, leader_phone: '0414-000.00.05', congregation: 'Hombres', group_name: 'Grupo Nuevo de Prueba', place: 'Sede' });
    const nid = (await db.query("SELECT id FROM care_group_submissions WHERE status = 'pendiente'")).rows[0].id;
    await post(`/grupos/respuestas/${nid}/aplicar`, { group_id: 'nuevo' });
    const created = (await db.query("SELECT * FROM care_groups WHERE name = 'Grupo Nuevo de Prueba'")).rows[0];
    assert.equal(created.congregation, 'Hombres');
    assert.equal(created.place, 'Sede');
    assert.match(created.token, /^[A-Za-z0-9_-]{16,}$/);
  });
});

test('un grupo nuevo con un nombre que ya existe no se duplica; se puede descartar; dos grupos del mismo teléfono van a revisión', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await mkGroup(db, 'Grupo Existente', '584140000009');
    await mkGroup(db, 'Jóvenes · Hombres', '584140000010', 'Carlos', 'Jóvenes');
    await mkGroup(db, 'Jóvenes · Chicas', '584140000010', 'Carlos', 'Jóvenes');
    const token = await tokenOf(db);
    await post(`/registro/${token}`, { ...base, leader_phone: '0424-000.00.77', group_name: 'GRUPO existente' });
    await post(`/registro/${token}`, { ...base, leader_phone: '0414-000.00.10', congregation: 'Jóvenes' }); // ambiguo
    const subs = (await db.query('SELECT id, group_id FROM care_group_submissions ORDER BY id')).rows;
    assert.equal(subs.length, 2);
    assert.equal(subs[1].group_id, null); // quedó para revisar

    const dup = await post(`/grupos/respuestas/${subs[0].id}/aplicar`, { group_id: 'nuevo' });
    assert.match(loc(dup), /Ya existe un grupo/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_groups')).rows[0].n, 3);
    assert.equal((await db.query('SELECT status FROM care_group_submissions WHERE id = $1', [subs[0].id])).rows[0].status, 'pendiente');

    await post(`/grupos/respuestas/${subs[0].id}/descartar`);
    assert.equal((await db.query('SELECT status FROM care_group_submissions WHERE id = $1', [subs[0].id])).rows[0].status, 'descartada');
    const gone = await post(`/grupos/respuestas/${subs[1].id}/aplicar`, { group_id: '999999' });
    assert.match(loc(gone), /ya no existe/);
  });
});

test('envíos malos: 400, nada se guarda y la foto buena se conserva; trampa para robots', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await mkGroup(db, 'Grupo Tres', '584140000003');
    const token = await tokenOf(db);
    const count = async () => (await db.query('SELECT count(*)::int AS n FROM care_group_submissions')).rows[0].n;

    const noCong = await post(`/registro/${token}`, { ...base, congregation: '' });
    assert.equal(noCong.status, 400);
    assert.match(await noCong.text(), /Elige tu congregación/);
    assert.equal((await post(`/registro/${token}`, { ...base, congregation: 'Inventada' })).status, 400);
    const noPhone = await post(`/registro/${token}`, { ...base, leader_phone: '' });
    assert.equal(noPhone.status, 400);
    assert.match(await noPhone.text(), /teléfono/);
    const badDate = await post(`/registro/${token}`, { ...base, leader_birth_date: '2999-01-01', photo_data: dataUrl(fakeJpeg()) });
    assert.equal(badDate.status, 400);
    assert.ok((await badDate.text()).includes(dataUrl(fakeJpeg()).slice(0, 80)));
    assert.equal((await post(`/registro/${token}`, { ...base, photo_data: 'data:image/png;base64,AAAA' })).status, 400);
    assert.equal(await count(), 0);

    const bot = await post(`/registro/${token}`, { ...base, leader_name: 'Spam', web: 'x' });
    assert.equal(bot.status, 200);
    assert.equal(await count(), 0);
  });
});

test('borrar un grupo borra sus respuestas (cascada) y el panel escapa el texto', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const token = await tokenOf(db);
    await post(`/registro/${token}`, { ...base, leader_name: '<img src=x onerror=alert(1)>', leader_phone: '0424-000.00.08' });
    const html = await (await get('/grupos/respuestas')).text();
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;img/);

    const g = await mkGroup(db, 'Grupo Cuatro', '584140000004');
    await db.query("INSERT INTO care_group_submissions (group_id, leader_name) VALUES ($1, 'A')", [g.id]);
    await db.query('DELETE FROM care_groups WHERE id = $1', [g.id]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_submissions WHERE group_id IS NOT NULL')).rows[0].n, 0);
  });
});
