'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const lg = require('../src/leader-guide');
const agent = require('../src/agent');
const { careRemoteRouter } = require('../src/routes/care-remote');
const { leaderGuideRouter } = require('../src/routes/leader-guide');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = {
  timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true,
  agent: { enabled: true, apiKey: 'sk-test', model: 'claude-test', maxRepliesPerDay: 5 },
};
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const modelSays = (obj) => async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) });

test('validación de una entrada: categoría, pregunta y respuesta obligatorias; fecha de revisión válida y futura', () => {
  const base = { category: 'Grupos de cuidado', question: ' ¿Cómo  hago esto? ', answer: 'Así.', status: 'confirmada', active: '1' };
  const ok = lg.parseEntry(base, TODAY);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.question, '¿Cómo hago esto?');
  assert.equal(ok.value.status, 'confirmada');
  assert.equal(ok.value.active, true);
  assert.equal(lg.parseEntry({ ...base, status: 'cualquiera' }, TODAY).value.status, 'por_confirmar'); // lo desconocido nunca cuenta como confirmado
  assert.equal(lg.parseEntry({ ...base, active: '' }, TODAY).value.active, false);
  assert.ok(lg.parseEntry({ ...base, category: 'Inventada' }, TODAY).errors.includes('Elige una categoría.'));
  assert.ok(lg.parseEntry({ ...base, question: '' }, TODAY).errors.includes('Escribe la pregunta.'));
  assert.ok(lg.parseEntry({ ...base, answer: '  ' }, TODAY).errors.includes('Escribe la respuesta.'));
  assert.ok(lg.parseEntry({ ...base, review_by: 'mañana' }, TODAY).errors.some((e) => /no es válida/.test(e)));
  assert.ok(lg.parseEntry({ ...base, review_by: '2020-01-01' }, TODAY).errors.some((e) => /ya pasó/.test(e)));
  assert.deepEqual(lg.parseEntry({ ...base, review_by: '2999-01-01' }, TODAY).errors, []);
  assert.equal(lg.parseEntry({ ...base, answer: 'x'.repeat(5000) }, TODAY).value.answer.length, lg.MAX.answer);
});

test('agrupar por categoría respeta el orden de la guía y deja las desconocidas al final; el texto del asistente se acota', () => {
  const e = (category, q) => ({ category, question: q, answer: 'R', contact: '' });
  const groups = lg.groupByCategory([e('Ruta de crecimiento', 'c'), e('Otra cosa', 'z'), e('Mi enlace y el sistema', 'a'), e('Ruta de crecimiento', 'd')]);
  assert.deepEqual(groups.map((g) => g.category), ['Mi enlace y el sistema', 'Ruta de crecimiento', 'Otra cosa']);
  assert.equal(groups[1].entries.length, 2);
  assert.match(lg.contextText([{ question: '¿Algo?', answer: 'Sí.', contact: 'Pastor' }]), /- ¿Algo\? Sí\. \(Escribir a: Pastor\)/);
  assert.equal(lg.contextText([{ question: 'q', answer: 'a'.repeat(9000), contact: '' }], 500).length, 500);
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

test('el borrador inicial: 27 entradas, solo lo del propio sistema queda confirmado, se siembra una sola vez y no trae datos de personas', async (t) => {
  await withDb(t, async (db) => {
    const rows = (await db.query('SELECT * FROM leader_guide ORDER BY sort')).rows;
    assert.equal(rows.length, 27); // 25 del borrador + 2 de REDIL
    const confirmed = rows.filter((r) => r.status === 'confirmada');
    assert.equal(confirmed.length, 4);
    assert.ok(confirmed.every((r) => r.category === 'Mi enlace y el sistema' && r.source === 'Sistema de la iglesia'));
    assert.ok(rows.filter((r) => r.status === 'por_confirmar').every((r) => r.source));
    for (const c of new Set(rows.map((r) => r.category))) assert.ok(lg.CATEGORIES.includes(c), c);
    // nada sensible: ni teléfonos, ni correos, ni peticiones de oración o de salud
    const all = rows.map((r) => `${r.question} ${r.answer} ${r.contact}`).join(' ');
    assert.ok(!/\d{7,}/.test(all.replace(/[\s.-]/g, '')), 'no debe traer teléfonos');
    assert.ok(!/@/.test(all));
    assert.ok(!/cáncer|oración por|petición/i.test(all));
    // volver a correr la siembra no duplica ni pisa
    await db.query("UPDATE leader_guide SET answer = 'editada a mano' WHERE sort = 0");
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'migrations', '024_guia_lider_borrador.sql'), 'utf8'));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM leader_guide')).rows[0].n, 27);
    assert.equal((await db.query('SELECT answer FROM leader_guide WHERE sort = 0')).rows[0].answer, 'editada a mano');
  });
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(careRemoteRouter({ db: h.db, config }));
  app.use(leaderGuideRouter({ db: h.db, config }));
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

const mkGroup = async (db, token = 'tokenguia1234567890xx', phone = '584140000001') =>
  (await db.query("INSERT INTO care_groups (name, leader_name, leader_phone, token) VALUES ('Grupo Guía', 'Líder Uno', $2, $1) RETURNING *", [token, phone])).rows[0];
const addEntry = (db, status, q, a, extra = {}) =>
  db.query('INSERT INTO leader_guide (category, question, answer, contact, status, active, sort) VALUES ($1,$2,$3,$4,$5,$6,999)', [extra.category || 'Grupos de cuidado', q, a, extra.contact || '', status, extra.active ?? true]);

test('pantalla de la guía: por confirmar avisa, se edita, se confirma, se oculta y se borra; datos malos no se guardan', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await db.query('DELETE FROM leader_guide'); // partimos de cero para contar
    const html0 = await (await get('/guia')).text();
    assert.match(html0, /No hay respuestas con ese filtro/);

    const add = await post('/guia', { category: 'Espacios y equipos', question: '¿Puedo usar el salón?', answer: 'Sí, con permiso <b>escrito</b>.', contact: 'Pastor asistente', status: 'por_confirmar' });
    assert.equal(add.status, 303);
    const e = (await db.query('SELECT * FROM leader_guide')).rows[0];
    assert.deepEqual([e.status, e.active, e.contact], ['por_confirmar', true, 'Pastor asistente']);

    const page = await (await get('/guia')).text();
    assert.match(page, /1 respuesta por confirmar/);
    assert.match(page, /Guardar y confirmar/);
    assert.ok(!page.includes('<b>escrito</b>'));
    assert.match(page, /&lt;b&gt;escrito/);

    // datos malos: no se guardan
    assert.match(loc(await post('/guia', { category: 'Inventada', question: 'x', answer: 'y' })), /Elige una categoría/);
    assert.match(loc(await post(`/guia/${e.id}`, { category: 'Espacios y equipos', question: '', answer: 'y' })), /Escribe la pregunta/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM leader_guide')).rows[0].n, 1);

    // confirmar (con edición)
    const ok = await post(`/guia/${e.id}/confirmar`, { category: 'Espacios y equipos', question: '¿Puedo usar el salón?', answer: 'Sí, con permiso escrito.', active: '1' });
    assert.match(loc(ok), /ya la ven los líderes/);
    const c = (await db.query('SELECT * FROM leader_guide')).rows[0];
    assert.deepEqual([c.status, c.answer], ['confirmada', 'Sí, con permiso escrito.']);
    assert.ok(!(await (await get('/guia')).text()).includes('por confirmar. Revisa'));
    assert.equal((await (await get('/guia?estado=por_confirmar')).text()).includes('¿Puedo usar el salón?'), false); // filtro

    // ocultar (sin marcar "Visible") y borrar
    await post(`/guia/${e.id}`, { category: 'Espacios y equipos', question: '¿Puedo usar el salón?', answer: 'Sí.', status: 'confirmada' });
    assert.equal((await db.query('SELECT active FROM leader_guide')).rows[0].active, false);
    await post(`/guia/${e.id}/eliminar`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM leader_guide')).rows[0].n, 0);
  });
});

test('pestaña Guía del enlace del líder: solo lo confirmado y visible, agrupado, con contacto; enlaces malos 404', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db);
    await db.query('DELETE FROM leader_guide');
    await addEntry(db, 'confirmada', '¿Cómo pido equipos?', 'Por escrito y con tiempo.', { category: 'Espacios y equipos', contact: 'Pastor asistente' });
    await addEntry(db, 'por_confirmar', 'Borrador sin aprobar', 'No debe verse.');
    await addEntry(db, 'confirmada', 'Respuesta oculta', 'No debe verse.', { active: false });
    await addEntry(db, 'confirmada', '<img src=x onerror=alert(1)>', 'Texto <b>peligroso</b>');

    const r = await get(`/g/${g.token}/guia`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /¿Cómo pido equipos\?/);
    assert.match(html, /Por escrito y con tiempo\./);
    assert.match(html, /A quién escribir: <strong>Pastor asistente<\/strong>/);
    assert.match(html, /<h2>Espacios y equipos<\/h2>/);
    assert.ok(!html.includes('Borrador sin aprobar') && !html.includes('Respuesta oculta'));
    assert.ok(!html.includes('<img src=x') && !html.includes('<b>peligroso</b>'));
    assert.match(html, /id="gfind"/); // buscador
    assert.match(html, /href="\/g\/[^"]+\/guia" class="on"/); // la pestaña Guía está marcada

    // las demás pestañas la enlazan
    assert.match(await (await get(`/g/${g.token}/datos`)).text(), /\/guia" class="">Guía<\/a>/);
    assert.equal((await get('/g/zzzzzzzzzzzzzzzzzzzz/guia')).status, 404);
    await db.query('UPDATE care_groups SET link_active = FALSE WHERE id = $1', [g.id]);
    assert.equal((await get(`/g/${g.token}/guia`)).status, 404);

    await db.query('DELETE FROM leader_guide');
    await db.query('UPDATE care_groups SET link_active = TRUE WHERE id = $1', [g.id]);
    assert.match(await (await get(`/g/${g.token}/guia`)).text(), /todavía no tiene respuestas confirmadas/);
  });
});

test('el asistente: a un líder le da la guía confirmada; a quien no lidera nada no; nunca lo "por confirmar" ni lo oculto', async (t) => {
  await withDb(t, async (db) => {
    await db.query('DELETE FROM leader_guide');
    await addEntry(db, 'confirmada', '¿Quién maneja el sonido?', 'El personal de medios.', { contact: 'Pastor asistente' });
    await addEntry(db, 'por_confirmar', 'Borrador', 'Secreto de borrador');
    await addEntry(db, 'confirmada', 'Oculta', 'Secreto oculto', { active: false });
    const lider = (await db.query("INSERT INTO people (full_name, phone, active) VALUES ('Lucía Torres', '584140000001', TRUE) RETURNING *")).rows[0];
    const otra = (await db.query("INSERT INTO people (full_name, phone, active) VALUES ('María Pérez', '584140000002', TRUE) RETURNING *")).rows[0];
    await mkGroup(db);

    const ctxLider = await agent.buildContext(db, config, lider, new Date(), '584140000001');
    assert.match(ctxLider, /GUÍA DEL LÍDER/);
    assert.match(ctxLider, /¿Quién maneja el sonido\? El personal de medios\. \(Escribir a: Pastor asistente\)/);
    assert.ok(!ctxLider.includes('Secreto de borrador') && !ctxLider.includes('Secreto oculto'));
    const ctxOtra = await agent.buildContext(db, config, otra, new Date(), '584140000002');
    assert.ok(!ctxOtra.includes('GUÍA DEL LÍDER') && !ctxOtra.includes('El personal de medios'));
    assert.match(agent.systemPrompt(config), /GUÍA DEL LÍDER/);
  });
});

test('el asistente responde con la guía a un líder, y una respuesta con un teléfono que no está en la guía se bloquea', async (t) => {
  await withDb(t, async (db) => {
    await db.query('DELETE FROM leader_guide');
    await addEntry(db, 'confirmada', '¿Quién lleva la Santa Cena a una casa?', 'Los pastores, no los líderes.');
    await db.query("INSERT INTO people (full_name, phone, active) VALUES ('Lucía Torres', '584140000001', TRUE)");
    await mkGroup(db);
    const sent = [];
    const channels = { whatsapp: { available: true, sendText: async (to, text) => sent.push(text) } };
    const ok = await agent.handleInbound({ db, config, channels }, { from: '584140000001', body: '¿puedo llevar la santa cena a una hermana?', type: 'text' }, { fetchImpl: modelSays({ respuesta: 'Deben ir los pastores, no los líderes, y solo si de verdad hace falta.', escalar: false, motivo: '' }) });
    assert.equal(ok.handledAs, 'agente');
    assert.match(sent[0], /pastores/);
    const bad = await agent.handleInbound({ db, config, channels }, { from: '584140000001', body: 'dame el teléfono de la pastora', type: 'text' }, { fetchImpl: modelSays({ respuesta: 'Escríbele al 0414-777.66.55', escalar: false, motivo: '' }) });
    assert.equal(bad.handledAs, 'agente_escalado');
    assert.equal(sent[1], agent.FALLBACK_REPLY);
  });
});

test('las tres categorías de REDIL: están en la guía, se pueden usar en el panel y se ven en el enlace del líder en su lugar', async (t) => {
  assert.deepEqual(lg.CATEGORIES.slice(0, 4), ['Mi enlace y el sistema', 'REDIL ordinario', 'REDIL extraordinario', 'REDIL extendido']);
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db);
    const html = await (await get('/guia')).text();
    for (const c of ['REDIL ordinario', 'REDIL extraordinario', 'REDIL extendido']) assert.ok(html.includes(`<option value="${c}"`), c);

    // el arranque trae una respuesta en ordinario y otra en extendido, por confirmar; el extraordinario lo escribe la iglesia
    const seeded = (await db.query("SELECT category, status, source FROM leader_guide WHERE category LIKE 'REDIL%' ORDER BY category")).rows;
    assert.deepEqual(seeded.map((r) => [r.category, r.status, r.source]), [['REDIL extendido', 'por_confirmar', 'Glosario de la iglesia'], ['REDIL ordinario', 'por_confirmar', 'Glosario de la iglesia']]);

    const add = await post('/guia', { category: 'REDIL extraordinario', question: '¿Cuándo se convoca un REDIL extraordinario?', answer: 'Texto de prueba.', status: 'confirmada' });
    assert.equal(add.status, 303);
    await db.query("UPDATE leader_guide SET status = 'confirmada' WHERE category IN ('REDIL ordinario', 'REDIL extendido')");
    await db.query("UPDATE leader_guide SET status = 'confirmada' WHERE id = (SELECT min(id) FROM leader_guide WHERE category = 'Grupos de cuidado')"); // la pestaña solo muestra categorías con algo confirmado
    const tab = await (await get(`/g/${g.token}/guia`)).text();
    const order = ['REDIL ordinario', 'REDIL extraordinario', 'REDIL extendido', 'Grupos de cuidado'].map((c) => tab.indexOf(`<h2>${c}</h2>`));
    assert.ok(order.every((i) => i > 0), 'las cuatro categorías se ven');
    assert.deepEqual(order, [...order].sort((a, b) => a - b)); // y en el orden de la guía
  });
});
