'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pw = require('../src/people-wipe');
const repo = require('../src/repo');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { peopleWipeRouter, CONFIRM } = require('../src/routes/people-wipe');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

/** Tres personas comunes y una con acceso al panel, con datos en todo lo que depende de ellas. */
async function seed(db) {
  const person = async (name, phone, extra = '') => (await db.query(`INSERT INTO people (full_name, phone, opt_in${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, $2, TRUE${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, [name, phone])).rows[0].id;
  const [a, b, c] = [await person('Ana Uno', '584140000001'), await person('Luis Dos', '584140000002'), await person('Eva Tres', '584140000003')];
  const admin = (await db.query("INSERT INTO people (full_name, phone, google_email, access_level) VALUES ('Admin Panel', '584140000009', 'admin@ejemplo.com', 'admin') RETURNING id")).rows[0].id;
  const m = (await db.query('INSERT INTO ministries (name, coordinator_id) VALUES ($1, $2) RETURNING id', ['Alabanza', a])).rows[0].id;
  await db.query('INSERT INTO person_ministries VALUES ($1, $3), ($2, $3), ($4, $3)', [a, b, m, admin]);
  const ev = (await db.query("INSERT INTO events (title, starts_at) VALUES ('Evento', now() + interval '3 days') RETURNING id")).rows[0].id;
  await repo.addParticipant(db, ev, a);
  await repo.addParticipant(db, ev, b);
  await repo.addParticipant(db, ev, admin);
  await db.query('INSERT INTO consolidation (person_id, decision_date) VALUES ($1, current_date)', [a]);
  await db.query("INSERT INTO nueva_vida (full_name, person_id) VALUES ('Registro NV', $1)", [b]);
  await db.query("INSERT INTO agent_messages (phone, person_id, direction, body) VALUES ('584140000001', $1, 'in', 'hola')", [a]);
  await db.query('INSERT INTO people_photos (person_id, data) VALUES ($1, $2)', [c, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
  await db.query("INSERT INTO member_submissions (person_id, full_name, phone) VALUES ($1, 'Eva Tres', '584140000003')", [c]);
  await db.query("INSERT INTO care_groups (name, token) VALUES ('Grupo intacto', 'tokenintacto1234567890')");
  return { a, b, c, admin, m, ev };
}
const n = async (db, sql, ...p) => (await db.query(sql, p)).rows[0].n;

test('el impacto: cuántas se borran, a quiénes se conserva y qué arrastra cada tabla, sin borrar nada', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const i = await pw.wipeImpact(db);
    assert.deepEqual([i.total, i.keep, i.toDelete], [4, 1, 3]);
    assert.deepEqual(i.keepNames, ['Admin Panel']);
    const get = (table) => i.effects.find((e) => e.table === table && e.rows > 0);
    assert.deepEqual([get('person_ministries').rule, get('person_ministries').rows], ['cascade', 2]); // la del admin no cuenta
    assert.deepEqual([get('event_participants').rule, get('event_participants').rows], ['cascade', 2]);
    assert.deepEqual([get('consolidation').rule, get('consolidation').rows], ['cascade', 1]);
    assert.equal(get('people_photos').rows, 1);
    assert.equal(get('member_submissions').rows, 1);
    assert.deepEqual([get('nueva_vida').rule, get('nueva_vida').rows], ['null', 1]);
    assert.deepEqual([get('agent_messages').rule, get('agent_messages').rows], ['null', 1]);
    assert.deepEqual([get('ministries').rule, get('ministries').label], ['null', 'ministerios que quedan sin coordinador']);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM people'), 4); // mirar no borra
  });
});

test('wipePeople: borra las personas comunes y lo que depende de ellas; conserva al de acceso al panel y todo lo demás', async (t) => {
  await withDb(t, async (db) => {
    const s = await seed(db);
    const out = await pw.wipePeople(db);
    assert.deepEqual([out.toDelete, out.keep], [3, 1]);
    assert.deepEqual((await db.query('SELECT full_name, access_level FROM people')).rows, [{ full_name: 'Admin Panel', access_level: 'admin' }]);
    // lo que estaba en cascada se fue; lo del administrador se queda
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM person_ministries'), 1);
    assert.equal(await n(db, 'SELECT person_id AS n FROM person_ministries'), s.admin);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM event_participants'), 1);
    for (const tb of ['consolidation', 'people_photos', 'member_submissions']) assert.equal(await n(db, `SELECT count(*)::int AS n FROM ${tb}`), 0, tb);
    // lo que solo pierde el vínculo se conserva
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM nueva_vida WHERE person_id IS NULL'), 1);
    assert.equal(await n(db, "SELECT count(*)::int AS n FROM agent_messages WHERE person_id IS NULL AND body = 'hola'"), 1);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM ministries WHERE coordinator_id IS NULL AND name = $1', 'Alabanza'), 1);
    // y lo que no es de personas, intacto
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM events'), 1);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM care_groups'), 1);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM ministries'), 1);
  });
});

test('transacción: si algo falla a la mitad, no se borra ninguna persona', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    await db.query("CREATE FUNCTION bloquear() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'foto bloqueada'; END $$ LANGUAGE plpgsql");
    await db.query('CREATE TRIGGER bloquear_foto BEFORE DELETE ON people_photos FOR EACH ROW EXECUTE FUNCTION bloquear()');
    await assert.rejects(() => pw.wipePeople(db), /foto bloqueada/);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM people'), 4);
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM event_participants'), 3);
  });
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(peopleWipeRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

test('la pantalla: avisa que no se puede deshacer, ofrece la copia en CSV, lista lo que se lleva y a quién conserva; sin la frase no borra', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await seed(db);
    const r = await get('/personas/borrar-todas');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /Esto no se puede deshacer/);
    assert.match(html, /<strong>3 personas<\/strong> de las 4/);
    assert.match(html, /href="\/personas\/exportar\.csv">Descargar copia de la lista/);
    assert.match(html, /participaciones en eventos/);
    assert.match(html, /Se conservan, sin la persona/);
    assert.match(html, /1 persona se conserva/);
    assert.match(html, /Admin Panel/);
    assert.ok(html.includes(CONFIRM));

    for (const confirmar of ['', 'borrar todas', 'BORRAR', 'si', 'BORRAR TODAS LAS']) {
      const x = await post('/personas/borrar-todas', { confirmar });
      assert.equal(x.status, 303);
      assert.match(loc(x), /No se borró nada/);
    }
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM people'), 4);

    const ok = await post('/personas/borrar-todas', { confirmar: ` ${CONFIRM} ` });
    assert.equal(ok.status, 303);
    assert.equal(loc(ok), '/personas?ok=Listo: se borraron 3 personas y se conservaron 1 persona con acceso al panel.');
    assert.equal(await n(db, 'SELECT count(*)::int AS n FROM people'), 1);
    assert.match(await (await get('/personas/borrar-todas')).text(), /No hay personas para borrar/); // ya no queda nada que borrar
  });
});

test('solo con sesión: sin iniciar sesión no se puede ver ni borrar nada; con sesión sí; y en Personas hay un enlace discreto', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const cfg = loadConfig({ DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'http://localhost', ADMIN_PASSWORD: 'clave-de-prueba-123', SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'true' });
  const server = createApp({ db: h.db, config: cfg, channels: { whatsapp: { available: false }, email: { available: false } } }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  try {
    await seed(h.db);
    const form = new URLSearchParams({ confirmar: CONFIRM }).toString();
    const noSession = await fetch(base + '/personas/borrar-todas', { method: 'POST', headers: H, body: form, redirect: 'manual' });
    assert.equal(noSession.status, 401);
    const fake = await fetch(base + '/personas/borrar-todas', { method: 'POST', headers: { ...H, Cookie: 'lbnc_session=inventada' }, body: form, redirect: 'manual' });
    assert.equal(fake.status, 401);
    assert.equal((await fetch(base + '/personas/borrar-todas', { redirect: 'manual' })).headers.get('location'), '/entrar'); // ni la pantalla
    assert.equal(await n(h.db, 'SELECT count(*)::int AS n FROM people'), 4);

    const login = await fetch(base + '/entrar', { method: 'POST', headers: H, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const personas = await (await fetch(base + '/personas', { headers: { Cookie: cookie } })).text();
    assert.match(personas, /<a href="\/personas\/borrar-todas">Borrar toda la lista de personas…<\/a>/);
    const ok = await fetch(base + '/personas/borrar-todas', { method: 'POST', headers: { ...H, Cookie: cookie }, body: form, redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal(await n(h.db, 'SELECT count(*)::int AS n FROM people'), 1);
  } finally {
    server.close();
    await h.close();
  }
});
