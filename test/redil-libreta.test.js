'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const lib = require('../src/redil-libreta');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const TOK = (n) => `lider${String(n).padStart(2, '0')}abcdefghijklmn`;
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

test('la libretica trae los 27 puntos en 7 temas, numerados sin saltos, tal como en el PDF', () => {
  const L = lib.getLibreta();
  assert.equal(L.sections.length, 7);
  assert.deepEqual(lib.pointNumbers(L), Array.from({ length: 27 }, (_, i) => i + 1));
  assert.deepEqual(L.sections.map((s) => s.points.length), [5, 3, 4, 4, 4, 4, 3]);
  assert.equal(lib.findPoint(L, 4).text[0], 'No casamos personas de otra congregación');
  assert.equal(lib.findPoint(L, 7).text.length, 2);
  assert.equal(lib.findPoint(L, 12).section, 'Liderazgo y estructura');
  assert.equal(lib.findPoint(L, 28), null);
});

test('parseQuestion: punto válido o general; vacío, punto inexistente o demasiado largo se rechazan', () => {
  const L = lib.getLibreta();
  assert.deepEqual(lib.parseQuestion(L, { point: '12', question: '  ¿Cómo   hago?  ' }), { value: { point: 12, question: '¿Cómo hago?' }, errors: [] });
  assert.equal(lib.parseQuestion(L, { point: '', question: 'General' }).value.point, null);
  assert.equal(lib.parseQuestion(L, { point: '99', question: 'x' }).errors.length, 1);
  assert.equal(lib.parseQuestion(L, { point: 'abc', question: 'x' }).errors.length, 1);
  assert.match(lib.parseQuestion(L, { point: '3', question: '   ' }).errors[0], /Escribe tu pregunta/);
  assert.match(lib.parseQuestion(L, { point: '3', question: 'a'.repeat(lib.MAX_LEN + 1) }).errors[0], /muy largo/);
});

async function setup(t) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const cfg = loadConfig({ DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'http://localhost', ADMIN_PASSWORD: 'clave-de-prueba-123', SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'true' });
  const app = createApp({ db: h.db, config: cfg, channels: { whatsapp: { available: false }, email: { available: false } } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const group = async (n, name, leader, phone) => (await h.db.query('INSERT INTO care_groups (name, leader_name, leader_phone, token) VALUES ($1,$2,$3,$4) RETURNING id', [name, leader, phone, TOK(n)])).rows[0].id;
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
  const post = (p, f, headers = {}) => fetch(base + p, { method: 'POST', headers: { ...FORM, ...headers }, body: new URLSearchParams(f), redirect: 'manual' });
  const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
  const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  return { db: h.db, group, get, post, admin, close: async () => { server.close(); await h.close(); } };
}

test('el líder lee la libretica, escribe preguntas y quedan con su nombre; cada grupo ve solo las suyas', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    await s.group(2, 'Grupo Roca', 'Beto Ríos', '584145550002');
    // el REDIL aparece como tarjeta en la pestaña REDIL y la libretica muestra los temas y los puntos
    assert.match(await (await s.get(`/g/${TOK(1)}/redil`)).text(), /Libretica del REDIL extraordinario/);
    const page = await (await s.get(`/g/${TOK(1)}/redil/libreta`)).text();
    for (const x of ['Cuidado y acompañamiento', 'Comunicación y contenidos', 'Protocolo para funerales.', 'No bautizamos personas de otra congregación', 'Ana Pérez', 'Sábado 7 de noviembre de 2026']) assert.ok(page.includes(x), x);
    assert.equal((page.match(/name="question"/g) || []).length, 28); // 27 puntos + la pregunta general

    // pregunta sobre un punto
    const ok = await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '14', question: '¿Cómo debe ser la visita del líder asesor?' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), `/g/${TOK(1)}/redil/libreta?ok=1#p14`);
    // y una general
    assert.equal((await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '', question: 'Otra duda' })).headers.get('location'), `/g/${TOK(1)}/redil/libreta?ok=1#general`);
    const row = (await s.db.query('SELECT * FROM redil_questions WHERE point = 14')).rows[0];
    assert.deepEqual([row.asker_name, row.group_name, row.asker_phone, row.libreta, row.status], ['Ana Pérez', 'Grupo Esperanza', '584145550001', lib.ACTIVE, 'abierta']);

    const again = await (await s.get(`/g/${TOK(1)}/redil/libreta?ok=1`)).text();
    assert.match(again, /Tu pregunta le llegó al equipo/);
    assert.ok(again.includes('¿Cómo debe ser la visita del líder asesor?') && again.includes('Otra duda'));
    const other = await (await s.get(`/g/${TOK(2)}/redil/libreta`)).text();
    assert.ok(!other.includes('visita del líder asesor') && !other.includes('Otra duda')); // no ve las de otro grupo
  } finally {
    await s.close();
  }
});

test('entradas malas no se guardan: punto que no existe, vacío, muy largo, robot, enlace inválido o desactivado; el HTML se escapa', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const gid = await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    const n = async () => (await s.db.query('SELECT count(*)::int AS n FROM redil_questions')).rows[0].n;
    assert.equal((await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '99', question: 'x' })).status, 400);
    assert.equal((await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '3', question: '  ' })).status, 400);
    assert.equal((await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '3', question: 'a'.repeat(lib.MAX_LEN + 1) })).status, 400);
    await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '3', question: 'spam', web: 'robot' });
    assert.equal((await s.post('/g/zzzzzzzzzzzzzzzzzzzz/redil/libreta', { point: '3', question: 'x' })).status, 404);
    assert.equal(await n(), 0);
    await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '3', question: '<script>alert(1)</script>' });
    const html = await (await s.get(`/g/${TOK(1)}/redil/libreta`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    await s.db.query('UPDATE care_groups SET link_active = FALSE WHERE id = $1', [gid]);
    assert.equal((await s.get(`/g/${TOK(1)}/redil/libreta`)).status, 404);
  } finally {
    await s.close();
  }
});

test('tope por grupo: después de 60 preguntas avisa y no guarda más', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const gid = await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    for (let i = 0; i < 60; i++) await s.db.query("INSERT INTO redil_questions (libreta, point, asker_name, group_name, group_id, question) VALUES ($1, 1, 'Ana', 'G', $2, 'p')", [lib.ACTIVE, gid]);
    const r = await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '1', question: 'una más' });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Ya enviaste muchas preguntas/);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM redil_questions')).rows[0].n, 60);
  } finally {
    await s.close();
  }
});

test('panel: solo con sesión; ve las preguntas por punto con nombre y grupo, responde y el líder ve la respuesta', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '19', question: '¿Quién inscribe en la ruta de crecimiento?' });
    await s.post(`/g/${TOK(1)}/redil/libreta`, { point: '', question: 'Pregunta general de Ana' });
    assert.equal((await s.get('/redil/preguntas')).status, 303); // sin sesión: al login
    assert.equal((await s.post('/redil/preguntas/1/respuesta', { answer: 'x' })).status, 401);

    const page = await (await s.get('/redil/preguntas', s.admin)).text();
    for (const x of ['Punto 19 · Enseñanza y capacitación', 'Ana Pérez', 'Grupo Esperanza', '0414-555.00.01', '¿Quién inscribe en la ruta de crecimiento?', 'Preguntas generales', 'Abiertas (2)']) assert.ok(page.includes(x), x);

    const id = (await s.db.query('SELECT id FROM redil_questions WHERE point = 19')).rows[0].id;
    const ans = await s.post(`/redil/preguntas/${id}/respuesta`, { answer: 'La inscribe el líder en el plazo fijado.' }, s.admin);
    assert.equal(ans.status, 303);
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'atendida');
    assert.match(await (await s.get(`/g/${TOK(1)}/redil/libreta`)).text(), /Respuesta:<\/strong> La inscribe el líder en el plazo fijado\./);
    const open = await (await s.get('/redil/preguntas', s.admin)).text();
    assert.ok(open.includes('Abiertas (1)') && !open.includes('¿Quién inscribe en la ruta de crecimiento?'));
    const all = await (await s.get('/redil/preguntas?ver=todas', s.admin)).text();
    assert.ok(all.includes('¿Quién inscribe en la ruta de crecimiento?') && all.includes('Atendida'));
    // borrar la respuesta la reabre; reabrir a mano también
    await s.post(`/redil/preguntas/${id}/respuesta`, { answer: '' }, s.admin);
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'abierta');
    await s.post(`/redil/preguntas/${id}/estado`, { status: 'atendida' }, s.admin);
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'atendida');
    assert.equal((await s.post(`/redil/preguntas/${id}/estado`, { status: 'otra' }, s.admin)).status, 303); // estado inválido: no cambia
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'atendida');
    // la pregunta sobrevive al borrado del grupo (sin claves foráneas a propósito)
    await s.db.query('DELETE FROM care_groups');
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM redil_questions')).rows[0].n, 2);
  } finally {
    await s.close();
  }
});
