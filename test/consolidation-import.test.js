'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const importer = require('../src/consolidation/importer');
const { openTestDb } = require('./helpers/db');

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

async function seed(db) {
  const m = (await db.query(`INSERT INTO ministries (name) VALUES ('Nueva Vida') RETURNING id`)).rows[0].id;
  const add = async (name, phone) => (await db.query('INSERT INTO people (full_name, phone) VALUES ($1,$2) RETURNING id', [name, phone])).rows[0].id;
  const maria = await add('María Pérez de López', '584141234567');
  const jose = await add('José Luis Rojas', null);
  const sandra = await add('Sandra Díaz de Escalona', '584160000001');
  await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$2)', [sandra, m]);
  return { maria, jose, sandra };
}

const CSV = [
  'nombre,telefono,fecha_decision,sede,invitado_por,responsable,llamada,estado,motivo',
  'Maria Perez,0414-123.45.67,05/10/2026,Las Mercedes,Una amiga,Sandra Diaz,07/10/2026,,',
  'Jose Luis Rojas,,2026-10-12,Las Mercedes,,,,,',
  'Lucía Fernández,0424-555.00.00,2026-10-19,Nuarito,Su esposo,Sandra Díaz,2026-10-21,,',
  'Pedro Gómez,0412-111.11.11,2026-09-01,Nuarito,,,,perdido,se mudó',
].join('\n');

test('la revisión separa las filas en tres grupos y no guarda nada', async (t) => {
  await withDb(t, async (db) => {
    const ids = await seed(db);
    const prep = await importer.prepare(db, CSV);
    assert.deepEqual(prep.fileErrors, []);
    assert.deepEqual(prep.records.map((r) => [r.line, r.group, r.errors.length]), [[2, 'existe', 0], [3, 'posible', 0], [4, 'nueva', 0], [5, 'nueva', 0]]);
    assert.equal(prep.records[0].person.id, ids.maria); // mismo teléfono con otro formato y otro nombre escrito
    assert.equal(prep.records[1].candidates[0].person.id, ids.jose);
    assert.equal(prep.records[0].responsibleId, ids.sandra);
    assert.equal(prep.records[3].value.status, 'perdido');
    assert.equal(prep.records[3].value.lost_reason, 'se_mudo');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3);
  });
});

test('no se guarda mientras falte confirmar una coincidencia por nombre', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const prep = await importer.prepare(db, CSV);
    await assert.rejects(importer.apply(db, prep, {}), /Falta confirmar 1 coincidencias/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3);
  });
});

test('al confirmar "es la misma persona" no se duplica a nadie, y las nuevas quedan sin consentimiento', async (t) => {
  await withDb(t, async (db) => {
    const ids = await seed(db);
    const prep = await importer.prepare(db, CSV);
    const summary = await importer.apply(db, prep, { 3: String(ids.jose) });
    assert.deepEqual(summary, { newPeople: 2, linked: 2, created: 4, updated: 0 });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 5); // 3 + 2 nuevas
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE opt_in')).rows[0].n, 0);
    const nuevas = (await db.query(`SELECT full_name, role, opt_in FROM people WHERE role = 'Nuevo creyente' ORDER BY full_name`)).rows;
    assert.deepEqual(nuevas, [{ full_name: 'Lucía Fernández', role: 'Nuevo creyente', opt_in: false }, { full_name: 'Pedro Gómez', role: 'Nuevo creyente', opt_in: false }]);
    const row = (await db.query(`SELECT c.sede, c.invited_by, c.assigned_to, c.call_date::text AS call FROM consolidation c WHERE c.person_id = $1`, [ids.maria])).rows[0];
    assert.deepEqual(row, { sede: 'Las Mercedes', invited_by: 'Una amiga', assigned_to: ids.sandra, call: '2026-10-07' });
    const lost = (await db.query(`SELECT status, lost_reason FROM consolidation c JOIN people p ON p.id = c.person_id WHERE p.full_name = 'Pedro Gómez'`)).rows[0];
    assert.deepEqual(lost, { status: 'perdido', lost_reason: 'se_mudo' });
  });
});

test('"es una persona nueva" crea otra ficha, y volver a subir el mismo archivo no duplica nada', async (t) => {
  await withDb(t, async (db) => {
    const ids = await seed(db);
    const first = await importer.apply(db, await importer.prepare(db, CSV), { 3: 'nueva' });
    assert.equal(first.newPeople, 3);
    const people1 = (await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n;
    assert.equal(people1, 6);
    // segunda carga: las que tienen teléfono ya existen; las de solo nombre vuelven a pedir confirmación
    const prep2 = await importer.prepare(db, CSV);
    assert.deepEqual(prep2.records.map((r) => r.group), ['existe', 'posible', 'existe', 'existe']);
    assert.equal(prep2.records[0].warnings.some((w) => /Ya está en consolidación/.test(w)), true);
    const second = await importer.apply(db, prep2, { 3: String(ids.jose) });
    assert.equal(second.newPeople, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 6);
  });
});

test('no se acepta elegir a alguien que no era candidato, y entonces no se guarda nada', async (t) => {
  await withDb(t, async (db) => {
    const ids = await seed(db);
    const prep = await importer.prepare(db, CSV);
    await assert.rejects(importer.apply(db, prep, { 3: String(ids.sandra) }), /Elección no válida/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3); // la transacción se deshizo completa
  });
});

test('errores por fila: fechas imposibles, orden de etapas, motivo faltante y filas repetidas', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const bad = [
      'nombre,telefono,fecha_decision,llamada,estado,motivo',
      'A Uno,0414-000.00.01,31/02/2026,,,',
      'B Dos,0414-000.00.02,2026-10-10,2026-10-01,,',
      'C Tres,0414-000.00.03,2026-10-10,,perdido,',
      'D Cuatro,0414-000.00.04,2026-10-10,,quizás,',
      'E Cinco,0414-000.00.05,2026-10-10,,,',
      'E Cinco repetida,0414-000.00.05,2026-10-11,,,',
      ',0414-000.00.06,2026-10-10,,,',
      'F Seis,12,2026-10-10,,,',
    ].join('\n');
    const prep = await importer.prepare(db, bad);
    const msgs = prep.records.map((r) => r.errors.join(' | '));
    assert.match(msgs[0], /Fecha no válida en fecha de decisión/);
    assert.match(msgs[1], /llamada es anterior a la decisión/);
    assert.match(msgs[2], /necesita un motivo válido/);
    assert.match(msgs[3], /Estado no reconocido/);
    assert.equal(msgs[4], '');
    assert.match(msgs[5], /mismo teléfono que la línea 6/);
    assert.match(msgs[6], /Falta el nombre/);
    assert.match(msgs[7], /Teléfono no válido/);
    await assert.rejects(importer.apply(db, prep, {}), /tiene errores/);
  });
});

test('archivo sin las columnas obligatorias', async (t) => {
  await withDb(t, async (db) => {
    const prep = await importer.prepare(db, 'telefono,sede\n0414-000.00.01,Las Mercedes');
    assert.deepEqual(prep.fileErrors, ['Falta la columna "nombre".', 'Falta la columna "fecha_decision".']);
    await assert.rejects(importer.apply(db, prep, {}), /tiene errores/);
  });
});
