'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cg = require('../src/care-groups');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { careRemoteRouter } = require('../src/routes/care-remote');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const DEPENDENTS = ['care_group_reports', 'care_group_people', 'care_group_plans', 'care_group_foda', 'care_group_photos', 'care_group_submissions'];

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

/** Un grupo con datos en todas las tablas que dependen de él. */
async function mkGroup(db, name, token) {
  const g = (await db.query("INSERT INTO care_groups (name, leader_name, leader_phone, token) VALUES ($1, 'Líder Prueba', '584140000001', $2) RETURNING *", [name, token])).rows[0];
  await db.query("INSERT INTO care_group_reports (group_id, meeting_date, attendance, guests_count) VALUES ($1, $2, 8, 2), ($1, $3, 9, 1)", [g.id, TODAY, '2026-01-01']);
  await db.query("INSERT INTO care_group_people (group_id, name, milestones) VALUES ($1, 'Persona Uno', '{NV}'), ($1, 'Persona Dos', '{}')", [g.id]);
  await db.query("INSERT INTO care_group_plans (group_id, month, weeks) VALUES ($1, '2026-10', '[]')", [g.id]);
  await db.query("INSERT INTO care_group_foda (group_id, quarter, strengths) VALUES ($1, '2026-Q4', 'Unidad')", [g.id]);
  await db.query('INSERT INTO care_group_photos (group_id, data) VALUES ($1, $2)', [g.id, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
  await db.query("INSERT INTO care_group_submissions (group_id, leader_name) VALUES ($1, 'Respuesta de la planilla')", [g.id]);
  return g;
}
const counts = async (db, groupId) =>
  Object.fromEntries(await Promise.all(DEPENDENTS.map(async (t) => [t, (await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE group_id = $1`, [groupId])).rows[0].n])));

test('el esquema: toda tabla con clave foránea a care_groups borra en cascada (si agregas una nueva sin cascada, esta prueba falla)', async (t) => {
  await withDb(t, async (db) => {
    const fks = (await db.query("SELECT conrelid::regclass::text AS tabla, confdeltype AS regla FROM pg_constraint WHERE contype = 'f' AND confrelid = 'care_groups'::regclass")).rows;
    assert.deepEqual(fks.map((f) => f.tabla).sort(), [...DEPENDENTS].sort()); // son exactamente las que borra la función
    for (const f of fks) assert.equal(f.regla, 'c', `${f.tabla} debe ser ON DELETE CASCADE`);
  });
});

test('deleteGroups: borra el grupo y todo lo suyo, no toca a los demás ni a las personas, e ignora lo que no existe', async (t) => {
  await withDb(t, async (db) => {
    const a = await mkGroup(db, 'Grupo A', 'tokenA1234567890abcd');
    const b = await mkGroup(db, 'Grupo B', 'tokenB1234567890abcd');
    await db.query("INSERT INTO care_group_submissions (group_id, new_group_name, leader_name) VALUES (NULL, 'Grupo nuevo candidato', 'Otra respuesta')"); // sin grupo todavía
    await db.query("INSERT INTO people (full_name, phone) VALUES ('Persona Intacta', '584149990000')");
    const antesB = await counts(db, b.id);
    assert.ok(Object.values(antesB).every((n) => n >= 1), 'B tiene datos en todas las tablas');

    assert.deepEqual(await cg.deleteGroups(db, [999999]), []);
    assert.deepEqual(await cg.deleteGroups(db, []), []);
    assert.deepEqual(await cg.deleteGroups(db, ['x', -3, 0, null]), []);
    assert.equal(await db.query('SELECT 1 FROM care_groups').then((r) => r.rows.length), 2);

    const out = await cg.deleteGroups(db, [a.id, 999999]);
    assert.deepEqual(out, [{ id: a.id, name: 'Grupo A' }]);
    assert.equal((await db.query('SELECT 1 FROM care_groups WHERE id = $1', [a.id])).rows.length, 0);
    assert.ok(Object.values(await counts(db, a.id)).every((n) => n === 0), 'nada de A queda en ninguna tabla');
    assert.deepEqual(await counts(db, b.id), antesB); // B, intacto
    assert.equal((await db.query('SELECT token FROM care_groups WHERE id = $1', [b.id])).rows[0].token, 'tokenB1234567890abcd');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_submissions WHERE group_id IS NULL')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 1);
    // ninguna fila huérfana en ninguna tabla
    for (const tb of DEPENDENTS) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${tb} WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM care_groups)`)).rows[0].n, 0, tb);
    }
  });
});

test('transacción: si algo falla a la mitad, no se borra nada (ni el grupo ni sus datos)', async (t) => {
  await withDb(t, async (db) => {
    const a = await mkGroup(db, 'Grupo A', 'tokenA1234567890abcd');
    const b = await mkGroup(db, 'Grupo B', 'tokenB1234567890abcd');
    // la foto de B "no se deja borrar": al borrar en cascada falla y debe deshacerse también lo de A
    await db.query("CREATE FUNCTION bloquear() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'foto bloqueada'; END $$ LANGUAGE plpgsql");
    await db.query('CREATE TRIGGER bloquear_foto BEFORE DELETE ON care_group_photos FOR EACH ROW WHEN (OLD.group_id = ' + b.id + ') EXECUTE FUNCTION bloquear()');
    await assert.rejects(() => cg.deleteGroups(db, [a.id, b.id]), /foto bloqueada/);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM care_groups').then((r) => r.rows[0].n), 2);
    assert.ok(Object.values(await counts(db, a.id)).every((n) => n >= 1), 'lo de A sigue ahí');
    assert.ok(Object.values(await counts(db, b.id)).every((n) => n >= 1), 'lo de B sigue ahí');
  });
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
  const post = (p, entries = []) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(entries), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

test('POST /grupos/:id/borrar: borra el grupo y su enlace, avisa con el nombre, y un id que no existe da error', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const a = await mkGroup(db, 'Grupo "A" <b>', 'tokenA1234567890abcd');
    const b = await mkGroup(db, 'Grupo B', 'tokenB1234567890abcd');
    assert.equal((await get('/g/tokenA1234567890abcd')).status, 200); // su enlace funciona

    const r = await post(`/grupos/${a.id}/borrar`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location').split('?')[0], '/grupos');
    assert.equal(loc(r), '/grupos?ok=Grupo "Grupo "A" <b>" borrado');
    assert.equal((await get('/g/tokenA1234567890abcd')).status, 404); // el enlace del líder ya no existe
    assert.equal((await get(`/grupos/${a.id}`)).status, 303); // la ficha tampoco
    assert.equal((await get('/g/tokenB1234567890abcd')).status, 200); // el de B sigue
    assert.ok(Object.values(await counts(db, b.id)).every((n) => n >= 1));

    const again = await post(`/grupos/${a.id}/borrar`); // ya no existe
    assert.equal(again.status, 303);
    assert.match(loc(again), /^\/grupos\?err=Ese grupo no existe\.$/);
    assert.equal((await post('/grupos/999999/borrar')).status, 303);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM care_groups').then((r) => r.rows[0].n), 1);
    assert.equal((await post('/grupos/abc/borrar')).status, 404); // un id que no es número ni entra a la ruta
    // el mensaje se escapa en la lista
    const list = await (await get(`/grupos?ok=${encodeURIComponent('Grupo "x" <img src=x onerror=1> borrado')}`)).text();
    assert.ok(!list.includes('<img src=x'));
  });
});

test('POST /grupos/borrar-varios: borra los elegidos, cuenta los que se borraron y no toca los demás', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const [a, b, c] = [await mkGroup(db, 'Grupo A', 'tokenA1234567890abcd'), await mkGroup(db, 'Grupo B', 'tokenB1234567890abcd'), await mkGroup(db, 'Grupo C', 'tokenC1234567890abcd')];
    assert.match(loc(await post('/grupos/borrar-varios', [])), /err=Elige al menos un grupo\.|Elige al menos un grupo\./);
    assert.match(loc(await post('/grupos/borrar-varios', [['ids', 'abc'], ['ids', '-1']])), /Elige al menos un grupo/);
    assert.match(loc(await post('/grupos/borrar-varios', [['ids', '999999']])), /Esos grupos ya no existen/);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM care_groups').then((r) => r.rows[0].n), 3);

    const r = await post('/grupos/borrar-varios', [['ids', String(a.id)], ['ids', String(b.id)], ['ids', '999999'], ['ids', String(a.id)]]); // uno repetido y otro inexistente
    assert.equal(loc(r), '/grupos?ok=2 grupos borrados');
    assert.deepEqual((await db.query('SELECT name FROM care_groups')).rows.map((x) => x.name), ['Grupo C']);
    for (const g of [a, b]) assert.ok(Object.values(await counts(db, g.id)).every((n) => n === 0));
    assert.ok(Object.values(await counts(db, c.id)).every((n) => n >= 1)); // C, intacto

    const one = await post('/grupos/borrar-varios', [['ids', String(c.id)]]); // un solo id (no un arreglo)
    assert.equal(loc(one), '/grupos?ok=Grupo "Grupo C" borrado');
  });
});

test('botones: ficha (junto a Desactivar), una ✕ por fila, casillas y "Borrar seleccionados" en la lista, ✕ en "Pedir datos"; todo con confirmación', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db, 'Grupo "Raro" & Co', 'tokenA1234567890abcd');
    const msg = '¿Seguro que quieres borrar el grupo &quot;Grupo &quot;Raro&quot; &amp; Co&quot;? Se borrarán también sus reportes y su enlace. Esto no se puede deshacer.';

    const ficha = await (await get(`/grupos/${g.id}`)).text();
    const i = ficha.indexOf('Desactivar grupo');
    const j = ficha.indexOf('Borrar grupo');
    assert.ok(i > 0 && j > i && j - i < 700, 'Borrar grupo va junto a Desactivar grupo');
    assert.match(ficha, new RegExp(`<form class="inline" method="post" action="/grupos/${g.id}/borrar" data-msg="${msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" onsubmit="return confirm\\(this.dataset.msg\\)"><button class="small danger">Borrar grupo</button>`));

    const list = await (await get('/grupos')).text();
    assert.match(list, new RegExp(`<input type="checkbox" name="ids" value="${g.id}"`));
    assert.match(list, new RegExp(`<button type="submit" form="del-${g.id}" class="small danger"[^>]*>✕</button>`));
    assert.match(list, new RegExp(`<form id="del-${g.id}" method="post" action="/grupos/${g.id}/borrar" data-msg="`));
    assert.ok(list.includes(msg)); // el mismo texto de confirmación
    assert.match(list, /action="\/grupos\/borrar-varios"/);
    assert.match(list, /Borrar seleccionados/);
    assert.match(list, /'¿Borrar ' \+ n \+ ' grupo'/); // la confirmación con la cantidad
    assert.ok(!list.includes('Grupo "Raro" & Co')); // el nombre va escapado
    // los formularios por fila no están dentro del formulario de selección (no hay formularios anidados)
    const bulk = list.slice(list.indexOf('id="bulk"'), list.indexOf('</form>', list.indexOf('id="bulk"')));
    assert.ok(!bulk.includes('<form'));

    const ask = await (await get('/grupos/solicitud')).text();
    assert.match(ask, new RegExp(`<button type="submit" form="del-${g.id}" class="small danger"`));
    assert.ok(ask.includes(msg));
  });
});

test('solo con sesión: sin iniciar sesión no se puede borrar nada; con sesión sí', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const cfg = loadConfig({ DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'http://localhost', ADMIN_PASSWORD: 'clave-de-prueba-123', SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'true' });
  const channels = { whatsapp: { available: false }, email: { available: false } };
  const server = createApp({ db: h.db, config: cfg, channels }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = (o) => new URLSearchParams(o).toString();
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  try {
    const g = await mkGroup(h.db, 'Grupo A', 'tokenA1234567890abcd');
    const other = await mkGroup(h.db, 'Grupo B', 'tokenB1234567890abcd');

    for (const [path, body] of [[`/grupos/${g.id}/borrar`, ''], ['/grupos/borrar-varios', form({ ids: String(g.id) })]]) {
      const r = await fetch(base + path, { method: 'POST', headers: H, body, redirect: 'manual' });
      assert.equal(r.status, 401, path); // el guardia de sesión rechaza los POST sin sesión (los GET los manda a /entrar)
    }
    const bad = await fetch(base + `/grupos/${g.id}/borrar`, { method: 'POST', headers: { ...H, Cookie: 'lbnc_session=inventada' }, body: '', redirect: 'manual' });
    assert.equal(bad.status, 401); // una cookie falsa tampoco sirve
    assert.equal(await h.db.query('SELECT count(*)::int AS n FROM care_groups').then((r) => r.rows[0].n), 2); // no se borró nada

    const login = await fetch(base + '/entrar', { method: 'POST', headers: H, body: form({ password: 'clave-de-prueba-123' }), redirect: 'manual' });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const ok = await fetch(base + `/grupos/${g.id}/borrar`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: '', redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.match(decodeURIComponent(ok.headers.get('location')), /^\/grupos\?ok=Grupo\+?"?Grupo A"? borrado|ok=Grupo/);
    assert.deepEqual((await h.db.query('SELECT name FROM care_groups')).rows.map((r) => r.name), ['Grupo B']);
    assert.ok(Object.values(await counts(h.db, other.id)).every((n) => n >= 1));
  } finally {
    server.close();
    await h.close();
  }
});
