'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { EVENT_TYPES, parseEventType } = require('../src/event-types');
const repo = require('../src/repo');
const { layout } = require('../src/views/layout');
const { adminRouter } = require('../src/routes/admin');
const { consolidationRouter } = require('../src/routes/consolidation');
const { conversationsRouter } = require('../src/routes/conversations');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true, sendWindowStart: 8, sendWindowEnd: 20, whatsapp: {}, email: {}, agent: {} };
const channels = { whatsapp: { available: false }, email: { available: false } };
const future = (days) => new Date(Date.now() + days * 86400000);
const localInput = (d) => new Date(d.getTime() - 4 * 3600000).toISOString().slice(0, 16); // hora de Caracas (UTC-4), como el <input datetime-local>

test('los tipos de evento son los tres REDIL; cualquier otra cosa es "evento general"', () => {
  assert.deepEqual(EVENT_TYPES, ['REDIL ordinario', 'REDIL extraordinario', 'REDIL extendido']);
  for (const t of EVENT_TYPES) assert.equal(parseEventType(t), t);
  assert.equal(parseEventType(' REDIL extendido '), 'REDIL extendido');
  for (const bad of ['', 'redil ordinario', 'Culto', undefined, null, 'REDIL ordinario; DROP TABLE events']) assert.equal(parseEventType(bad), '');
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(conversationsRouter({ db: h.db, config }));
  app.use(consolidationRouter({ db: h.db, config }));
  app.use(careGroupsRouter({ db: h.db, config }));
  app.use(adminRouter({ db: h.db, config, channels }));
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

test('crear y editar un evento con su tipo; el tipo no cambia a quién se convoca', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const form = await (await get('/eventos/nuevo')).text();
    assert.match(form, /<label>Tipo de evento<\/label>/);
    assert.match(form, /<option value="">Evento general<\/option>/);
    for (const tipo of EVENT_TYPES) assert.ok(form.includes(`<option >${tipo}</option>`) || form.includes(`<option>${tipo}</option>`), tipo);

    const m = (await db.query("INSERT INTO ministries (name) VALUES ('Líderes') RETURNING id")).rows[0].id;
    const p = (await db.query("INSERT INTO people (full_name, phone, opt_in) VALUES ('Ana Uno', '584140000001', TRUE) RETURNING id")).rows[0].id;
    await db.query('INSERT INTO person_ministries VALUES ($1, $2)', [p, m]);

    const r = await post('/eventos', { title: 'REDIL de octubre', starts_at: localInput(future(10)), location: 'Salón', event_type: 'REDIL extraordinario', ministries: String(m) });
    assert.equal(r.status, 303);
    const e = (await db.query('SELECT * FROM events')).rows[0];
    assert.equal(e.event_type, 'REDIL extraordinario');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1', [e.id])).rows[0].n, 1); // los convocados salen de los ministerios

    // el formulario de edición trae el tipo elegido
    assert.match(await (await get(`/eventos/${e.id}/editar`)).text(), /<option selected>REDIL extraordinario<\/option>/);
    await post(`/eventos/${e.id}`, { title: 'REDIL de octubre', starts_at: localInput(future(10)), location: 'Salón', event_type: 'REDIL extendido', ministries: String(m) });
    assert.equal((await db.query('SELECT event_type FROM events')).rows[0].event_type, 'REDIL extendido');
    // un valor inventado queda como evento general, nunca se guarda tal cual
    await post(`/eventos/${e.id}`, { title: 'REDIL de octubre', starts_at: localInput(future(10)), location: 'Salón', event_type: 'Inventado', ministries: String(m) });
    assert.equal((await db.query('SELECT event_type FROM events')).rows[0].event_type, '');
    // los eventos que ya existían (o creados sin tipo) quedan como eventos generales
    const sin = await repo.saveEvent(db, null, { title: 'Culto', starts_at: future(3), location: '', description: '' }, []);
    assert.equal((await db.query('SELECT event_type FROM events WHERE id = $1', [sin.eventId])).rows[0].event_type, '');
  });
});

test('lista de eventos: etiqueta del tipo, filtro por tipo y "Ver pasados" que conserva el filtro; ficha con su etiqueta', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const ev = (title, type, days) => db.query('INSERT INTO events (title, starts_at, event_type) VALUES ($1, $2, $3) RETURNING id', [title, future(days), type]).then((r) => r.rows[0].id);
    const ord = await ev('Reunión A', 'REDIL ordinario', 5);
    await ev('Reunión B', 'REDIL extendido', 6);
    await ev('Culto general', '', 7);
    await ev('REDIL viejo', 'REDIL ordinario', -9);

    const all = await (await get('/eventos')).text();
    for (const x of ['Reunión A', 'Reunión B', 'Culto general']) assert.ok(all.includes(x), x);
    assert.match(all, /<span class="badge b-ok">REDIL ordinario<\/span>/);
    for (const tipo of EVENT_TYPES) assert.ok(all.includes(`>${tipo}</a>`), `pastilla ${tipo}`);

    const filtered = await (await get('/eventos?tipo=' + encodeURIComponent('REDIL extendido'))).text();
    assert.ok(filtered.includes('Reunión B') && !filtered.includes('Reunión A') && !filtered.includes('Culto general'));
    assert.match(filtered, /href="\/eventos\?pasados=1&amp;tipo=REDIL\+extendido">Ver pasados/);
    const past = await (await get('/eventos?pasados=1&tipo=' + encodeURIComponent('REDIL ordinario'))).text();
    assert.ok(past.includes('REDIL viejo') && !past.includes('Reunión B'));
    assert.match(past, /href="\/eventos\?tipo=REDIL\+ordinario">Ver próximos/);
    const bogus = await (await get('/eventos?tipo=' + encodeURIComponent("x' OR '1'='1"))).text(); // un tipo inventado se ignora (todos)
    assert.ok(bogus.includes('Reunión A') && bogus.includes('Culto general'));

    const detail = await (await get(`/eventos/${ord}`)).text();
    assert.match(detail, /<h1>Reunión A <span class="badge b-ok">REDIL ordinario<\/span>/);
  });
});

test('buscador de listas: se activa con data-filter, solo en el panel (no en las páginas del teléfono), y sin tocar el servidor', () => {
  const admin = layout({ title: 'T', body: '<table data-filter="Buscar persona…"><tr><th>x</th></tr></table>', config });
  assert.match(admin, /document\.querySelectorAll\('table\[data-filter\]'\)/);
  assert.match(admin, /\.tfilter\{/); // el estilo
  assert.match(admin, /no-print/); // no sale al imprimir
  assert.ok(admin.indexOf('<script>') > admin.indexOf('</main>')); // va al final de la página
  assert.ok(!layout({ title: 'T', body: 'x', config, bare: true }).includes('table[data-filter]')); // páginas públicas: sin buscador
  // ignora tildes y mayúsculas y encuentra teléfonos sin importar la forma (lo hace el navegador; aquí se vigila que esté la lógica)
  assert.match(admin, /normalize\('NFD'\)/);
  assert.match(admin, /replace\(\/\\D\/g, ''\)/);
});

test('todas las listas de personas sin buscador propio lo tienen ahora', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const filtro = (html, texto) => html.includes(`<table data-filter="${texto}`);
    const p = (await db.query("INSERT INTO people (full_name, phone, opt_in) VALUES ('Ana Uno', '584140000001', TRUE) RETURNING id")).rows[0].id;
    const e = (await db.query("INSERT INTO events (title, starts_at) VALUES ('Evento', now() + interval '3 days') RETURNING id")).rows[0].id;
    await repo.addParticipant(db, e, p);
    assert.ok(filtro(await (await get(`/eventos/${e}`)).text(), 'Buscar entre los participantes'), 'participantes de un evento');
    const msgs = await (await get('/mensajes')).text();
    assert.ok(filtro(msgs, 'Buscar por persona o evento') && filtro(msgs, 'Buscar por número o mensaje'), 'mensajes enviados y recibidos');
    assert.ok(filtro(await (await get('/conversaciones')).text(), 'Buscar persona o mensaje'), 'conversaciones');
    assert.ok(filtro(await (await get('/consolidacion')).text(), 'Buscar persona…'), 'lista de Consolidación');
    const g = (await db.query("INSERT INTO care_groups (name, leader_name, token) VALUES ('Grupo Uno', 'Líder', 'tokenfiltro1234567890') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO care_group_people (group_id, name, milestones) VALUES ($1, 'Persona Ruta', '{NV}')", [g]);
    assert.ok(filtro(await (await get(`/grupos/${g}`)).text(), 'Buscar persona'), 'ruta de crecimiento del grupo');
    assert.ok(filtro(await (await get('/grupos')).text(), 'Buscar grupo o líder'), 'lista de grupos');
    // y las que ya tenían buscador propio siguen con él
    assert.match(await (await get('/personas')).text(), /<input type="search" name="q"/);
  });
});
