'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mm = require('../src/ministries-merge');
const repo = require('../src/repo');
const { CONGREGATIONS } = require('../src/care-groups');
const { ministriesMergeRouter } = require('../src/routes/ministries-merge');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true };

test('nombre para comparar: sin tildes, mayúsculas, signos ni espacios de más', () => {
  for (const v of ['Anfitriones', 'anfitriones', 'Anfitriónes', ' Anfitriones  ', 'ANFITRIONES.', 'Anfi-triones'.replace('-', '')]) assert.equal(mm.normName(v), 'anfitriones', v);
  assert.notEqual(mm.normName('Anfitriones'), mm.normName('Anfitrionas'));
  assert.equal(mm.normName('!!!'), '');
});

test('grupos de ministerios repetidos: solo los que se llaman casi igual', () => {
  const list = [
    { id: 1, name: 'Anfitriones' }, { id: 2, name: 'Alabanza' }, { id: 3, name: 'Anfitriónes ' }, { id: 4, name: 'Diáconos' }, { id: 5, name: 'diaconos' }, { id: 6, name: 'Medios' },
  ];
  const groups = mm.duplicateGroups(list);
  assert.deepEqual(groups.map((g) => g.map((m) => m.id)), [[1, 3], [4, 5]]);
  assert.deepEqual(mm.duplicateGroups([{ id: 1, name: 'Uno' }, { id: 2, name: 'Dos' }]), []);
});

test('la lista de congregaciones incluye Preadolescentes entre Niños y Adolescentes', () => {
  assert.deepEqual(CONGREGATIONS, ['Niños', 'Preadolescentes', 'Adolescentes', 'Jóvenes', 'Jóvenes adultos', 'Matrimonios', 'Mujeres', 'Hombres']);
});

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

const addMin = async (db, name, coordinator = null) => (await db.query('INSERT INTO ministries (name, coordinator_id) VALUES ($1, $2) RETURNING id', [name, coordinator])).rows[0].id;
const addPerson = async (db, name, phone) => (await db.query('INSERT INTO people (full_name, phone) VALUES ($1, $2) RETURNING id', [name, phone])).rows[0].id;
const addEvent = async (db, title) => (await db.query("INSERT INTO events (title, starts_at) VALUES ($1, now() + interval '5 days') RETURNING id", [title])).rows[0].id;
const members = async (db, mid) => (await db.query('SELECT person_id FROM person_ministries WHERE ministry_id = $1 ORDER BY person_id', [mid])).rows.map((r) => r.person_id);

test('unir: las personas y los eventos pasan al ministerio que se conserva, sin repetir y sin borrar a nadie', async (t) => {
  await withDb(t, async (db) => {
    const a = await addMin(db, 'Anfitriones');
    const b = await addMin(db, 'Anfitriónes');
    const [p1, p2, p3] = [await addPerson(db, 'Ana Uno', '584140000001'), await addPerson(db, 'Luis Dos', '584140000002'), await addPerson(db, 'Eva Tres', '584140000003')];
    await db.query('INSERT INTO person_ministries VALUES ($1,$2), ($3,$2)', [p1, a, p2]); // en el que se conserva: p1 y p2
    await db.query('INSERT INTO person_ministries VALUES ($1,$2), ($3,$2)', [p2, b, p3]); // en el repetido: p2 (ya estaba) y p3
    const [e1, e2] = [await addEvent(db, 'Evento 1'), await addEvent(db, 'Evento 2')];
    await db.query('INSERT INTO event_ministries VALUES ($1,$2)', [e1, a]);
    await db.query('INSERT INTO event_ministries VALUES ($1,$2), ($3,$2)', [e1, b, e2]);
    await db.query('UPDATE ministries SET coordinator_id = $2 WHERE id = $1', [b, p3]);

    const out = await mm.mergeMinistries(db, a, b);
    assert.deepEqual([out.keepName, out.removedName, out.members, out.events, out.coordinatorInherited], ['Anfitriones', 'Anfitriónes', 1, 1, true]);
    assert.deepEqual(await members(db, a), [p1, p2, p3]); // p2 no se repite
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ministries WHERE id = $1', [b])).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM person_ministries WHERE ministry_id = $1', [b])).rows[0].n, 0);
    assert.deepEqual((await db.query('SELECT event_id FROM event_ministries WHERE ministry_id = $1 ORDER BY event_id', [a])).rows.map((r) => r.event_id), [e1, e2]);
    assert.equal((await db.query('SELECT coordinator_id FROM ministries WHERE id = $1', [a])).rows[0].coordinator_id, p3); // heredó el coordinador
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3); // nadie se borró
    assert.equal((await db.query('SELECT count(*)::int AS n FROM events')).rows[0].n, 2);
  });
});

test('unir no pisa al coordinador que ya tenía el ministerio conservado, y rechaza datos malos sin cambiar nada', async (t) => {
  await withDb(t, async (db) => {
    const [c1, c2] = [await addPerson(db, 'Coord Uno', '584140000001'), await addPerson(db, 'Coord Dos', '584140000002')];
    const a = await addMin(db, 'Alabanza', c1);
    const b = await addMin(db, 'alabanza ', c2);
    const out = await mm.mergeMinistries(db, a, b);
    assert.equal(out.coordinatorInherited, false);
    assert.equal((await db.query('SELECT coordinator_id FROM ministries WHERE id = $1', [a])).rows[0].coordinator_id, c1);

    await assert.rejects(() => mm.mergeMinistries(db, a, a), /distintos/);
    await assert.rejects(() => mm.mergeMinistries(db, a, 999999), /ya no existe/);
    await assert.rejects(() => mm.mergeMinistries(db, 'x', a), /válidos/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ministries')).rows[0].n, 1);
  });
});

test('ya no se crean repetidos: ensureMinistry reutiliza el que se llama casi igual (otra tilde, otro signo, espacios)', async (t) => {
  await withDb(t, async (db) => {
    const a = await repo.ensureMinistry(db, 'Anfitriones');
    assert.equal(await repo.ensureMinistry(db, 'anfitriónes'), a);
    assert.equal(await repo.ensureMinistry(db, '  Anfitriones   '), a);
    assert.equal(await repo.ensureMinistry(db, 'ANFITRIONES.'), a);
    const other = await repo.ensureMinistry(db, 'Anfitrionas'); // distinto de verdad: se crea
    assert.notEqual(other, a);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ministries')).rows[0].n, 2);
    assert.equal(await repo.ensureMinistry(db, 'Diáconos'), await repo.ensureMinistry(db, 'diaconos'));
  });
});

test('pantalla Unir ministerios: propone el que tiene más personas, une, y avisa si falta algo', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(ministriesMergeRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, entries) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(entries), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    const db = h.db;
    const a = await addMin(db, 'Anfitriones');
    const b = await addMin(db, 'Anfitriónes');
    const p = await addPerson(db, 'Ana Uno', '584140000001');
    await db.query('INSERT INTO person_ministries VALUES ($1,$2)', [p, b]); // el repetido es el que tiene gente
    await addMin(db, 'Medios');

    const html = await (await get('/ministerios/unir')).text();
    assert.match(html, /Parece el mismo ministerio, 2 veces/);
    assert.match(html, new RegExp(`value="${b}" checked`)); // propone conservar el que tiene más personas
    assert.ok(!html.includes('Medios</strong>')); // los que no se repiten no salen como duplicados
    assert.match(html, /Unir dos a mano/);

    assert.match(loc(await post('/ministerios/unir', [['keep', String(b)], ['all', String(b)]])), /Elige el ministerio que se conserva/);
    const ok = await post('/ministerios/unir', [['keep', String(b)], ['all', String(a)], ['all', String(b)]]);
    assert.equal(ok.status, 303);
    assert.match(loc(ok), /«Anfitriones» se unió a «Anfitriónes»/);
    assert.deepEqual((await db.query('SELECT name FROM ministries ORDER BY name')).rows.map((r) => r.name), ['Anfitriónes', 'Medios']);
    assert.deepEqual(await members(db, b), [p]);
    assert.match(await (await get('/ministerios/unir')).text(), /No encontré ministerios que se llamen casi igual/);
    assert.match(loc(await post('/ministerios/unir', [['keep', String(b)], ['all', '999999']])), /ya no existe/);
  } finally {
    server.close();
    await h.close();
  }
});
