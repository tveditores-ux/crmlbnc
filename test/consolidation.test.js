'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, nameScore, normName } = require('../src/consolidation/match');
const { parseDate, currentStage, STAGES } = require('../src/consolidation/stages');
const store = require('../src/consolidation/store');
const { openTestDb } = require('./helpers/db');

/* ------------------------- Unión de personas (sin base de datos) ------------------------- */

const PEOPLE = [
  { id: 1, full_name: 'María Pérez de López', phone: '584141234567' },
  { id: 2, full_name: 'José Luis Rojas', phone: null },
  { id: 3, full_name: 'Ana Martínez', phone: '584245550000' },
  { id: 4, full_name: 'Pedro', phone: null },
];

test('normName quita tildes, mayúsculas y palabras de relleno', () => {
  assert.equal(normName('  María  PÉREZ de López '), 'maria perez lopez');
  assert.equal(normName('Pastor José Luis'), 'jose luis');
});

test('el mismo teléfono en cualquier formato es la misma persona', () => {
  for (const raw of ['0414-123.45.67', '+58 414 1234567', '04141234567', '414 1234567']) {
    const r = classify({ name: 'Nombre distinto', phone: raw }, PEOPLE);
    assert.equal(r.group, 'existe', raw);
    assert.equal(r.person.id, 1);
  }
});

test('un teléfono encontrado manda sobre el nombre', () => {
  const r = classify({ name: 'José Luis Rojas', phone: '0424-555.00.00' }, PEOPLE);
  assert.equal(r.group, 'existe');
  assert.equal(r.person.id, 3);
});

test('sin teléfono, un nombre igual o parecido es solo una posible coincidencia: nunca se une solo', () => {
  for (const name of ['Jose Luis Rojas', 'JOSÉ LUIS ROJAS', 'Jose Rojas', 'Maria Perez', 'Maria Perez Lopez']) {
    const r = classify({ name, phone: '' }, PEOPLE);
    assert.equal(r.group, 'posible', name);
    assert.ok(r.candidates.length >= 1);
    assert.equal(r.person, undefined);
  }
});

test('un teléfono nuevo con nombre parecido también pide confirmación', () => {
  const r = classify({ name: 'Ana Martinez', phone: '0412-999.99.99' }, PEOPLE);
  assert.equal(r.group, 'posible');
  assert.equal(r.candidates[0].person.id, 3);
});

test('nombres de una sola palabra solo coinciden si son idénticos; los distintos son personas nuevas', () => {
  assert.equal(nameScore('Pedro', 'Pedro'), 1);
  assert.equal(nameScore('Pedro', 'Pedro Pablo'), 0);
  assert.equal(classify({ name: 'Lucía Fernández', phone: '' }, PEOPLE).group, 'nueva');
  assert.equal(classify({ name: 'Carlos Ruiz', phone: '0414-000.00.01' }, PEOPLE).group, 'nueva');
});

test('apellidos distintos no se confunden', () => {
  assert.equal(nameScore('Ana Martínez', 'Ana Rodríguez'), 0);
  assert.equal(nameScore('José Luis Rojas', 'José Luis Pérez'), 0); // comparten el segundo nombre, no el apellido
  assert.ok(nameScore('Jose Rojas', 'Jose Luis Rojaz') >= 0.8); // error de una letra en el apellido
  assert.equal(nameScore('Jose Rojas', 'Jose Luis Rojo'), 0); // dos letras de diferencia: ya es otro apellido
});

test('fechas: acepta dos formatos y rechaza las imposibles', () => {
  assert.equal(parseDate('2026-10-05'), '2026-10-05');
  assert.equal(parseDate('5/10/2026'), '2026-10-05');
  assert.equal(parseDate('05-10-26'), '2026-10-05');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('ayer'), null);
  assert.equal(parseDate(''), null);
});

test('etapa actual: la última que ya tiene fecha', () => {
  assert.equal(currentStage({ decision_date: '2026-01-01' }).key, 'decision');
  assert.equal(currentStage({ decision_date: 'x', call_date: 'x', meeting_date: 'x' }).key, 'reunion');
  assert.equal(currentStage({ decision_date: 'x', riel_date: 'x' }).key, 'riel');
  assert.equal(STAGES[0].key, 'decision');
});

/* ------------------------- Con base de datos real ------------------------- */

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

const person = async (db, name, phone = null) =>
  (await db.query('INSERT INTO people (full_name, phone) VALUES ($1,$2) RETURNING id', [name, phone])).rows[0].id;

test('la migración crea las tablas y protege las reglas del proceso', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Uno', '584140000001');
    await db.query(`INSERT INTO consolidation (person_id, decision_date) VALUES ($1, '2026-10-05')`, [a]);
    // una persona, una consolidación
    await assert.rejects(db.query(`INSERT INTO consolidation (person_id, decision_date) VALUES ($1, '2026-10-06')`, [a]));
    // perdida exige motivo; el motivo debe ser de la lista
    await assert.rejects(db.query(`UPDATE consolidation SET status = 'perdido' WHERE person_id = $1`, [a]));
    await assert.rejects(db.query(`UPDATE consolidation SET status = 'perdido', lost_reason = 'cansancio' WHERE person_id = $1`, [a]));
    await db.query(`UPDATE consolidation SET status = 'perdido', lost_reason = 'se_mudo' WHERE person_id = $1`, [a]);
    await assert.rejects(db.query(`UPDATE consolidation SET status = 'desaparecido' WHERE person_id = $1`, [a]));
    // al borrar la persona se va su consolidación
    await db.query('DELETE FROM people WHERE id = $1', [a]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation')).rows[0].n, 0);
  });
});

test('registrar en consolidación no activa los mensajes (opt_in sigue igual)', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Dos', '584140000002');
    await store.upsertConsolidation(db, a, { decision_date: '2026-10-05', sede: 'Las Mercedes' });
    assert.equal((await db.query('SELECT opt_in FROM people WHERE id = $1', [a])).rows[0].opt_in, false);
  });
});

test('upsert: crea una vez, deja historial, y al repetir solo completa lo vacío', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Tres', '584140000003');
    const first = await store.upsertConsolidation(db, a, { decision_date: '2026-10-05', sede: 'Las Mercedes', invited_by: 'Un amigo', call_date: '2026-10-07' });
    assert.equal(first.created, true);
    const again = await store.upsertConsolidation(db, a, { decision_date: '2026-11-30', sede: 'Nuarito', invited_by: 'Otro', call_date: '2026-10-09', meeting_date: '2026-10-14' });
    assert.equal(again.created, false);
    assert.equal(again.id, first.id);
    const row = (await db.query('SELECT sede, invited_by, decision_date::text AS d, call_date::text AS c, meeting_date::text AS m FROM consolidation WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual(row, { sede: 'Las Mercedes', invited_by: 'Un amigo', d: '2026-10-05', c: '2026-10-07', m: '2026-10-14' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation_status_log WHERE consolidation_id = $1', [first.id])).rows[0].n, 1);
  });
});

test('avanzar de etapa: valida fechas y guarda fecha y responsable', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Cuatro', '584140000004');
    const v = await person(db, 'Voluntaria Nueva Vida');
    const { id } = await store.upsertConsolidation(db, a, { decision_date: '2026-10-05' });
    assert.match(await store.setStage(db, id, 'llamada', '2026-10-01', v), /anterior a la decisión/);
    assert.match(await store.setStage(db, id, 'llamada', '2999-01-01', v), /futura/);
    assert.match(await store.setStage(db, id, 'decision', '2026-10-06', v), /no válida/);
    assert.equal(await store.setStage(db, id, 'llamada', '2026-10-07', v), null);
    assert.equal(await store.setStage(db, id, 'grupo', '2026-10-20', v, { groupName: 'GdC Los Samanes' }), null);
    const r = (await db.query('SELECT call_date::text AS c, call_by, group_date::text AS g, group_name FROM consolidation WHERE id = $1', [id])).rows[0];
    assert.deepEqual(r, { c: '2026-10-07', call_by: v, g: '2026-10-20', group_name: 'GdC Los Samanes' });
    assert.equal(await store.clearStage(db, id, 'llamada'), null);
    assert.equal((await db.query('SELECT call_date FROM consolidation WHERE id = $1', [id])).rows[0].call_date, null);
  });
});

test('estado: perdida pide motivo, y cada cambio queda en el historial con su fecha', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Cinco', '584140000005');
    const { id } = await store.upsertConsolidation(db, a, { decision_date: '2026-01-10' });
    assert.match(await store.setStatus(db, id, 'perdido', '', '2026-03-01'), /motivo/);
    assert.match(await store.setStatus(db, id, 'raro', '', '2026-03-01'), /no válido/);
    assert.equal(await store.setStatus(db, id, 'en_pausa', '', '2026-02-01'), null);
    assert.equal(await store.setStatus(db, id, 'perdido', 'otra_iglesia', '2026-03-01'), null);
    const log = (await db.query('SELECT status, reason, changed_on::text AS d FROM consolidation_status_log WHERE consolidation_id = $1 ORDER BY id', [id])).rows;
    assert.deepEqual(log, [
      { status: 'activo', reason: null, d: '2026-01-10' },
      { status: 'en_pausa', reason: null, d: '2026-02-01' },
      { status: 'perdido', reason: 'otra_iglesia', d: '2026-03-01' },
    ]);
    const c = (await db.query('SELECT status, lost_reason FROM consolidation WHERE id = $1', [id])).rows[0];
    assert.deepEqual(c, { status: 'perdido', lost_reason: 'otra_iglesia' });
    assert.equal(await store.setStatus(db, id, 'activo', '', '2026-04-01'), null); // se reactiva y el motivo se limpia
    assert.equal((await db.query('SELECT lost_reason FROM consolidation WHERE id = $1', [id])).rows[0].lost_reason, null);
  });
});

test('llamadas: una que contesta marca la etapa, "no llamar" la saca de las listas', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Seis', '584140000006');
    const v = await person(db, 'Voluntario');
    const { id } = await store.upsertConsolidation(db, a, { decision_date: '2026-10-01' });
    assert.match(await store.logCall(db, id, { calledBy: v, result: 'quizas' }), /no válido/);
    assert.equal(await store.logCall(db, id, { calledBy: v, result: 'no_contesto', note: 'Apagado' }), null);
    assert.equal((await db.query('SELECT call_date FROM consolidation WHERE id = $1', [id])).rows[0].call_date, null);
    assert.equal(await store.logCall(db, id, { calledBy: v, result: 'contesto', note: 'Quedó en ir el miércoles' }), null);
    const c = (await db.query('SELECT call_date IS NOT NULL AS has, call_by, do_not_call FROM consolidation WHERE id = $1', [id])).rows[0];
    assert.deepEqual(c, { has: true, call_by: v, do_not_call: false });
    assert.equal(await store.logCall(db, id, { calledBy: v, result: 'no_llamar' }), null);
    assert.equal((await db.query('SELECT do_not_call FROM consolidation WHERE id = $1', [id])).rows[0].do_not_call, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation_calls WHERE consolidation_id = $1', [id])).rows[0].n, 3);
  });
});

test('embudo y lista: cuentan por etapa y respetan los filtros', async (t) => {
  await withDb(t, async (db) => {
    const v = await person(db, 'Responsable Uno');
    const mk = async (name, phone, data) => {
      const p = await person(db, name, phone);
      return store.upsertConsolidation(db, p, { assigned_to: v, ...data });
    };
    await mk('A', '584140000011', { decision_date: '2026-09-02', sede: 'Las Mercedes', call_date: '2026-09-04', meeting_date: '2026-09-10', pp_start_date: '2026-09-17' });
    await mk('B', '584140000012', { decision_date: '2026-09-09', sede: 'Las Mercedes', call_date: '2026-09-12' });
    const c = await mk('C', '584140000013', { decision_date: '2026-10-04', sede: 'Nuarito' });
    await store.setStatus(db, c.id, 'perdido', 'no_contesta', '2026-10-20');

    const all = await store.funnel(db);
    assert.deepEqual(Object.fromEntries(all.map((s) => [s.key, s.count])), { decision: 3, llamada: 2, reunion: 1, pp_inicio: 1, pp_fin: 0, bautismo: 0, grupo: 0, riel: 0 });
    const lm = await store.funnel(db, { sede: 'las mercedes' });
    assert.equal(lm[0].count, 2);
    assert.equal((await store.funnel(db, { mes: '2026-10' }))[0].count, 1);
    assert.equal((await store.funnel(db, { status: 'perdido' }))[0].count, 1);
    assert.equal((await store.funnel(db, { responsable: String(v) }))[0].count, 3);

    const rows = await store.list(db, { sede: 'Las Mercedes' });
    assert.deepEqual(rows.map((r) => r.full_name), ['B', 'A']); // más reciente primero
    assert.equal(rows[0].responsible_name, 'Responsable Uno');
    assert.equal(typeof rows[0].days, 'number');
  });
});

test('responsables: salen del ministerio Nueva Vida y se encuentran por nombre', async (t) => {
  await withDb(t, async (db) => {
    const m = (await db.query(`INSERT INTO ministries (name) VALUES ('Nueva Vida') RETURNING id`)).rows[0].id;
    const other = (await db.query(`INSERT INTO ministries (name) VALUES ('Alabanza') RETURNING id`)).rows[0].id;
    const a = await person(db, 'Sandra Díaz de Escalona');
    const b = await person(db, 'Reina Sánchez');
    const c = await person(db, 'Moises Becerra');
    for (const [pid, mid] of [[a, m], [b, m], [c, other]]) await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$2)', [pid, mid]);
    const vols = await store.nuevaVidaPeople(db);
    assert.deepEqual(vols.map((v) => v.full_name), ['Reina Sánchez', 'Sandra Díaz de Escalona']);
    assert.equal(store.matchResponsible('Sandra Diaz', vols), a);
    assert.equal(store.matchResponsible('reina sanchez', vols), b);
    assert.equal(store.matchResponsible('Moises Becerra', vols), null); // no es de Nueva Vida
    assert.equal(store.matchResponsible('', vols), null);
  });
});

test('ficha: get, llamadas, historial, datos editables y borrado (sin tocar a la persona)', async (t) => {
  await withDb(t, async (db) => {
    const a = await person(db, 'Persona Siete', '584140000007');
    const v = await person(db, 'Voluntaria Dos');
    const { id } = await store.upsertConsolidation(db, a, { decision_date: '2026-10-05', sede: 'Las Mercedes', assigned_to: v, call_date: '2026-10-08' });
    await store.logCall(db, id, { calledBy: v, result: 'no_contesto', note: 'Buzón' });
    await store.logCall(db, id, { calledBy: v, result: 'contesto', note: 'Quedó en venir' });
    const row = await store.get(db, id);
    assert.equal(row.full_name, 'Persona Siete');
    assert.equal(row.responsible_name, 'Voluntaria Dos');
    assert.equal(row.decision_iso, '2026-10-05');
    assert.equal(row.call_date_iso, '2026-10-08');
    assert.equal(row.opt_in, false);
    const calls = await store.callsOf(db, id);
    assert.deepEqual(calls.map((c) => [c.result, c.by_name, c.note]), [['contesto', 'Voluntaria Dos', 'Quedó en venir'], ['no_contesto', 'Voluntaria Dos', 'Buzón']]);
    assert.equal((await store.statusLogOf(db, id)).length, 1);
    // la decisión no puede quedar después de una etapa ya marcada
    assert.match(await store.updateData(db, id, { decisionDate: '2026-10-09', sede: 'x', invitedBy: '', assignedTo: v }), /Llamada de Nueva Vida/);
    assert.equal(await store.updateData(db, id, { decisionDate: '2026-10-03', sede: 'Nuarito', invitedBy: 'Su tía', assignedTo: null, lastSeen: '2026-10-12' }), null);
    const upd = await store.get(db, id);
    assert.deepEqual([upd.decision_iso, upd.sede, upd.invited_by, upd.assigned_to, upd.seen_iso], ['2026-10-03', 'Nuarito', 'Su tía', null, '2026-10-12']);
    const opts = await store.filterOptions(db);
    assert.deepEqual([opts.sedes, opts.months], [['Nuarito'], ['2026-10']]);
    await store.remove(db, id);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM consolidation_calls')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE id = $1', [a])).rows[0].n, 1);
  });
});
