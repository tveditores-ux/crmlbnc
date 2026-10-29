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
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });
const TODAY = day(0);

test('parseReport: cifras, ofrenda, fecha y total calculado', () => {
  const ok = cg.parseReport({ meeting_date: TODAY, members_count: '8', guests_count: '3', offering: '25,5', key_element: '  Amor  ' }, TODAY);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.attendance, 11);
  assert.equal(ok.value.offering, 25.5);
  assert.equal(ok.value.key_element, 'Amor');

  assert.ok(cg.parseReport({ meeting_date: day(5), attendance: '4' }, TODAY).errors.some((e) => /futura/.test(e)));
  assert.ok(cg.parseReport({ meeting_date: day(-90), attendance: '4' }, TODAY).errors.some((e) => /60 días/.test(e)));
  assert.ok(cg.parseReport({ meeting_date: TODAY }, TODAY).errors.some((e) => /cuántos asistieron/.test(e)));
  assert.ok(cg.parseReport({ meeting_date: TODAY, attendance: '-3' }, TODAY).errors.length);
  assert.ok(cg.parseReport({ meeting_date: TODAY, attendance: '4', offering: 'mucho' }, TODAY).errors.some((e) => /ofrenda/.test(e)));
  assert.equal(cg.parseReport({ meeting_date: 'ayer', attendance: '4' }, TODAY).errors.length, 1);
});

test('parseGroup: exige nombre, normaliza el teléfono y descarta valores desconocidos', () => {
  assert.ok(cg.parseGroup({}).errors.length);
  const g = cg.parseGroup({ name: ' GdC Norte ', leader_phone: '0414-000.00.01', meeting_day: 'Lunes', stage: 'Inventada', meeting_time: '25:99' });
  assert.deepEqual(g.errors, []);
  assert.equal(g.value.name, 'GdC Norte');
  assert.equal(g.value.leader_phone, '584140000001');
  assert.equal(g.value.meeting_day, 'Lunes');
  assert.equal(g.value.stage, '');
  assert.equal(g.value.meeting_time, '');
  assert.ok(cg.parseGroup({ name: 'X', leader_phone: '12' }).errors.length);
});

test('daysSince', () => {
  assert.equal(cg.daysSince(null, TODAY), null);
  assert.equal(cg.daysSince(day(-9), TODAY), 9);
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(careRemoteRouter({ db: h.db, config }));
  app.use(careGroupsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}

// el formulario "Datos del grupo" exige nombre, teléfono, correo, líder asesor y foto
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7), Buffer.from([0xff, 0xd9])]).toString('base64')}`;
const required = { leader_name: 'Líder Obligatorio', leader_cedula: 'V-12345678', leader_address: 'Calle de prueba 1', leader_phone: '0414-000.00.01', leader_email: 'lider@ejemplo.com', advisor_name: 'Asesor Uno', photo_data: JPEG };

const newGroup = async (post, db, extra = {}) => {
  const r = await post('/grupos', { name: 'GdC Prueba', leader_name: 'Líder Uno', ...extra });
  assert.equal(r.status, 303);
  return (await db.query('SELECT * FROM care_groups ORDER BY id DESC LIMIT 1')).rows[0];
};

test('crear grupo, abrir su enlace, reportar y ver el reporte en el panel', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db, { leader_phone: '0414-000.00.01', meeting_day: 'Martes' });
    assert.match(g.token, /^[A-Za-z0-9_-]{16,}$/);

    const form = await get(`/g/${g.token}`);
    assert.equal(form.status, 200);
    assert.equal(form.headers.get('cache-control'), 'no-store');
    assert.match(await form.text(), /GdC Prueba/);

    const sent = await post(`/g/${g.token}`, { meeting_date: TODAY, members_count: '7', guests_count: '2', offering: '10', testimonies: 'Dios <b>sanó</b>', followup: 'Llamar a Pedro' });
    assert.equal(sent.status, 200);
    assert.match(await sent.text(), /Reporte recibido/);

    // reenviar la misma fecha corrige, no duplica
    const again = await post(`/g/${g.token}`, { meeting_date: TODAY, members_count: '8', guests_count: '2' });
    assert.match(await again.text(), /Reporte corregido/);
    const rows = (await db.query('SELECT * FROM care_group_reports')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attendance, 10);
    assert.equal(rows[0].source, 'telefono');
    assert.equal((await db.query('SELECT uses FROM care_groups WHERE id=$1', [g.id])).rows[0].uses, 2);

    const detail = await (await get(`/grupos/${g.id}`)).text();
    assert.match(detail, /GdC Prueba/);
    assert.match(detail, new RegExp(`/g/${g.token}`));

    const list = await (await get('/grupos')).text();
    assert.match(list, /Al día/);
  });
});

test('el reporte rechaza datos malos con 400 y no guarda nada; el texto se escapa', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db);
    const bad = await post(`/g/${g.token}`, { meeting_date: TODAY, notes: '<script>x</script>' });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.ok(!html.includes('<script>x</script>'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 0);

    await post(`/g/${g.token}`, { meeting_date: TODAY, attendance: '5', notes: '<img src=x onerror=alert(1)>' });
    const detail = await (await get(`/grupos/${g.id}`)).text();
    assert.ok(!detail.includes('<img src=x'));
    assert.match(detail, /&lt;img/);
  });
});

test('trampa para robots y enlaces inválidos, desactivados, regenerados', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db);
    assert.equal((await get('/g/zzzzzzzzzzzzzzzzzzzz')).status, 404);
    assert.equal((await get('/g/corto')).status, 404);

    const bot = await post(`/g/${g.token}`, { meeting_date: TODAY, attendance: '5', web: 'spam' });
    assert.equal(bot.status, 200);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 0);

    await post(`/grupos/${g.id}/enlace/desactivar`);
    assert.equal((await get(`/g/${g.token}`)).status, 404);
    await post(`/grupos/${g.id}/enlace/activar`);
    assert.equal((await get(`/g/${g.token}`)).status, 200);

    await post(`/grupos/${g.id}/enlace/nuevo`);
    assert.equal((await get(`/g/${g.token}`)).status, 404); // el anterior ya no sirve
    const fresh = (await db.query('SELECT token FROM care_groups WHERE id=$1', [g.id])).rows[0].token;
    assert.notEqual(fresh, g.token);
    assert.equal((await get(`/g/${fresh}`)).status, 200);

    await post(`/grupos/${g.id}/desactivar`);
    assert.equal((await get(`/g/${fresh}`)).status, 404); // grupo inactivo: tampoco recibe reportes
  });
});

test('grupo sin reportes aparece pendiente; los inactivos no cuentan; el CSV neutraliza fórmulas', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const a = await newGroup(post, db, { name: 'Grupo Sin Reportar' });
    const b = await newGroup(post, db, { name: 'Grupo Inactivo' });
    await post(`/grupos/${b.id}/desactivar`);
    const html = await (await get('/grupos')).text();
    assert.match(html, /Sin reportes/);
    assert.match(html, /Inactivo/);

    await db.query(`INSERT INTO care_group_reports (group_id, meeting_date, attendance, notes) VALUES ($1, $2, 5, '=1+1')`, [a.id, day(-20)]);
    const stale = await (await get('/grupos')).text();
    assert.match(stale, /Hace 20 días/);

    const csv = await (await get('/grupos/reportes.csv')).text();
    assert.match(csv, /Grupo Sin Reportar/);
    assert.ok(csv.includes("'=1+1"));
  });
});

test('editar y validar el grupo; borrar el grupo borra sus reportes (cascada)', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db);
    const bad = await post(`/grupos/${g.id}/editar`, { name: '' });
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /Escribe el nombre del grupo/);

    const ok = await post(`/grupos/${g.id}/editar`, { name: 'GdC Renombrado', stage: 'Conquista' });
    assert.equal(ok.status, 303);
    const row = (await db.query('SELECT * FROM care_groups WHERE id=$1', [g.id])).rows[0];
    assert.equal(row.name, 'GdC Renombrado');
    assert.equal(row.token, g.token); // editar no cambia el enlace

    await db.query(`INSERT INTO care_group_reports (group_id, meeting_date, attendance) VALUES ($1, $2, 3)`, [g.id, TODAY]);
    await db.query('DELETE FROM care_groups WHERE id=$1', [g.id]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 0);
    assert.equal((await get('/grupos/999999')).status, 303);
  });
});

test('importar grupos desde CSV: revisar no guarda, importar crea con enlace, repetir actualiza sin pisar datos ni cambiar el enlace', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    assert.equal((await get('/grupos/importar')).status, 200);
    const csv = ['Grupo,Líder,Teléfono,Día,Hora,Etapa', 'GdC Uno,Líder A,0414-000.00.01,Lunes,19:00,Conquista', 'gdc dos,Líder B,,Martes,,'].join('\n');

    const dry = await post('/grupos/importar', { csv, accion: 'revisar' });
    assert.match(await dry.text(), /2 grupos nuevos/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_groups')).rows[0].n, 0);

    const done = await post('/grupos/importar', { csv, accion: 'importar' });
    assert.equal(done.status, 303);
    const rows = (await db.query('SELECT * FROM care_groups ORDER BY id')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].leader_phone, '584140000001');
    assert.ok(rows.every((g) => /^[A-Za-z0-9_-]{16,}$/.test(g.token) && g.link_active));

    // segunda vez: otro orden de columnas, mayúsculas distintas, campos vacíos no borran
    const again = ['GRUPO,Etapa,Líder', 'GDC UNO,Equipo,', 'Gdc Tres,,Líder C'].join('\n');
    await post('/grupos/importar', { csv: again, accion: 'importar' });
    const after = (await db.query('SELECT * FROM care_groups ORDER BY id')).rows;
    assert.equal(after.length, 3);
    assert.equal(after[0].stage, 'Equipo');
    assert.equal(after[0].leader_name, 'Líder A'); // vacío en el archivo: no se borra
    assert.equal(after[0].meeting_day, 'Lunes');
    assert.equal(after[0].token, rows[0].token); // el enlace no cambia
  });
});

test('importar grupos: una fila mala cancela todo y se explican los problemas', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const csv = ['Grupo,Teléfono,Día,Etapa', 'Buen Grupo,,Lunes,', 'Mal Grupo,12,Funday,Inventada', 'Buen Grupo,,,', ',,,'].join('\n');
    const r = await post('/grupos/importar', { csv, accion: 'importar' });
    const html = await r.text();
    assert.match(html, /problemas/);
    assert.match(html, /teléfono/);
    assert.match(html, /día no es válido/);
    assert.match(html, /repetido/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_groups')).rows[0].n, 0);

    const noName = await post('/grupos/importar', { csv: 'Líder,Día\nAlguien,Lunes', accion: 'importar' });
    assert.match(await noName.text(), /Falta la columna/);
  });
});

test('el líder confirma los datos de su grupo desde su enlace y llegan a la ficha; el nombre del grupo no cambia', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db, { name: 'GdC Datos', leader_name: 'Viejo Nombre' });
    const T = `/g/${g.token}/datos`;
    const form = await get(T);
    assert.equal(form.status, 200);
    assert.equal(form.headers.get('cache-control'), 'no-store');
    assert.match(await form.text(), /Viejo Nombre/);
    assert.equal(g.profile_updated_at, null);

    const ok = await post(T, { ...required, name: 'Intento de renombrar', leader_name: 'Líder Nuevo', leader_phone: '0414-000.00.07', meeting_day: 'Jueves', meeting_time: '18:30', place: 'Casa de prueba', stage: 'Equipo', congregation: 'Mujeres' });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Datos del grupo guardados/);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.name, 'GdC Datos');
    assert.equal(row.leader_name, 'Líder Nuevo');
    assert.equal(row.leader_phone, '584140000007');
    assert.equal(row.meeting_day, 'Jueves');
    assert.equal(row.meeting_time, '18:30');
    assert.equal(row.congregation, 'Mujeres');
    assert.equal(row.advisor_name, 'Asesor Uno');
    assert.equal(row.leader_cedula, 'V-12345678');
    assert.equal(row.leader_address, 'Calle de prueba 1');
    assert.equal(row.token, g.token);
    assert.ok(row.profile_updated_at);

    const again = await (await get(T)).text();
    assert.match(again, /0414-000\.00\.07/);
    assert.match(again, /Ya confirmaste/);
    const list = await (await get('/grupos')).text();
    assert.match(list, /Confirmados/);
  });
});

test('datos del grupo: obligatorios (líder, teléfono, correo, asesor, foto), teléfono válido, robots, enlace caído; no guarda nada si falla', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db, { name: 'GdC Datos 2', leader_name: 'Líder Original' });
    const T = `/g/${g.token}/datos`;
    const noLeader = await post(T, { leader_name: '' });
    assert.equal(noLeader.status, 400);
    assert.match(await noLeader.text(), /nombre y apellido/);
    const oneWord = await post(T, { ...required, leader_name: 'Solonombre' });
    assert.equal(oneWord.status, 400);
    assert.match(await oneWord.text(), /nombre y el apellido/);
    const badPhone = await post(T, { ...required, leader_phone: '12' });
    assert.equal(badPhone.status, 400);
    for (const [field, msg] of [['leader_phone', /teléfono/], ['leader_email', /correo/], ['advisor_name', /líder asesor/], ['leader_cedula', /cédula/], ['leader_address', /dirección del líder/], ['photo_data', /Falta la foto/]]) {
      const r = await post(T, { ...required, [field]: '' });
      assert.equal(r.status, 400, field);
      assert.match(await r.text(), msg);
    }
    // con una foto ya guardada, reenviar sin foto nueva sí vale
    await db.query('INSERT INTO care_group_photos (group_id, data) VALUES ($1, $2)', [g.id, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
    const keep = await post(T, { ...required, photo_data: '' });
    assert.equal(keep.status, 200);
    await db.query('DELETE FROM care_group_photos WHERE group_id = $1', [g.id]);
    await db.query("UPDATE care_groups SET leader_name = 'Líder Original', profile_updated_at = NULL WHERE id = $1", [g.id]);
    const bot = await post(T, { leader_name: 'Spam', web: 'x' });
    assert.equal(bot.status, 200);
    const row = (await db.query('SELECT * FROM care_groups WHERE id = $1', [g.id])).rows[0];
    assert.equal(row.leader_name, 'Líder Original');
    assert.equal(row.profile_updated_at, null);

    await post(`/grupos/${g.id}/enlace/desactivar`);
    assert.equal((await get(T)).status, 404);
    assert.equal((await post(T, { leader_name: 'Otro' })).status, 404);
  });
});

test('página de solicitud: un enlace común para todos, estado por grupo, y sin grupos inactivos', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await newGroup(post, db, { name: 'Grupo A', leader_name: 'Líder A', leader_phone: '0414-000.00.01' });
    await newGroup(post, db, { name: 'Grupo B', leader_name: 'Líder B' });
    const c = await newGroup(post, db, { name: 'Grupo C' });
    await post(`/grupos/${c.id}/desactivar`);
    const html = await (await get('/grupos/solicitud')).text();
    assert.match(html, /Grupo A/);
    assert.match(html, /Grupo B/);
    assert.ok(!html.includes('Grupo C'));
    assert.match(html, /\/registro\/[A-Za-z0-9_-]{16,}/); // el enlace común
    assert.ok(!html.includes('/datos')); // ya no se reparte un enlace distinto por grupo
    assert.match(html, /data-phone="584140000001"/);
    assert.match(html, /Sin teléfono/); // el grupo B no tiene
    assert.match(html, /2 de 2 grupos aún no confirman/);
    assert.match(html, /{nombre}/);
  });
});
