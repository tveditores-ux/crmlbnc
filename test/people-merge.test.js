'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pm = require('../src/people-merge');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.

/* ------------------------- Funciones puras ------------------------- */

test('nameKey ignora tildes, mayúsculas, emojis, signos y espacios de más', () => {
  assert.equal(pm.nameKey('  María  PÉREZ 🙏 '), 'maria perez');
  assert.equal(pm.nameKey('Jose-Luis, Rojas!!'), 'jose luis rojas');
  assert.equal(pm.nameKey('Ñandú   Ángel'), 'nandu angel');
  assert.equal(pm.nameKey('😀'), '');
  assert.equal(pm.nameKey(null), '');
  assert.equal(pm.nameKey('Ana ‍♀️ Torres'), 'ana torres'); // emoji compuesto
});

test('roles y notas se unen sin perder ni repetir', () => {
  assert.equal(pm.mergeRoles('Diácono, líder', 'LIDER, Admin grupo WhatsApp'), 'Diácono, líder, Admin grupo WhatsApp');
  assert.equal(pm.mergeRoles('', ''), '');
  assert.equal(pm.mergeNotes('', 'x'), 'x');
  assert.equal(pm.mergeNotes('x', ''), 'x');
  assert.equal(pm.mergeNotes('x y', 'y'), 'x y'); // ya estaba contenida
  assert.equal(pm.mergeNotes('x', 'y'), 'x\n---\ny');
});

const P = (o) => ({ id: 1, full_name: 'Ana', phone: null, email: null, google_email: null, access_level: 'ninguno', role: '', notes: '', whatsapp_name: '', membership: '', in_official_group: false, active: true, opt_in: false, created_at: '2025-01-01T00:00:00Z', ...o });

test('se conserva la ficha más antigua, sin importar el orden en que se elija', () => {
  const old = P({ id: 9, created_at: '2024-01-01T00:00:00Z' });
  const neu = P({ id: 2, created_at: '2025-06-01T00:00:00Z' });
  assert.equal(pm.pickKeep(old, neu)[0].id, 9);
  assert.equal(pm.pickKeep(neu, old)[0].id, 9);
  const same = [P({ id: 5 }), P({ id: 3 })];
  assert.equal(pm.pickKeep(same[0], same[1])[0].id, 3); // misma fecha: gana el id menor
});

test('campos que quedan: copia lo que falta, une, y NO hereda el consentimiento salvo que se pida', () => {
  const keep = P({ id: 1, phone: '584141112233', opt_in: false });
  const other = P({ id: 2, full_name: 'Ana', email: 'a@ejemplo.com', notes: 'nota', role: 'Líder', membership: 'amigo', whatsapp_name: 'Ani', in_official_group: true, opt_in: true, active: false });
  const m = pm.mergedFields(keep, other);
  assert.deepEqual([m.phone, m.email, m.notes, m.role, m.membership, m.whatsapp_name, m.in_official_group, m.active, m.opt_in], ['584141112233', 'a@ejemplo.com', 'nota', 'Líder', 'amigo', 'Ani', true, true, false]);
  assert.equal(pm.mergedFields(keep, other, { inheritOptIn: true }).opt_in, true);
  assert.equal(pm.mergedFields(P({ opt_in: true }), P({ opt_in: false })).opt_in, true); // el propio consentimiento no se pierde
  // miembro y amigo a la vez: queda miembro
  assert.equal(pm.mergedFields(P({ membership: 'amigo' }), P({ membership: 'miembro' })).membership, 'miembro');
  assert.equal(pm.mergedFields(P({ membership: 'amigo' }), P({ membership: 'amigo' })).membership, 'amigo');
  // el nombre que solo era un teléfono se cambia por el nombre real
  assert.equal(pm.mergedFields(P({ full_name: '0414-000.00.01' }), P({ full_name: 'Ana Real' })).full_name, 'Ana Real');
  assert.equal(pm.mergedFields(P({ full_name: 'Ana Real' }), P({ full_name: '0414-000.00.01' })).full_name, 'Ana Real');
  assert.equal(pm.mergedFields(P({ full_name: 'Ana Uno' }), P({ full_name: 'Ana Dos' })).full_name, 'Ana Uno');
  // datos únicos distintos: el de la ficha sobrante queda anotado, no se pierde
  const lost = pm.mergedFields(P({ phone: '584141112233', email: 'a@x.com' }), P({ phone: '584245550000', email: 'b@x.com' }));
  assert.match(lost.notes, /Teléfono de la ficha unida: 0424-555\.00\.00/);
  assert.match(lost.notes, /Correo de la ficha unida: b@x\.com/);
  assert.equal(lost.phone, '584141112233');
  // el acceso al panel viaja con su correo de Google
  const acc = pm.mergedFields(P({}), P({ google_email: 'g@x.com', access_level: 'admin' }));
  assert.deepEqual([acc.google_email, acc.access_level], ['g@x.com', 'admin']);
  const stay = pm.mergedFields(P({ google_email: 'k@x.com', access_level: 'ninguno' }), P({ google_email: 'g@x.com', access_level: 'admin' }));
  assert.deepEqual([stay.google_email, stay.access_level], ['k@x.com', 'ninguno']); // no se sobrescribe lo que ya tenía
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

const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const n = async (db, sql, params = []) => (await one(db, `SELECT count(*)::int AS n FROM (${sql}) s`, params)).n;
const addPerson = async (db, o) =>
  (
    await one(
      db,
      `INSERT INTO people (full_name, phone, email, role, notes, membership, opt_in, active, whatsapp_name, in_official_group, google_email, access_level, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [o.name, o.phone ?? null, o.email ?? null, o.role ?? '', o.notes ?? '', o.membership ?? '', o.opt_in ?? false, o.active ?? true, o.wa ?? '', o.group ?? false, o.google ?? null, o.access ?? 'ninguno', o.created ?? '2025-01-01T00:00:00Z']
    )
  ).id;

/** Una situación enredada: la misma persona repartida en todas las tablas. Devuelve los ids. */
async function seed(db) {
  const keep = await addPerson(db, { name: 'Ana Torres', phone: '584141112233', notes: 'nota vieja', role: 'Diácono', created: '2024-03-01T00:00:00Z' });
  const other = await addPerson(db, {
    name: 'ANA TÓRRES 🙏', email: 'ana@ejemplo.com', notes: 'nota nueva', role: 'Líder', membership: 'amigo', wa: 'Ani', group: true, opt_in: true, created: '2025-05-01T00:00:00Z',
  });
  const third = await addPerson(db, { name: 'Tercera Persona', phone: '584240000009' });
  const m1 = (await one(db, `INSERT INTO ministries (name, coordinator_id) VALUES ('Alabanza', NULL) RETURNING id`)).id;
  const m2 = (await one(db, `INSERT INTO ministries (name, coordinator_id) VALUES ('Diáconos', $1) RETURNING id`, [other])).id;
  await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$3),($2,$3),($2,$4)', [keep, other, m1, m2]);
  const ev = async (t) => (await one(db, `INSERT INTO events (title, starts_at) VALUES ($1, now() + interval '10 days') RETURNING id`, [t])).id;
  const [e1, e2, e3] = [await ev('Ambas'), await ev('Solo la otra'), await ev('Solo la conservada')];
  const part = async (e, p, status, tok) => (await one(db, `INSERT INTO event_participants (event_id, person_id, status, token, responded_at) VALUES ($1,$2,$3,$4, CASE WHEN $3 <> 'pendiente' THEN now() END) RETURNING id`, [e, p, status, tok])).id;
  const kE1 = await part(e1, keep, 'pendiente', 'tok-k1');
  const oE1 = await part(e1, other, 'confirmado', 'tok-o1');
  const oE2 = await part(e2, other, 'pendiente', 'tok-o2');
  await part(e3, keep, 'no_puede', 'tok-k3');
  const notif = (pid, kind, ch) => db.query(`INSERT INTO notifications (participant_id, kind, channel, status) VALUES ($1,$2,$3,'enviado')`, [pid, kind, ch]);
  await notif(kE1, '1w', 'whatsapp'); // la conservada ya tenía este
  await notif(oE1, '1w', 'whatsapp'); // repetido: no se puede pasar
  await notif(oE1, '1d', 'whatsapp'); // este sí se pasa
  await notif(oE2, '1m', 'email');
  await db.query(`INSERT INTO agent_messages (phone, person_id, direction, body) VALUES ('584245550000', $1, 'in', 'hola'), ('584245550000', $1, 'out', 'respuesta')`, [other]);
  // consolidación: las dos personas la tenían
  const ck = (await one(db, `INSERT INTO consolidation (person_id, decision_date, sede, call_date, call_by, group_date, historical) VALUES ($1,'2025-02-10','Las Mercedes','2025-02-11',$2,NULL,FALSE) RETURNING id`, [keep, third])).id;
  const co = (await one(db, `INSERT INTO consolidation (person_id, decision_date, sede, invited_by, call_date, meeting_date, meeting_by, group_date, group_name, assigned_to, do_not_call, historical)
                              VALUES ($1,'2025-01-20','','Un amigo','2025-01-25','2025-02-01',$2,'2025-03-01','GdC Prueba',$2,TRUE,TRUE) RETURNING id`, [other, other])).id;
  await db.query(`INSERT INTO consolidation_calls (consolidation_id, called_by, result, note) VALUES ($1,$3,'contesto','de la conservada'),($2,$3,'no_contesto','de la otra')`, [ck, co, third]);
  await db.query(`INSERT INTO consolidation_status_log (consolidation_id, status, changed_on) VALUES ($1,'activo','2025-02-10'),($2,'activo','2025-01-20')`, [ck, co]);
  // alguien más tenía a la "otra" como responsable
  const tc = (await one(db, `INSERT INTO consolidation (person_id, decision_date, assigned_to, call_by) VALUES ($1,'2025-04-01',$2,$2) RETURNING id`, [third, other])).id;
  await db.query(`INSERT INTO consolidation_calls (consolidation_id, called_by, result) VALUES ($1,$2,'contesto')`, [tc, other]);
  const nv = (await one(db, `INSERT INTO nueva_vida (full_name, person_id, consolidation_id) VALUES ('Registro de Ana', $1, $2) RETURNING id`, [other, co])).id;
  return { keep, other, third, m1, m2, e1, e2, e3, kE1, oE1, oE2, ck, co, tc, nv };
}

test('unir: una situación enredada queda en una sola ficha, con todo pasado y nada repetido', async (t) => {
  await withDb(t, async (db) => {
    const s = await seed(db);
    const sum = await pm.mergePeople(db, s.other, s.keep); // se elige en el orden "malo": gana igual la más antigua
    assert.deepEqual([sum.keepId, sum.removedId], [s.keep, s.other]);
    assert.deepEqual([sum.ministries, sum.events, sum.conversations, sum.consolidation, sum.nuevaVida], [1, 2, 2, 'unida', 1]);

    // la ficha sobrante ya no existe y la conservada reúne los datos
    assert.equal(await n(db, 'SELECT 1 FROM people WHERE id = $1', [s.other]), 0);
    const p = await one(db, 'SELECT * FROM people WHERE id = $1', [s.keep]);
    assert.deepEqual([p.full_name, p.phone, p.email, p.role, p.membership, p.whatsapp_name, p.in_official_group, p.opt_in], ['Ana Torres', '584141112233', 'ana@ejemplo.com', 'Diácono, Líder', 'amigo', 'Ani', true, false]);
    assert.equal(p.notes, 'nota vieja\n---\nnota nueva');

    // ministerios unidos, sin repetir; la coordinación pasó
    assert.deepEqual((await db.query('SELECT ministry_id FROM person_ministries WHERE person_id = $1 ORDER BY 1', [s.keep])).rows.map((r) => r.ministry_id), [s.m1, s.m2].sort((a, b) => a - b));
    assert.equal((await one(db, 'SELECT coordinator_id FROM ministries WHERE id = $1', [s.m2])).coordinator_id, s.keep);

    // eventos: uno por evento; la respuesta más informativa gana; los enlaces de lo movido siguen valiendo
    const parts = (await db.query('SELECT event_id, status, token FROM event_participants WHERE person_id = $1 ORDER BY event_id', [s.keep])).rows;
    assert.deepEqual(parts.map((x) => [x.event_id, x.status]), [[s.e1, 'confirmado'], [s.e2, 'pendiente'], [s.e3, 'no_puede']]);
    assert.ok(parts.find((x) => x.event_id === s.e2).token === 'tok-o2');
    assert.equal(await n(db, 'SELECT 1 FROM event_participants WHERE person_id = $1', [s.other]), 0);
    // mensajes: se pasan los que no estaban repetidos
    const notifs = (await db.query('SELECT participant_id, kind, channel FROM notifications ORDER BY id')).rows.map((x) => `${x.participant_id === s.kE1 ? 'e1' : 'e2'}:${x.kind}:${x.channel}`);
    assert.deepEqual(notifs.sort(), ['e1:1d:whatsapp', 'e1:1w:whatsapp', 'e2:1m:email']);

    // conversaciones
    assert.equal(await n(db, 'SELECT 1 FROM agent_messages WHERE person_id = $1', [s.keep]), 2);

    // consolidación unida en la de la ficha conservada
    assert.equal(await n(db, 'SELECT 1 FROM consolidation WHERE person_id = $1', [s.keep]), 1);
    assert.equal(await n(db, 'SELECT 1 FROM consolidation WHERE id = $1', [s.co]), 0);
    const c = await one(db, `SELECT decision_date::text AS d, sede, invited_by, call_date::text AS call, meeting_date::text AS meet, meeting_by, group_date::text AS g, group_name, assigned_to, do_not_call, historical FROM consolidation WHERE id = $1`, [s.ck]);
    assert.deepEqual(c, { d: '2025-01-20', sede: 'Las Mercedes', invited_by: 'Un amigo', call: '2025-02-11', meet: '2025-02-01', meeting_by: s.keep, g: '2025-03-01', group_name: 'GdC Prueba', assigned_to: s.keep, do_not_call: true, historical: false });
    assert.equal(await n(db, 'SELECT 1 FROM consolidation_calls WHERE consolidation_id = $1', [s.ck]), 2);
    assert.equal(await n(db, 'SELECT 1 FROM consolidation_status_log WHERE consolidation_id = $1', [s.ck]), 2);
    // donde la otra era responsable o llamó, ahora figura la conservada
    const t3 = await one(db, 'SELECT assigned_to, call_by FROM consolidation WHERE id = $1', [s.tc]);
    assert.deepEqual([t3.assigned_to, t3.call_by], [s.keep, s.keep]);
    assert.equal((await one(db, `SELECT called_by FROM consolidation_calls WHERE consolidation_id = $1`, [s.tc])).called_by, s.keep);
    // Nueva Vida apunta a la ficha y a la consolidación que quedaron
    const nv = await one(db, 'SELECT person_id, consolidation_id FROM nueva_vida WHERE id = $1', [s.nv]);
    assert.deepEqual([nv.person_id, nv.consolidation_id], [s.keep, s.ck]);
    // nada quedó apuntando a la ficha eliminada
    for (const sql of [
      'SELECT 1 FROM ministries WHERE coordinator_id = $1', 'SELECT 1 FROM agent_messages WHERE person_id = $1', 'SELECT 1 FROM nueva_vida WHERE person_id = $1',
      'SELECT 1 FROM consolidation_calls WHERE called_by = $1', 'SELECT 1 FROM consolidation WHERE assigned_to = $1 OR call_by = $1 OR meeting_by = $1 OR group_by = $1',
    ]) assert.equal(await n(db, sql, [s.other]), 0, sql);
    assert.equal(sum.optInNotInherited, true); // la eliminada había aceptado; no se heredó
  });
});

test('el consentimiento solo se hereda si se pide expresamente', async (t) => {
  await withDb(t, async (db) => {
    const a = await addPerson(db, { name: 'Persona Igual', created: '2024-01-01T00:00:00Z' });
    const b = await addPerson(db, { name: 'Persona Igual', opt_in: true });
    const r1 = await pm.mergePeople(db, a, b);
    assert.equal(r1.optInNotInherited, true);
    assert.equal((await one(db, 'SELECT opt_in FROM people WHERE id = $1', [a])).opt_in, false);
    const c = await addPerson(db, { name: 'Otra Igual', created: '2024-01-01T00:00:00Z' });
    const d = await addPerson(db, { name: 'Otra Igual', opt_in: true });
    const r2 = await pm.mergePeople(db, c, d, { inheritOptIn: true });
    assert.equal(r2.optInNotInherited, false);
    assert.equal((await one(db, 'SELECT opt_in FROM people WHERE id = $1', [c])).opt_in, true);
    // quien ya había aceptado en la ficha conservada no pierde su consentimiento
    const e = await addPerson(db, { name: 'Tercera Igual', opt_in: true, created: '2024-01-01T00:00:00Z' });
    const f = await addPerson(db, { name: 'Tercera Igual' });
    await pm.mergePeople(db, f, e);
    assert.equal((await one(db, 'SELECT opt_in FROM people WHERE id = $1', [e])).opt_in, true);
  });
});

test('unir: teléfono, correo y acceso al panel pasan sin chocar con los índices únicos', async (t) => {
  await withDb(t, async (db) => {
    const keep = await addPerson(db, { name: 'Con Nada', created: '2024-01-01T00:00:00Z' });
    const other = await addPerson(db, { name: 'Con Todo', phone: '584147778899', email: 'todo@ejemplo.com', google: 'todo-google@ejemplo.com', access: 'admin' });
    await pm.mergePeople(db, keep, other);
    const p = await one(db, 'SELECT full_name, phone, email, google_email, access_level FROM people WHERE id = $1', [keep]);
    assert.deepEqual(p, { full_name: 'Con Nada', phone: '584147778899', email: 'todo@ejemplo.com', google_email: 'todo-google@ejemplo.com', access_level: 'admin' });
    // con datos distintos en ambas: se conserva el de la más antigua y el otro queda en las notas
    const a = await addPerson(db, { name: 'Dos Datos', phone: '584141110000', email: 'uno@ejemplo.com', created: '2024-01-01T00:00:00Z' });
    const b = await addPerson(db, { name: 'Dos Datos', phone: '584142220000', email: 'dos@ejemplo.com' });
    await pm.mergePeople(db, b, a);
    const q = await one(db, 'SELECT phone, email, notes FROM people WHERE id = $1', [a]);
    assert.deepEqual([q.phone, q.email], ['584141110000', 'uno@ejemplo.com']);
    assert.match(q.notes, /0414-222\.00\.00/);
    assert.match(q.notes, /dos@ejemplo\.com/);
  });
});

test('consolidación solo en una de las dos: se pasa a la ficha conservada', async (t) => {
  await withDb(t, async (db) => {
    const keep = await addPerson(db, { name: 'Sin Consolidación', created: '2024-01-01T00:00:00Z' });
    const other = await addPerson(db, { name: 'Sin Consolidación' });
    const c = (await one(db, `INSERT INTO consolidation (person_id, decision_date) VALUES ($1,'2025-01-01') RETURNING id`, [other])).id;
    const r = await pm.mergePeople(db, keep, other);
    assert.equal(r.consolidation, 'movida');
    assert.equal((await one(db, 'SELECT person_id FROM consolidation WHERE id = $1', [c])).person_id, keep);
    // y al revés: solo la conservada la tiene
    const k2 = await addPerson(db, { name: 'Otra Sin', created: '2024-01-01T00:00:00Z' });
    const o2 = await addPerson(db, { name: 'Otra Sin' });
    await db.query(`INSERT INTO consolidation (person_id, decision_date) VALUES ($1,'2025-01-01')`, [k2]);
    assert.equal((await pm.mergePeople(db, k2, o2)).consolidation, 'ninguna');
    assert.equal(await n(db, 'SELECT 1 FROM consolidation WHERE person_id = $1', [k2]), 1);
  });
});

test('si algo falla a mitad de la unión, no cambia nada', async (t) => {
  await withDb(t, async (db) => {
    const s = await seed(db);
    await db.query(`CREATE FUNCTION no_borrar() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fallo simulado al borrar'; END $$ LANGUAGE plpgsql`);
    await db.query('CREATE TRIGGER no_borrar_t BEFORE DELETE ON people FOR EACH ROW EXECUTE FUNCTION no_borrar()');
    await assert.rejects(pm.mergePeople(db, s.keep, s.other), /fallo simulado/);
    // la ficha conservada sigue como estaba y la sobrante conserva todo lo suyo
    const k = await one(db, 'SELECT email, notes, membership, opt_in FROM people WHERE id = $1', [s.keep]);
    assert.deepEqual([k.email, k.notes, k.membership, k.opt_in], [null, 'nota vieja', '', false]);
    const o = await one(db, 'SELECT phone, email FROM people WHERE id = $1', [s.other]);
    assert.equal(o.email, 'ana@ejemplo.com');
    assert.equal(await n(db, 'SELECT 1 FROM event_participants WHERE person_id = $1', [s.other]), 2);
    assert.equal(await n(db, 'SELECT 1 FROM person_ministries WHERE person_id = $1', [s.other]), 2);
    assert.equal(await n(db, 'SELECT 1 FROM consolidation WHERE person_id = $1', [s.other]), 1);
    assert.equal(await n(db, 'SELECT 1 FROM agent_messages WHERE person_id = $1', [s.other]), 2);
    assert.equal((await one(db, 'SELECT coordinator_id FROM ministries WHERE id = $1', [s.m2])).coordinator_id, s.other);
  });
});

test('errores: ids repetidos, inexistentes o inválidos', async (t) => {
  await withDb(t, async (db) => {
    const a = await addPerson(db, { name: 'Persona A' });
    await assert.rejects(pm.mergePeople(db, a, a), (e) => e instanceof pm.MergeError && /distintas/.test(e.message));
    await assert.rejects(pm.mergePeople(db, a, 999999), (e) => e instanceof pm.MergeError && /ya no existe/.test(e.message));
    for (const bad of [null, 'x', 0, -3, 1.5]) await assert.rejects(pm.mergePeople(db, a, bad), (e) => e instanceof pm.MergeError && /válidas/.test(e.message));
    assert.equal(await n(db, 'SELECT 1 FROM people'), 1);
  });
});

test('candidatos: mismo nombre sin tildes, mayúsculas ni emojis; los nombres muy cortos o solo de emoji no cuentan', async (t) => {
  await withDb(t, async (db) => {
    const a = await addPerson(db, { name: 'María Pérez', created: '2024-01-01T00:00:00Z' });
    const b = await addPerson(db, { name: 'maria  PEREZ 🙏', created: '2025-01-01T00:00:00Z' });
    const c = await addPerson(db, { name: 'Maria-Perez!', created: '2026-01-01T00:00:00Z' });
    await addPerson(db, { name: 'María López' });
    await addPerson(db, { name: '😀' });
    await addPerson(db, { name: '🙏' });
    await addPerson(db, { name: 'Al' });
    await addPerson(db, { name: 'AL' });
    const d1 = await addPerson(db, { name: 'José Luis', created: '2024-01-01T00:00:00Z' });
    const d2 = await addPerson(db, { name: 'Jose Luis' });
    const groups = await pm.duplicateGroups(db);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].map((p) => p.id), [a, b, c]); // el grupo más grande primero, la más antigua al inicio
    assert.deepEqual(groups[1].map((p) => p.id), [d1, d2]);
    assert.equal(typeof groups[0][0].ministries, 'number');
    assert.deepEqual((await pm.duplicatesOf(db, a)).map((p) => p.id).sort((x, y) => x - y), [b, c]);
    assert.deepEqual(await pm.duplicatesOf(db, 999999), []);
    const s = await pm.summaryOf(db, a);
    assert.deepEqual([s.full_name, s.events, s.consolidation, s.ministries], ['María Pérez', 0, false, []]);
    assert.equal(await pm.summaryOf(db, 999999), null);
  });
});
