'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const intake = require('../src/member-intake');
const { mergePeople } = require('../src/people-merge');
const { memberIntakeRouter } = require('../src/routes/member-intake');
const { memberRequestsRouter, memberDataCard } = require('../src/routes/member-requests');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const fakeJpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, fill), Buffer.from([0xff, 0xd9])]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

// lo obligatorio: nombre y apellido, teléfono, nacimiento (tres selectores) y congregación
const base = { full_name: 'Ana Pérez', phone: '0414-000.00.01', bd_day: '05', bd_month: '11', bd_year: '1985', congregation: 'Mujeres' };

test('validación: obligatorios, formatos y lo opcional', () => {
  const parse = (extra) => intake.parseSubmission({ ...base, ...extra }, ['Grupo Uno'], '58', TODAY);
  const ok = parse({});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.phone, '584140000001');
  assert.equal(ok.value.birth_date, '1985-11-05');
  assert.equal(ok.value.wants_messages, false);

  assert.ok(parse({ full_name: '' }).errors.includes('Escribe tu nombre y apellido.'));
  assert.ok(parse({ full_name: 'Solonombre' }).errors.includes('Escribe tu nombre y tu apellido.'));
  assert.ok(parse({ phone: '' }).errors.some((e) => /teléfono/.test(e)));
  assert.ok(parse({ phone: '12' }).errors.some((e) => /no parece válido/.test(e)));
  assert.ok(parse({ congregation: '' }).errors.includes('Elige tu congregación.'));
  assert.ok(parse({ congregation: 'Inventada' }).errors.includes('Elige tu congregación.'));
  assert.ok(parse({ bd_day: '', bd_month: '', bd_year: '' }).errors.includes('Elige tu fecha de nacimiento.'));
  assert.ok(parse({ bd_day: '5', bd_month: '', bd_year: '1985' }).errors.some((e) => /Completa el día, el mes y el año/.test(e)));
  assert.ok(parse({ bd_day: '31', bd_month: '02', bd_year: '1985' }).errors.some((e) => /no existe/.test(e)));
  // opcionales: cédula (se normaliza), correo, estado civil y grupo (solo uno de la lista)
  const full = parse({ cedula: 'v 12.345.678', email: 'Ana@Ejemplo.com', civil_status: 'Casado(a)', care_group_name: 'Grupo Uno', wants_messages: '1' });
  assert.deepEqual(full.errors, []);
  assert.equal(full.value.cedula, 'V-12345678');
  assert.equal(full.value.email, 'ana@ejemplo.com');
  assert.equal(full.value.care_group_name, 'Grupo Uno');
  assert.equal(full.value.wants_messages, true);
  assert.equal(parse({ care_group_name: 'Grupo Inventado' }).value.care_group_name, '');
  assert.equal(parse({ civil_status: 'Inventado' }).value.civil_status, '');
  assert.ok(parse({ cedula: 'abc' }).errors.some((e) => /cédula/i.test(e)));
  assert.ok(parse({ email: 'no-es-correo' }).errors.some((e) => /correo/.test(e)));
  assert.ok(parse({ photo_data: 'data:image/png;base64,AAAA' }).errors.length);
  assert.equal(parse({ photo_data: '' }).photo.buffer, null); // la foto es opcional
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(memberIntakeRouter({ db: h.db, config }));
  app.use(memberRequestsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const b = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(b + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(fields)), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

const tokenOf = async (db) => (await intake.ensureToken(db)).token;
const person = async (db, phone) => (await db.query('SELECT * FROM people WHERE phone = $1', [phone])).rows[0];
const count = async (db, table, where = '') => (await db.query(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;

test('el formulario público: pide los datos, lista solo nombres de grupos, y rechaza enlaces malos o apagados', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await db.query("INSERT INTO care_groups (name, leader_name, leader_phone, token) VALUES ('Grupo Visible', 'Líder Secreto', '584149990001', 'tokengrupo1234567890')");
    const token = await tokenOf(db);
    const r = await get(`/mis-datos/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /<label for="full_name">Nombre y apellido<\/label>/);
    assert.match(html, /¿Cuál es tu congregación\?/);
    assert.match(html, /Grupo Visible/);
    assert.match(html, /Todavía no estoy en un grupo/);
    for (const n of ['bd_day', 'bd_month', 'bd_year']) assert.match(html, new RegExp(`<select name="${n}"`));
    assert.match(html, /Fecha de nacimiento<\/label>/);
    assert.ok(!html.includes('Líder Secreto') && !html.includes('584149990001') && !html.includes('tokengrupo')); // ningún dato de los grupos, solo el nombre
    assert.match(html, /capture="user"/);
    assert.ok(!html.includes('La foto es obligatoria')); // aquí la foto es opcional
    assert.match(html, /Quiero recibir recordatorios/);

    assert.equal((await get('/mis-datos/zzzzzzzzzzzzzzzzzzzz')).status, 404);
    assert.equal((await get('/mis-datos/corto')).status, 404);
    assert.equal((await post('/mis-datos/zzzzzzzzzzzzzzzzzzzz', base)).status, 404);
    await post('/personas/solicitud/enlace/desactivar');
    assert.equal((await get(`/mis-datos/${token}`)).status, 404);
    await post('/personas/solicitud/enlace/activar');
    assert.equal((await get(`/mis-datos/${token}`)).status, 200);
    await post('/personas/solicitud/enlace/nuevo');
    assert.equal((await get(`/mis-datos/${token}`)).status, 404); // el anterior ya no sirve
    assert.equal((await get(`/mis-datos/${await tokenOf(db)}`)).status, 200);
  });
});

test('una persona nueva queda pendiente y no entra a Personas hasta que se apruebe; se crea sin consentimiento y sin clasificar', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const token = await tokenOf(db);
    const r = await post(`/mis-datos/${token}`, { ...base, cedula: 'V-12345678', address: 'Calle de prueba 1', civil_status: 'Casado(a)', email: 'ana@ejemplo.com', wants_messages: '1', photo_data: dataUrl(fakeJpeg(4)) });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /La iglesia los revisará/);
    assert.equal(await count(db, 'people'), 0); // todavía no existe
    assert.equal((await db.query('SELECT person_id FROM member_submissions')).rows[0].person_id, null);

    const list = await (await get('/personas/respuestas')).text();
    assert.match(list, /Ana Pérez/);
    assert.match(list, /Persona nueva/);
    assert.match(list, /V-12345678/); // el administrador sí ve la cédula al revisar
    assert.match(list, /Aprobar y crear la persona/);
    assert.match(list, /También registrar que aceptó recibir recordatorios/);
    const id = (await db.query('SELECT id FROM member_submissions')).rows[0].id;
    assert.equal((await get(`/personas/respuestas/${id}/foto`)).status, 200);

    const ok = await post(`/personas/respuestas/${id}/aplicar`, {}); // sin marcar el consentimiento
    assert.equal(ok.status, 303);
    const p = await person(db, '584140000001');
    assert.equal(p.full_name, 'Ana Pérez');
    assert.equal(p.email, 'ana@ejemplo.com');
    assert.equal(p.cedula, 'V-12345678');
    assert.equal(p.birth_date, '1985-11-05');
    assert.equal(p.address, 'Calle de prueba 1');
    assert.equal(p.congregation, 'Mujeres');
    assert.deepEqual([p.opt_in, p.active, p.membership, p.in_official_group], [false, true, '', false]);
    assert.ok(p.profile_updated_at);
    assert.equal(await count(db, 'people_photos'), 1);
    assert.equal((await get(`/personas/${p.id}/foto`)).status, 200);
    assert.equal((await get('/personas/999999/foto')).status, 404);
    // lo sensible se borra de la respuesta ya atendida
    const done = (await db.query('SELECT * FROM member_submissions')).rows[0];
    assert.deepEqual([done.status, done.cedula, done.address, done.birth_date, done.photo], ['aplicada', '', '', '', null]);
    assert.match(await (await get(`/personas/respuestas`)).text(), /No hay respuestas pendientes/);
  });
});

test('el consentimiento solo se registra si la persona lo pidió Y quien revisa lo marca', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const token = await tokenOf(db);
    await post(`/mis-datos/${token}`, { ...base, wants_messages: '1' });
    await post(`/mis-datos/${token}`, { ...base, full_name: 'Luis Rojas', phone: '0414-000.00.02' }); // no lo pidió
    const [a, b] = (await db.query('SELECT id FROM member_submissions ORDER BY id')).rows;
    await post(`/personas/respuestas/${a.id}/aplicar`, { consent: '1' });
    await post(`/personas/respuestas/${b.id}/aplicar`, { consent: '1' }); // marcó la casilla, pero la persona no lo pidió
    assert.equal((await person(db, '584140000001')).opt_in, true);
    assert.equal((await person(db, '584140000002')).opt_in, false);
  });
});

test('quien ya está en Personas y no trae nada distinto se completa sola, sin pisar su nombre ni tocar consentimiento, tipo ni grupo oficial', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await db.query("INSERT INTO people (full_name, phone, email, role, opt_in, active, membership, in_official_group) VALUES ('MARÍA  Pérez', '584140000001', 'maria@ejemplo.com', 'Líder', TRUE, TRUE, 'miembro', TRUE)");
    await db.query("INSERT INTO people (full_name, phone, opt_in, active) VALUES ('Sin Consentimiento', '584140000002', FALSE, TRUE)");
    const token = await tokenOf(db);

    const r = await post(`/mis-datos/${token}`, { ...base, full_name: 'maría pérez', email: '', cedula: 'V-12345678', address: 'Calle 1', wants_messages: '1', photo_data: dataUrl(fakeJpeg()) });
    assert.match(await r.text(), /Tus datos quedaron guardados/);
    const p = await person(db, '584140000001');
    assert.equal(p.full_name, 'MARÍA  Pérez'); // su nombre no se pisa
    assert.equal(p.email, 'maria@ejemplo.com');
    assert.deepEqual([p.cedula, p.address, p.birth_date, p.congregation], ['V-12345678', 'Calle 1', '1985-11-05', 'Mujeres']);
    assert.deepEqual([p.opt_in, p.role, p.membership, p.in_official_group, p.active], [true, 'Líder', 'miembro', true, true]);
    assert.ok(p.profile_updated_at);
    assert.equal(await count(db, 'people_photos'), 1);
    assert.equal(await count(db, 'people'), 2); // no duplicó a nadie
    assert.equal((await db.query('SELECT status, auto_applied FROM member_submissions')).rows[0].status, 'aplicada');

    // pidió recibir recordatorios, pero eso nunca se aplica solo
    await post(`/mis-datos/${token}`, { ...base, full_name: 'Sin Consentimiento', phone: '0414-000.00.02', wants_messages: '1' });
    assert.equal((await person(db, '584140000002')).opt_in, false);
  });
});

test('un dato distinto al de la ficha, o un correo que es de otra persona, espera revisión; descartar no cambia nada', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await db.query("INSERT INTO people (full_name, phone, email, address) VALUES ('Ana Pérez', '584140000001', 'ana@ejemplo.com', 'Dirección vieja')");
    await db.query("INSERT INTO people (full_name, phone, email) VALUES ('Otra Persona', '584140000009', 'ocupado@ejemplo.com')");
    const token = await tokenOf(db);

    // 1) dirección distinta: pendiente, la ficha sigue igual
    await post(`/mis-datos/${token}`, { ...base, address: 'Dirección nueva' });
    assert.equal((await person(db, '584140000001')).address, 'Dirección vieja');
    const html = await (await get('/personas/respuestas')).text();
    assert.match(html, /Ya está en Personas, con datos distintos/);
    assert.match(html, /Dirección vieja/);
    assert.match(html, /Dirección nueva/);
    const id1 = (await db.query('SELECT id FROM member_submissions ORDER BY id')).rows[0].id;
    await post(`/personas/respuestas/${id1}/aplicar`);
    assert.equal((await person(db, '584140000001')).address, 'Dirección nueva'); // al aprobar, lo enviado reemplaza

    // 2) correo de otra persona: no se aplica sola, y al aprobar se explica el problema sin cambiar nada
    await post(`/mis-datos/${token}`, { ...base, email: 'ocupado@ejemplo.com', address: 'Dirección nueva' });
    const id2 = (await db.query("SELECT id FROM member_submissions WHERE status = 'pendiente'")).rows[0].id;
    const bad = await post(`/personas/respuestas/${id2}/aplicar`);
    assert.match(loc(bad), /correo ya está en la ficha de otra persona/);
    assert.equal((await person(db, '584140000001')).email, 'ana@ejemplo.com');
    assert.equal((await db.query('SELECT status FROM member_submissions WHERE id = $1', [id2])).rows[0].status, 'pendiente');

    // 3) descartar: nada cambia y se limpia lo sensible
    await post(`/personas/respuestas/${id2}/descartar`);
    const d = (await db.query('SELECT status, cedula, address FROM member_submissions WHERE id = $1', [id2])).rows[0];
    assert.deepEqual([d.status, d.cedula, d.address], ['descartada', '', '']);
    assert.match(loc(await post(`/personas/respuestas/${id2}/aplicar`)), /ya fue atendida/);
  });
});

test('envíos malos: 400, nada se guarda y la foto buena se conserva; robots; el texto se escapa', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const token = await tokenOf(db);
    const bad = await post(`/mis-datos/${token}`, { ...base, bd_year: '', photo_data: dataUrl(fakeJpeg()) });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.match(html, /Completa el día, el mes y el año/);
    assert.ok(html.includes(dataUrl(fakeJpeg()).slice(0, 80))); // la foto sigue en el formulario
    assert.match(html, /<option value="05" selected>/); // y lo ya elegido
    assert.equal((await post(`/mis-datos/${token}`, { ...base, congregation: '' })).status, 400);
    assert.equal((await post(`/mis-datos/${token}`, { ...base, photo_data: 'data:image/png;base64,AAAA' })).status, 400);
    assert.equal(await count(db, 'member_submissions'), 0);

    assert.equal((await post(`/mis-datos/${token}`, { ...base, full_name: 'Spam Spam', web: 'x' })).status, 200);
    assert.equal(await count(db, 'member_submissions'), 0);

    await post(`/mis-datos/${token}`, { ...base, full_name: '<img src=x onerror=alert(1)> Pérez' });
    const list = await (await get('/personas/respuestas')).text();
    assert.ok(!list.includes('<img src=x'));
    assert.match(list, /&lt;img/);
  });
});

test('la ficha muestra lo que envió la persona; sin datos no muestra nada', () => {
  assert.equal(memberDataCard({ id: 1 }, false, 'America/Caracas'), '');
  const html = memberDataCard({ id: 7, birth_date: '1985-11-05', cedula: 'V-12345678', address: 'Calle <b>1</b>', civil_status: '', congregation: 'Mujeres', care_group_name: '', profile_updated_at: '2026-10-20T15:00:00Z' }, true, 'America/Caracas');
  assert.match(html, /Datos que envió la persona/);
  assert.match(html, /05\/11\/1985/);
  assert.match(html, /V-12345678/);
  assert.match(html, /Enviados el 20\/10\/2026/);
  assert.match(html, /\/personas\/7\/foto/);
  assert.ok(!html.includes('<b>1</b>'));
  assert.ok(!html.includes('Estado civil')); // lo vacío no se muestra
});

test('unir duplicados conserva los datos nuevos y la foto de la ficha que se elimina', async (t) => {
  await withApp(t, async ({ db }) => {
    const a = (await db.query("INSERT INTO people (full_name, phone) VALUES ('Ana Pérez', '584140000001') RETURNING id")).rows[0].id;
    const b = (await db.query("INSERT INTO people (full_name, phone, cedula, birth_date, address, congregation) VALUES ('Ana Perez', '584140000002', 'V-12345678', '1985-11-05', 'Calle 1', 'Mujeres') RETURNING id")).rows[0].id;
    await db.query('INSERT INTO people_photos (person_id, data) VALUES ($1, $2)', [b, fakeJpeg()]);
    await db.query("INSERT INTO member_submissions (person_id, full_name, phone) VALUES ($1, 'Ana Perez', '584140000002')", [b]);
    const out = await mergePeople(db, a, b);
    const keep = (await db.query('SELECT * FROM people WHERE id = $1', [out.keepId])).rows[0];
    assert.deepEqual([keep.cedula, keep.birth_date, keep.address, keep.congregation], ['V-12345678', '1985-11-05', 'Calle 1', 'Mujeres']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people_photos WHERE person_id = $1', [out.keepId])).rows[0].n, 1);
    assert.equal((await db.query('SELECT person_id FROM member_submissions')).rows[0].person_id, out.keepId);
  });
});
