'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nv = require('../src/nuevavida/store');
const consolidation = require('../src/consolidation/store');
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

const count = async (db, table, where = 'TRUE') => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
const TODAY = '2026-10-27';

test('validar una fila: nombre ilegible se marca para revisar; teléfonos, fechas y edades se validan', () => {
  const ok = nv.validateRow({ name: '  María  Pérez ', phone: '0414-123.45.67', email: 'MARIA@Correo.com', decision_date: '5/10/2026', age: '34' }, '58', TODAY);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.full_name, 'María Pérez');
  assert.equal(ok.value.phone, '584141234567');
  assert.equal(ok.value.email, 'maria@correo.com');
  assert.equal(ok.value.decision_date, '2026-10-05');
  assert.equal(ok.value.age, 34);
  assert.equal(ok.value.needs_review, false);

  const unnamed = nv.validateRow({ name: '', phone: '04145550000', decision_date: '2026-10-05', raw_text: 'texto original' }, '58', TODAY);
  assert.equal(unnamed.value.full_name, nv.PLACEHOLDER);
  assert.equal(unnamed.value.needs_review, true);
  assert.match(unnamed.value.review_note, /No se pudo leer el nombre/);
  assert.equal(unnamed.value.raw_text, 'texto original');

  const nodate = nv.validateRow({ name: 'Sin Fecha', decision_date: '' }, '58', TODAY);
  assert.equal(nodate.value.needs_review, true);
  assert.match(nodate.value.review_note, /Sin fecha/);

  const bad = nv.validateRow({ name: 'Mal Dato', phone: '12', email: 'no-es-correo', decision_date: '31/02/2026', age: '250' }, '58', TODAY);
  assert.equal(bad.errors.length, 4);
  assert.equal(nv.validateRow({ name: 'Futura', decision_date: '2027-01-01' }, '58', TODAY).errors[0], 'La fecha no puede ser futura.');
  assert.match(nv.validateRow({ name: 'x'.repeat(130) }, '58', TODAY).errors[0], /demasiado largo/);
});

const CSV = [
  nv.TEMPLATE_HEADERS.join(','),
  'Ana Torres,0414-111.22.33,,2026-09-01,,Las Mercedes,29,soltera,"Urb. Ejemplo, calle 2",Fiesta de gratitud,Llamó Eduardo,,Tabla de prueba,no,,texto A',
  'Luis Mora,0424-222.33.44,,2026-09-08,el año se dedujo,Nuarito,17,,,,,,Tabla de prueba,si,fecha heredada,texto B',
  ',0412-333.44.55,,2026-09-15,,,,,,,,,Hoja de prueba,si,nombre ilegible,texto C original',
  'Sin Teléfono,,,2026-09-22,,,,,,,,,Hoja de prueba,no,,',
].join('\n');

test('cargar: guarda todo, conserva los textos originales y marca lo dudoso; repetir la carga no duplica', async (t) => {
  await withDb(t, async (db) => {
    const prep = await nv.prepareImport(db, CSV, '58', TODAY);
    assert.deepEqual(prep.fileErrors, []);
    assert.deepEqual(prep.records.map((r) => r.status), ['nueva', 'nueva', 'nueva', 'nueva']);
    assert.equal(await count(db, 'nueva_vida'), 0); // revisar no guarda
    assert.deepEqual(await nv.applyImport(db, prep), { saved: 4, skipped: 0 });
    const rows = (await db.query('SELECT full_name, phone, age, address, followup, source, needs_review, raw_text FROM nueva_vida ORDER BY id')).rows;
    assert.deepEqual(rows[0], { full_name: 'Ana Torres', phone: '584141112233', age: 29, address: 'Urb. Ejemplo, calle 2', followup: 'Llamó Eduardo', source: 'Tabla de prueba', needs_review: false, raw_text: 'texto A' });
    assert.equal(rows[2].full_name, nv.PLACEHOLDER);
    assert.equal(rows[2].raw_text, 'texto C original');
    assert.equal(rows[2].needs_review, true);
    assert.equal(rows[3].phone, null);
    assert.equal((await nv.stats(db)).review, 2);
    assert.equal((await nv.stats(db)).minors, 1);

    const again = await nv.prepareImport(db, CSV, '58', TODAY);
    assert.deepEqual(again.records.map((r) => r.status), ['ya_estaba', 'ya_estaba', 'ya_estaba', 'ya_estaba']);
    assert.deepEqual(await nv.applyImport(db, again), { saved: 0, skipped: 4 });
    assert.equal(await count(db, 'nueva_vida'), 4);
  });
});

test('cargar: filas repetidas dentro del archivo se omiten, y los errores impiden guardar', async (t) => {
  await withDb(t, async (db) => {
    const dup = ['nombre,telefono,fecha_decision', 'Uno,0414-000.00.01,2026-09-01', 'Uno otra vez,0414-000.00.01,2026-09-02', 'Dos,,2026-09-03', 'Dos,,2026-09-03'].join('\n');
    const prep = await nv.prepareImport(db, dup, '58', TODAY);
    assert.deepEqual(prep.records.map((r) => r.status), ['nueva', 'repetida', 'nueva', 'repetida']);
    assert.deepEqual(await nv.applyImport(db, prep), { saved: 2, skipped: 2 });

    const bad = await nv.prepareImport(db, 'nombre,telefono,fecha_decision\nA,12,2026-09-01', '58', TODAY);
    await assert.rejects(nv.applyImport(db, bad), /tiene errores/);
    const noCol = await nv.prepareImport(db, 'telefono\n0414-000.00.09', '58', TODAY);
    assert.deepEqual(noCol.fileErrors, ['Falta la columna "nombre".']);
    const many = 'nombre\n' + Array.from({ length: 2001 }, (_, i) => `P${i}`).join('\n');
    assert.match((await nv.prepareImport(db, many, '58', TODAY)).fileErrors[0], /más de 2000 filas/);
  });
});

test('lista y filtros: por fuente, conexión, revisión, teléfono, mes y búsqueda', async (t) => {
  await withDb(t, async (db) => {
    await nv.applyImport(db, await nv.prepareImport(db, CSV, '58', TODAY));
    assert.equal((await nv.list(db)).length, 4);
    assert.equal((await nv.list(db, { fuente: 'Hoja de prueba' })).length, 2);
    assert.equal((await nv.list(db, { revisar: 'si' })).length, 2);
    assert.equal((await nv.list(db, { telefono: 'sin' })).length, 1);
    assert.equal((await nv.list(db, { mes: '2026-09' })).length, 4);
    assert.equal((await nv.list(db, { q: 'ana' }))[0].full_name, 'Ana Torres');
    assert.equal((await nv.list(db, { q: '%' })).length, 0); // el comodín se escapa
    assert.equal((await nv.list(db, { conexion: 'conectada' })).length, 0);
    assert.equal((await nv.list(db))[0].full_name, 'Sin Teléfono'); // la más reciente primero
    const opts = await nv.filterOptions(db);
    assert.deepEqual([opts.sources, opts.months], [['Hoja de prueba', 'Tabla de prueba'], ['2026-09']]);
  });
});

test('conectar a consolidación: mismo teléfono usa a la persona, nombre parecido pide confirmar, y todo entra como histórico', async (t) => {
  await withDb(t, async (db) => {
    const add = async (name, phone = null) => (await db.query('INSERT INTO people (full_name, phone) VALUES ($1,$2) RETURNING id', [name, phone])).rows[0].id;
    const existing = await add('Ana Torres Pérez', '584141112233'); // mismo teléfono que "Ana Torres"
    const similar = await add('Luis Alberto Mora'); // nombre parecido a "Luis Mora", sin teléfono
    await nv.applyImport(db, await nv.prepareImport(db, CSV, '58', TODAY));
    const [ana, luis, sinNombre, sinTel] = (await db.query('SELECT id FROM nueva_vida ORDER BY id')).rows.map((r) => r.id);

    // mismo teléfono: se conecta con la persona que ya existe
    const a = await nv.connectOne(db, ana);
    assert.equal(a.status, 'conectada');
    assert.equal(a.personId, existing);
    assert.equal(await count(db, 'people'), 2);
    // histórico: no entra en el embudo salvo que se pida
    assert.equal((await consolidation.funnel(db))[0].count, 0);
    assert.equal((await consolidation.funnel(db, { historicos: '1' }))[0].count, 1);
    assert.equal((await consolidation.list(db)).length, 0);
    assert.equal((await consolidation.list(db, { historicos: '1' })).length, 1);
    assert.equal((await db.query('SELECT opt_in FROM people WHERE id = $1', [existing])).rows[0].opt_in, false);
    // el registro queda enlazado
    const rec = await nv.get(db, ana);
    assert.deepEqual([rec.person_id, rec.consolidation_id !== null, rec.historical], [existing, true, true]);
    assert.equal((await nv.connectOne(db, ana)).status, 'ya_conectada');

    // nombre parecido: pide confirmación y no crea nada
    const l1 = await nv.connectOne(db, luis);
    assert.equal(l1.status, 'confirmar');
    assert.deepEqual(l1.candidates.map((c) => c.id), [similar]);
    assert.equal(await count(db, 'consolidation'), 1);
    assert.equal((await nv.connectOne(db, luis, { choice: '999999' })).status, 'eleccion_no_valida');
    assert.equal((await nv.connectOne(db, luis, { choice: String(existing) })).status, 'eleccion_no_valida'); // no era candidato
    const l2 = await nv.connectOne(db, luis, { choice: String(similar) });
    assert.equal(l2.status, 'conectada');
    assert.equal(l2.personId, similar);

    // nombre ilegible: primero hay que corregirlo
    assert.equal((await nv.connectOne(db, sinNombre)).status, 'sin_nombre');
    // sin teléfono ni parecidos: se crea la persona, sin consentimiento
    const s = await nv.connectOne(db, sinTel);
    assert.equal(s.status, 'conectada');
    const created = (await db.query('SELECT full_name, phone, opt_in, role FROM people WHERE id = $1', [s.personId])).rows[0];
    assert.deepEqual(created, { full_name: 'Sin Teléfono', phone: null, opt_in: false, role: 'Nuevo creyente' });
    assert.equal(await nv.connectOne(db, 999999).then((r) => r.status), 'no_existe');
  });
});

test('conectar en bloque: deja para después las que piden confirmar, las sin fecha y las sin nombre', async (t) => {
  await withDb(t, async (db) => {
    await db.query(`INSERT INTO people (full_name) VALUES ('Luis Alberto Mora')`);
    const withDate = CSV + '\nSin Fecha Alguna,0416-555.66.77,,,,,,,,,,,Tabla de prueba,no,,';
    await nv.applyImport(db, await nv.prepareImport(db, withDate, '58', TODAY));
    const ids = (await db.query('SELECT id FROM nueva_vida ORDER BY id')).rows.map((r) => r.id);
    const sum = await nv.connectMany(db, ids, { historical: true });
    assert.deepEqual(sum, { conectada: 2, ya_conectada: 0, sin_fecha: 1, sin_nombre: 1, confirmar: 1, no_existe: 0 });
    assert.equal(await count(db, 'consolidation'), 2);
    assert.equal(await count(db, 'consolidation', 'historical'), 2);
    const again = await nv.connectMany(db, ids);
    assert.equal(again.ya_conectada, 2);
  });
});

test('una persona no histórica que ya estaba en consolidación conserva su estado al enlazarse', async (t) => {
  await withDb(t, async (db) => {
    const p = (await db.query(`INSERT INTO people (full_name, phone) VALUES ('Ana Torres', '584141112233') RETURNING id`)).rows[0].id;
    await consolidation.upsertConsolidation(db, p, { decision_date: '2026-09-01', sede: 'Las Mercedes', call_date: '2026-09-02' });
    await nv.applyImport(db, await nv.prepareImport(db, CSV, '58', TODAY));
    const ana = (await db.query(`SELECT id FROM nueva_vida WHERE full_name = 'Ana Torres'`)).rows[0].id;
    const r = await nv.connectOne(db, ana);
    assert.equal(r.status, 'conectada');
    assert.equal(r.created, false);
    const c = (await db.query('SELECT historical, call_date::text AS call FROM consolidation WHERE person_id = $1', [p])).rows[0];
    assert.deepEqual(c, { historical: false, call: '2026-09-02' }); // el seguimiento real no se degrada a histórico
    assert.equal((await consolidation.funnel(db))[0].count, 1);
  });
});

test('editar, crear a mano y borrar un registro', async (t) => {
  await withDb(t, async (db) => {
    const created = await nv.save(db, null, { name: 'Nuevo Creyente', phone: '0414-999.88.77', decision_date: '2026-10-20', sede: 'Nuarito', age: '40' }, '58', TODAY);
    assert.ok(created.id);
    assert.equal((await nv.get(db, created.id)).source, 'Registro manual');
    assert.deepEqual((await nv.save(db, null, { name: '', decision_date: '2026-10-20' }, '58', TODAY)).errors, ['Escribe el nombre.']);
    const upd = await nv.save(db, created.id, { name: 'Nuevo Creyente Corregido', phone: '0414-999.88.77', decision_date: '2026-10-21', address: 'Calle 1', needs_review: '' }, '58', TODAY);
    assert.equal(upd.id, created.id);
    const row = await nv.get(db, created.id);
    assert.deepEqual([row.full_name, row.d, row.address, row.needs_review], ['Nuevo Creyente Corregido', '2026-10-21', 'Calle 1', false]);
    assert.deepEqual((await nv.save(db, 999999, { name: 'X', decision_date: '2026-10-21' }, '58', TODAY)).errors, ['No existe ese registro.']);
    await nv.remove(db, created.id);
    assert.equal(await count(db, 'nueva_vida'), 0);
  });
});
