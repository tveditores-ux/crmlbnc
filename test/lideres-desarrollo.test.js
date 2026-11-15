'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const intake = require('../src/ministry-leader-intake');
const { ministryLeaderIntakeRouter } = require('../src/routes/ministry-leader-intake');
const { ministryLeaderRequestsRouter } = require('../src/routes/ministry-leader-requests');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const fakeJpeg = (fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, fill), Buffer.from([0xff, 0xd9])]);
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;
const OPTIONS = ['Alabanza', 'Anfitriones', 'Diaconado', 'Intercesión', 'Medios', 'Nueva Vida'];
const GROUPS = [{ id: 7, name: 'Grupo Esperanza', leader_name: 'Ana Díaz' }];

// ministerio + grupo de cuidado + la ficha del líder + estado civil: todo obligatorio menos correo y foto (sin cargo)
const base = {
  ministerio: 'Alabanza', congregacional: 'No sirvo en ninguno', grupo_cuidado: 'ninguno', full_name: 'María Torres', phone: '0414-000.00.22', bd_day: '15', bd_month: '06', bd_year: '1990',
  cedula: 'V-19888777', address: 'Urbanización El Prado, casa 4', civil_status: 'Casado(a)', congregation: 'Mujeres',
};

test('validación: el ministerio de desarrollo y el grupo de cuidado mandan; la ficha es la del líder más el estado civil', () => {
  const parse = (extra) => intake.parseSubmission({ ...base, ...extra }, OPTIONS, GROUPS, '58', TODAY);
  const ok = parse({});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.phone, '584140000022');
  assert.equal(ok.value.ministerio, 'Alabanza');
  assert.deepEqual(ok.value.ministerios, ['Alabanza']);
  assert.equal(ok.value.congregacional, '');
  const varios = parse({ ministerio: ['Alabanza', 'Medios', 'Alabanza'] });
  assert.deepEqual(varios.errors, []);
  assert.deepEqual(varios.value.ministerios, ['Alabanza', 'Medios']); // más de un ministerio, sin repetir
  assert.ok(parse({ ministerio: [] }).errors.includes('Elige tu ministerio de desarrollo.'));
  assert.ok(parse({ ministerio: ['Alabanza', 'Evangelismo'] }).errors.includes('Elige tu ministerio de desarrollo.'));
  assert.equal(parse({ congregacional: 'Mujeres' }).value.congregacional, 'Mujeres');
  assert.ok(parse({ congregacional: '' }).errors.includes('Elige si sirves en un ministerio congregacional.'));
  assert.ok(parse({ congregacional: 'General' }).errors.includes('Elige si sirves en un ministerio congregacional.')); // «General» no es un ministerio
  assert.equal(ok.value.grupo_cuidado, ''); // «ninguno»: no asiste a un grupo de cuidado
  assert.equal(ok.value.grupo_cuidado_id, null);
  const conGrupo = parse({ grupo_cuidado: '7' });
  assert.deepEqual(conGrupo.errors, []);
  assert.equal(conGrupo.value.grupo_cuidado, 'Grupo Esperanza');
  assert.equal(conGrupo.value.grupo_cuidado_id, 7);

  assert.ok(parse({ ministerio: '' }).errors.includes('Elige tu ministerio de desarrollo.'));
  assert.ok(parse({ ministerio: 'Matrimonios' }).errors.includes('Elige tu ministerio de desarrollo.')); // congregacional: no va aquí
  assert.ok(parse({ ministerio: 'Niños' }).errors.includes('Elige tu ministerio de desarrollo.'));
  // solo los seis cargados en Ministerios: estos salen de las funciones del registro ministerial, no de Ministerios
  for (const m of ['Consolidación', 'Protocolo y ujieres', 'Medios y sonido', 'Iglesia en línea', 'Oración', 'Otro ministerio', 'Evangelismo']) assert.ok(parse({ ministerio: m }).errors.includes('Elige tu ministerio de desarrollo.'), m);
  for (const m of OPTIONS) assert.equal(parse({ ministerio: m }).value.ministerio, m);
  assert.ok(parse({ grupo_cuidado: '' }).errors.includes('Elige a qué grupo de cuidado perteneces o asistes.'));
  assert.ok(parse({ grupo_cuidado: '99' }).errors.includes('Elige a qué grupo de cuidado perteneces o asistes.')); // grupo que no existe
  assert.ok(parse({ cedula: '' }).errors.includes('Escribe tu cédula de identidad.'));
  assert.ok(parse({ address: '' }).errors.includes('Escribe tu dirección.'));
  assert.ok(parse({ civil_status: '' }).errors.includes('Elige tu estado civil.'));
  assert.ok(parse({ congregation: '' }).errors.includes('Elige tu congregación.'));
  assert.deepEqual(parse({ congregation: 'General' }).errors, []);
  assert.equal(parse({ photo_data: '' }).photo.buffer, null); // la foto es opcional
});

test('los ministerios a elegir: solo los seis de desarrollo cargados en el CRM', () => {
  assert.deepEqual(intake.DESARROLLO, ['Alabanza', 'Anfitriones', 'Diaconado', 'Intercesión', 'Medios', 'Nueva Vida']); // confirmados por Eliezer, 2026-11-14
  assert.equal(intake.sameMinistry('Diáconos', 'Diaconado'), true);
  assert.equal(intake.sameMinistry('Anfitriónes', 'Anfitriones'), true);
  assert.equal(intake.sameMinistry('Alabanza', 'Nueva Vida'), false);
  for (const c of ['Niños', 'Jóvenes', 'Adolescentes', 'Hombres', 'Mujeres', 'Matrimonios']) assert.ok(!intake.DESARROLLO.includes(c), c); // congregacionales fuera
  for (const x of ['Consolidación', 'Protocolo y ujieres', 'Medios y sonido', 'Iglesia en línea', 'Oración']) assert.ok(!intake.DESARROLLO.includes(x), x); // no van: no están en Ministerios o quedaron fuera
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(ministryLeaderIntakeRouter({ db: h.db, config }));
  app.use(ministryLeaderRequestsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const b = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(b + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(fields)), redirect: 'manual' });
  const postRaw = (p, params) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post, postRaw });
  } finally {
    server.close();
    await h.close();
  }
}

const tokenOf = async (db) => (await intake.ensureToken(db)).token;
const person = async (db, phone) => (await db.query('SELECT * FROM people WHERE phone = $1', [phone])).rows[0];
const count = async (db, table, where = '') => (await db.query(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n;

test('el formulario público: pide ministerio, grupo de cuidado, cédula y estado civil (sin cargo); enlaces malos o apagados no abren', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const token = await tokenOf(db);
    await db.query("INSERT INTO care_groups (name, leader_name, token) VALUES ('Grupo Esperanza', 'Ana Díaz', 'tok-grupo-esperanza')");
    const r = await get(`/desarrollo/${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /Líderes de ministerios de desarrollo/);
    assert.match(html, /¿Qué ministerio de desarrollo lideras\?/);
    assert.match(html, /puedes marcar más de uno/);
    for (const m of ['Alabanza', 'Anfitriones', 'Diaconado', 'Intercesión', 'Medios', 'Nueva Vida']) assert.match(html, new RegExp(`type="checkbox" name="ministerio" value="${m}"`), m);
    for (const x of ['Iglesia en línea', 'Consolidación', 'Protocolo y ujieres', 'Otro ministerio']) assert.ok(!html.includes(`value="${x}"`), x);
    assert.match(html, /¿Sirves en algún ministerio congregacional\?/);
    assert.match(html, /No sirvo en ninguno/);
    assert.match(html, /¿A qué grupo de cuidado perteneces o asistes\?/);
    assert.match(html, /Grupo Esperanza — líder: Ana Díaz/);
    assert.match(html, /No asisto a un grupo de cuidado/);
    assert.ok(!html.includes('¿Cuál es tu cargo en el ministerio?'));
    assert.match(html, /Cédula de identidad \(C\.I\.\)/);
    assert.match(html, /Estado civil/);
    assert.equal((await get('/desarrollo/zzzzzzzzzzzzzzzzzzzz')).status, 404);
    assert.equal((await post('/desarrollo/zzzzzzzzzzzzzzzzzzzz', base)).status, 404);
    await post('/personas/ministerios-desarrollo/enlace/desactivar');
    assert.equal((await get(`/desarrollo/${token}`)).status, 404);
    await post('/personas/ministerios-desarrollo/enlace/activar');
    assert.equal((await get(`/desarrollo/${token}`)).status, 200);
  });
});

test('un líder nuevo queda pendiente; al aprobar entra a Personas, a sus ministerios y como coordinador, sin consentimiento', async (t) => {
  await withApp(t, async ({ db, get, post, postRaw }) => {
    const token = await tokenOf(db);
    const gid = (await db.query("INSERT INTO care_groups (name, leader_name, token) VALUES ('Grupo Esperanza', 'Ana Díaz', 'tok-grupo-esperanza') RETURNING id")).rows[0].id;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...base, grupo_cuidado: String(gid), email: 'maria@ejemplo.com', wants_messages: '1', photo_data: dataUrl(fakeJpeg(4)), congregacional: 'Mujeres' })) params.set(k, v);
    params.set('ministerio', 'Alabanza');
    params.append('ministerio', 'Medios'); // lidera dos ministerios de desarrollo
    const r = await postRaw(`/desarrollo/${token}`, params);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Recibimos tu registro/);
    assert.equal(await count(db, 'people'), 0);

    const list = await (await get('/personas/ministerios-desarrollo/respuestas')).text();
    assert.match(list, /María Torres/);
    assert.match(list, /Alabanza/);
    assert.match(list, /Persona nueva/);
    const id = (await db.query('SELECT id FROM ministry_leader_submissions')).rows[0].id;
    assert.equal((await get(`/personas/ministerios-desarrollo/respuestas/${id}/foto`)).status, 200);

    const ok = await post(`/personas/ministerios-desarrollo/respuestas/${id}/aplicar`, {}); // sin marcar consentimiento
    assert.equal(ok.status, 303);
    const p = await person(db, '584140000022');
    assert.ok(p);
    assert.equal(p.role, 'Líder de Alabanza y Medios');
    assert.equal(p.opt_in, false);
    assert.equal(p.cedula, 'V-19888777');
    const min = (await db.query("SELECT m.*, c.full_name AS coord FROM ministries m LEFT JOIN people c ON c.id = m.coordinator_id WHERE m.name = 'Alabanza'")).rows[0];
    assert.ok(min, 'el ministerio se creó');
    assert.equal(min.coord, 'María Torres');
    assert.equal(await count(db, 'person_ministries', `WHERE person_id = ${p.id} AND ministry_id = ${min.id}`), 1);
    const medios = (await db.query("SELECT * FROM ministries WHERE name = 'Medios'")).rows[0];
    assert.ok(medios, 'el segundo ministerio también se creó');
    assert.equal(medios.coordinator_id, p.id);
    assert.equal(await count(db, 'person_ministries', `WHERE person_id = ${p.id} AND ministry_id = ${medios.id}`), 1);
    const mujeres = (await db.query("SELECT * FROM ministries WHERE name = 'Mujeres'")).rows[0];
    assert.ok(mujeres, 'el ministerio congregacional donde sirve también quedó');
    assert.equal(await count(db, 'person_ministries', `WHERE person_id = ${p.id} AND ministry_id = ${mujeres.id}`), 1);
    assert.notEqual(mujeres.coordinator_id, p.id); // sirve en él, no lo coordina
    assert.equal(await count(db, 'care_group_people', `WHERE group_id = ${gid} AND name = 'María Torres'`), 1); // quedó en la lista de gente de su grupo de cuidado
    const sub = (await db.query('SELECT * FROM ministry_leader_submissions')).rows[0];
    assert.equal(sub.grupo_cuidado, 'Grupo Esperanza');
    assert.equal(sub.status, 'aplicada');
    assert.equal(sub.cedula, ''); // lo sensible se borra al atender
  });
});

test('una persona ya registrada sin conflictos se guarda sola, queda en su ministerio y no pierde su rol', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const token = await tokenOf(db);
    await db.query("INSERT INTO people (full_name, phone, role, opt_in, active) VALUES ('Pedro Ruiz', '584140000033', 'Pastor', FALSE, TRUE)");
    const r = await post(`/desarrollo/${token}`, { ...base, ministerio: 'Nueva Vida', full_name: 'Pedro Ruiz', phone: '0414-000.00.33' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Tu registro quedó guardado/);
    const p = await person(db, '584140000033');
    assert.equal(p.role, 'Pastor'); // liderar un ministerio no pisa el rol pastoral
    assert.equal(p.cedula, 'V-19888777');
    assert.equal(await count(db, 'ministry_leader_submissions', "WHERE status = 'pendiente'"), 0);
    const min = (await db.query("SELECT * FROM ministries WHERE name = 'Nueva Vida'")).rows[0];
    assert.ok(min);
    assert.equal(min.coordinator_id, p.id);
  });
});

test('si el ministerio ya existe en el panel con otro nombre parecido, no se duplica', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const token = await tokenOf(db);
    await db.query("INSERT INTO ministries (name) VALUES ('Medios')");
    const r = await post(`/desarrollo/${token}`, { ...base, ministerio: 'Medios' });
    assert.equal(r.status, 200);
    const id = (await db.query('SELECT id FROM ministry_leader_submissions')).rows[0].id;
    const ok = await post(`/personas/ministerios-desarrollo/respuestas/${id}/aplicar`, {});
    assert.equal(ok.status, 303);
    assert.equal(await count(db, 'ministries'), 1); // quedó en «Medios», no se creó «Medios y sonido»
    const min = (await db.query("SELECT * FROM ministries WHERE name = 'Medios'")).rows[0];
    assert.ok(min.coordinator_id);
  });
});
