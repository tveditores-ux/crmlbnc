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
const JSONH = { 'Content-Type': 'application/json' };

test('la libretica trae los 28 puntos en 8 temas, numerados sin saltos, en la redacción en preguntas', () => {
  const L = lib.getLibreta();
  assert.equal(L.sections.length, 8);
  assert.deepEqual(lib.pointNumbers(L), Array.from({ length: 28 }, (_, i) => i + 1));
  assert.deepEqual(L.sections.map((s) => s.points.length), [5, 3, 4, 4, 4, 4, 3, 1]);
  assert.match(lib.findPoint(L, 4).text[0], /^¿Cuál es el criterio pastoral para no celebrar matrimonios/);
  assert.equal(lib.findPoint(L, 7).text.length, 1);
  assert.equal(lib.findPoint(L, 12).section, 'Liderazgo y estructura');
  assert.equal(lib.findPoint(L, 29), null);
  assert.equal(lib.findPoint(L, 28).section, 'Asistencia al REDIL');
  assert.equal(lib.sheetKeys(L).length, 29);
});

test('parseSheet: solo pasan las cajas de la libretica; se limpian espacios; demasiado largo se rechaza', () => {
  const L = lib.getLibreta();
  const ok = lib.parseSheet(L, { p12: '  ¿Cómo   hago?  ', general: 'Otra', p99: 'no existe', hack: 'x', p3: '   ' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.length, 29);
  assert.deepEqual(ok.value.filter((v) => v.question).map((v) => [v.point, v.question]), [[12, '¿Cómo hago?'], [null, 'Otra']]);
  assert.match(lib.parseSheet(L, { p1: 'a'.repeat(lib.MAX_LEN + 1) }).errors[0], /muy larga/);
  assert.equal(lib.parseSheet(L, null).value.filter((v) => v.question).length, 0);
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
  const form = (p, f, headers = {}) => fetch(base + p, { method: 'POST', headers: { ...FORM, ...headers }, body: new URLSearchParams(f), redirect: 'manual' });
  const send = (n, answers) => fetch(`${base}/g/${TOK(n)}/redil/libreta/enviar`, { method: 'POST', headers: JSONH, body: JSON.stringify({ answers }) });
  const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
  const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const rows = async () => (await h.db.query('SELECT * FROM redil_questions ORDER BY group_id, COALESCE(point, 0)')).rows;
  return { db: h.db, group, get, form, send, admin, rows, close: async () => { server.close(); await h.close(); } };
}

test('la hoja del líder es un cuaderno manuscrito con una caja por punto, y se abre desde la pestaña REDIL', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    assert.match(await (await s.get(`/g/${TOK(1)}/redil`)).text(), /Libretica del REDIL extraordinario/);
    const r = await s.get(`/g/${TOK(1)}/redil/libreta`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const page = await r.text();
    for (const x of ['Amatic', 'Cuidado y acompañamiento', 'Comunicación y contenidos', 'protocolo de acompañamiento pastoral ante un funeral', 'no bautizar a personas de otra congregación', 'Ana Pérez · Grupo Esperanza', 'Enviar a la iglesia', 'Sábado 7 de noviembre de 2026']) assert.ok(page.includes(x), x);
    assert.equal((page.match(/<textarea data-k=/g) || []).length, 29); // 28 puntos + la general
    assert.ok(page.includes('data-k="p14"') && page.includes('data-k="general"'));
  } finally {
    await s.close();
  }
});

test('enviar: queda con el nombre del líder y su grupo; reenviar corrige sin duplicar; vacío borra; cada grupo ve lo suyo', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    await s.group(2, 'Grupo Roca', 'Beto Ríos', '584145550002');
    assert.equal((await s.send(1, { p14: '¿Cómo debe ser la visita del líder asesor?', general: 'Otra duda', p3: '' })).status, 204);
    let rows = await s.rows();
    assert.equal(rows.length, 2);
    const q14 = rows.find((x) => x.point === 14);
    assert.deepEqual([q14.asker_name, q14.group_name, q14.asker_phone, q14.libreta, q14.status], ['Ana Pérez', 'Grupo Esperanza', '584145550001', lib.ACTIVE, 'abierta']);
    assert.ok(rows.find((x) => x.point === null && x.question === 'Otra duda'));

    // reenviar con el mismo punto corrige; con otro punto suma; texto vacío quita
    await s.send(1, { p14: 'Pregunta de prueba uno del grupo', p15: 'Comentario de prueba dos del grupo', general: '' });
    rows = await s.rows();
    assert.deepEqual(rows.map((x) => [x.point, x.question]), [[14, 'Pregunta de prueba uno del grupo'], [15, 'Comentario de prueba dos del grupo']]);

    // al volver a abrir, la hoja muestra lo que ya envió; el otro grupo no lo ve
    const again = await (await s.get(`/g/${TOK(1)}/redil/libreta`)).text();
    assert.ok(again.includes('Pregunta de prueba uno del grupo') && again.includes('Comentario de prueba dos del grupo'));
    const other = await (await s.get(`/g/${TOK(2)}/redil/libreta`)).text();
    assert.ok(!other.includes('Pregunta de prueba uno del grupo') && !other.includes('Comentario de prueba dos del grupo'));
    await s.send(2, { p14: 'Pregunta de Beto' });
    assert.equal((await s.rows()).length, 3);
    assert.equal((await s.rows()).filter((x) => x.group_name === 'Grupo Esperanza').length, 2); // no mezcla grupos
  } finally {
    await s.close();
  }
});

test('entradas malas no se guardan: claves ajenas, muy largo, enlace inválido o desactivado; el HTML se escapa', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const gid = await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    const long = await s.send(1, { p1: 'a'.repeat(lib.MAX_LEN + 1) });
    assert.equal(long.status, 400);
    assert.match((await long.json()).errors[0], /muy larga/);
    await s.send(1, { p99: 'no existe', hack: 'x', constructor: 'y' });
    assert.equal((await s.rows()).length, 0);
    assert.equal((await s.get('/g/zzzzzzzzzzzzzzzzzzzz/redil/libreta')).status, 404);
    await s.send(1, { p3: '<script>alert(1)</script>' });
    const html = await (await s.get(`/g/${TOK(1)}/redil/libreta`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    await s.db.query('UPDATE care_groups SET link_active = FALSE WHERE id = $1', [gid]);
    assert.equal((await s.get(`/g/${TOK(1)}/redil/libreta`)).status, 404);
    assert.equal((await s.send(1, { p3: 'otra' })).status, 404);
    assert.equal((await s.rows()).length, 1);
  } finally {
    await s.close();
  }
});

test('panel: libretica en estilo cuaderno, preguntas por punto y por persona, responder; el líder ve la respuesta y ella no se pierde', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    await s.group(2, 'Grupo Roca', 'Beto Ríos', '584145550002');
    await s.send(1, { p19: '¿Quién inscribe en la ruta de crecimiento?', general: 'Pregunta general de Ana' });
    await s.send(2, { p19: 'Lo mismo, Beto' });
    assert.equal((await s.get('/redil/libreta')).status, 303); // sin sesión
    assert.equal((await s.get('/redil/preguntas')).status, 303);
    assert.equal((await s.form('/redil/preguntas/1/respuesta', { answer: 'x' })).status, 401);

    const vista = await (await s.get('/redil/libreta', s.admin)).text();
    for (const x of ['Libretica del REDIL extraordinario', 'no celebrar matrimonios de personas de otra congregación', 'Cómo reforzamos en la práctica', '2 pregunta(s) recibida(s)', 'class="re"']) assert.ok(vista.includes(x), x);
    assert.ok(!vista.includes('<textarea data-k=')); // en el panel es solo lectura

    const page = await (await s.get('/redil/preguntas', s.admin)).text();
    for (const x of ['Punto 19 · Enseñanza y capacitación', 'Ana Pérez', 'Beto Ríos', 'Grupo Esperanza', '0414-555.00.01', '¿Quién inscribe en la ruta de crecimiento?', 'Preguntas generales', 'Abiertas (3)']) assert.ok(page.includes(x), x);
    const persona = await (await s.get('/redil/preguntas?ver=persona', s.admin)).text();
    for (const x of ['Ana Pérez', 'Punto 19', 'Pregunta general', 'Grupo Roca']) assert.ok(persona.includes(x), x);

    const id = (await s.db.query("SELECT id FROM redil_questions WHERE group_name = 'Grupo Esperanza' AND point = 19")).rows[0].id;
    assert.equal((await s.form(`/redil/preguntas/${id}/respuesta`, { answer: 'La inscribe el líder en el plazo fijado.' }, s.admin)).status, 303);
    assert.match(await (await s.get(`/g/${TOK(1)}/redil/libreta`)).text(), /Respuesta:<\/strong> La inscribe el líder en el plazo fijado\./);
    const open = await (await s.get('/redil/preguntas', s.admin)).text();
    assert.ok(open.includes('Abiertas (2)') && !open.includes('¿Quién inscribe en la ruta de crecimiento?'));
    assert.ok((await (await s.get('/redil/preguntas?ver=todas', s.admin)).text()).includes('Atendida'));

    // vaciar la caja NO borra una pregunta ya contestada; cambiar su texto la reabre
    await s.send(1, { p19: '', general: 'Pregunta general de Ana' });
    assert.equal((await s.rows()).filter((x) => x.point === 19 && x.group_name === 'Grupo Esperanza').length, 1);
    await s.send(1, { p19: '¿Y si cierra el periodo?', general: 'Pregunta general de Ana' });
    const q = (await s.rows()).find((x) => x.point === 19 && x.group_name === 'Grupo Esperanza');
    assert.deepEqual([q.question, q.status, q.answer], ['¿Y si cierra el periodo?', 'abierta', 'La inscribe el líder en el plazo fijado.']);

    // borrar la respuesta la reabre; reabrir a mano también; estado inválido no cambia nada
    await s.form(`/redil/preguntas/${id}/respuesta`, { answer: '' }, s.admin);
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'abierta');
    await s.form(`/redil/preguntas/${id}/estado`, { status: 'atendida' }, s.admin);
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'atendida');
    await s.form(`/redil/preguntas/${id}/estado`, { status: 'otra' }, s.admin);
    assert.equal((await s.db.query('SELECT status FROM redil_questions WHERE id = $1', [id])).rows[0].status, 'atendida');
    // la pregunta sobrevive al borrado del grupo (sin claves foráneas a propósito)
    const n = (await s.rows()).length;
    await s.db.query('DELETE FROM care_groups');
    assert.equal((await s.rows()).length, n);
  } finally {
    await s.close();
  }
});
