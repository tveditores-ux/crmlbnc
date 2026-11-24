'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { libretaLideresRouter, libretaLideresRemotaRouter } = require('../src/routes/libreta-lideres');
const ll = require('../src/libreta-lideres');
const { openTestDb } = require('./helpers/db');

const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: false };

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(libretaLideresRemotaRouter({ db: h.db, config }));
  app.use(libretaLideresRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const save = (k, v) => fetch(base + '/libreta-lideres/guardar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k, v }) });
  try {
    await fn({ db: h.db, get, save, base });
  } finally {
    server.close();
    await h.close();
  }
}

test('contenido fijo: las 7 propuestas, sin equipo pastoral, con sus tres casillas por persona', () => {
  assert.equal(ll.PERSONAS.length, 7);
  assert.deepEqual(
    ll.PERSONAS.map((p) => p.name),
    ['Gabriel Alvarado', 'Gabriel Sánchez', 'Laura Vargas', 'Linda Hernández', 'Silmar Alvarado', 'Yamilet Abarca de Escalona', 'Yanethsy Pauvil']
  );
  assert.equal(ll.KEYS.size, 21);
  for (const k of ['l1a', 'l1b', 'l1c', 'l7a', 'l7b', 'l7c']) assert.ok(ll.KEYS.has(k), k);
  assert.ok(!ll.KEYS.has('l8a'));
  assert.ok(ll.PERSONAS.every((p) => p.punto && p.solucion));
});

test('guarda una casilla, la muestra escapada y un texto vacío la borra', async (t) => {
  await withApp(t, async ({ db, get, save }) => {
    assert.equal((await save('l3a', 'Acuerdo <b>firme</b>')).status, 204);
    const html = await (await get('/libreta-lideres')).text();
    assert.ok(html.includes('Acuerdo &lt;b&gt;firme&lt;/b&gt;'));
    assert.ok(!html.includes('<b>firme</b>'));
    assert.ok(html.includes('Laura Vargas'));
    assert.ok(html.includes('Punto que expuso'));
    assert.ok(html.includes('Solución clave'));
    assert.equal((await save('l3a', '  ')).status, 204);
    const { rows } = await db.query('SELECT * FROM libreta_lideres');
    assert.equal(rows.length, 0);
  });
});

test('rechaza claves que no existen y recorta textos largos', async (t) => {
  await withApp(t, async ({ db, save }) => {
    assert.equal((await save('inventada', 'x')).status, 400);
    assert.equal((await save('e1', 'x')).status, 400); // clave de la libreta de reunión: aquí no pasa
    assert.equal((await save('l1a', 'a'.repeat(9000))).status, 204);
    const { rows } = await db.query("SELECT length(value) AS n FROM libreta_lideres WHERE key = 'l1a'");
    assert.equal(rows[0].n, 5000);
    assert.equal((await db.query('SELECT 1 FROM libreta_lideres')).rows.length, 1);
  });
});

test('borrar todo vacía la hoja y no toca la hoja de reunión de equipo', async (t) => {
  await withApp(t, async ({ db, save, base }) => {
    await save('l1a', 'uno');
    await save('l7c', 'revisado');
    await db.query("INSERT INTO reunion_equipo (key, value) VALUES ('e1', 'de la otra libreta')");
    const r = await fetch(base + '/libreta-lideres/borrar', { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal((await db.query('SELECT 1 FROM libreta_lideres')).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM reunion_equipo')).rows.length, 1);
  });
});

const tokenOf = (html) => /\/libreta-lideres\/([A-Za-z0-9_-]{16,64})/.exec(html)[1];

test('enlace remoto: abre la libreta con el token, no muestra lo guardado en el panel y no guarda nada', async (t) => {
  await withApp(t, async ({ db, get, save }) => {
    await save('l1a', 'texto privado del panel');
    const token = tokenOf(await (await get('/libreta-lideres')).text());
    const res = await get(`/libreta-lideres/${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('noindex'));
    assert.ok(html.includes('Gabriel Alvarado'));
    assert.ok(html.includes('Yanethsy Pauvil'));
    assert.ok(!html.includes('texto privado del panel'));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await db.query('SELECT 1 FROM libreta_lideres')).rows.length, 1);
  });
});

test('enlace remoto: el segmento «respuestas» del panel no se confunde con un token', async (t) => {
  await withApp(t, async ({ get }) => {
    const res = await get('/libreta-lideres/respuestas');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Respuestas de los líderes'));
  });
});

test('enlace remoto: token inválido, apagado y regenerado dejan de abrir', async (t) => {
  await withApp(t, async ({ get, base }) => {
    const token = tokenOf(await (await get('/libreta-lideres')).text());
    assert.equal((await get('/libreta-lideres/no-es-el-token-1234567890')).status, 404);
    const post = (a) => fetch(`${base}/libreta-lideres/enlace/${a}`, { method: 'POST', redirect: 'manual' });
    await post('apagar');
    assert.equal((await get(`/libreta-lideres/${token}`)).status, 404);
    await post('encender');
    assert.equal((await get(`/libreta-lideres/${token}`)).status, 200);
    await post('regenerar');
    assert.equal((await get(`/libreta-lideres/${token}`)).status, 404);
    const nuevo = tokenOf(await (await get('/libreta-lideres')).text());
    assert.notEqual(nuevo, token);
    assert.equal((await get(`/libreta-lideres/${nuevo}`)).status, 200);
    assert.equal((await post('otra')).status, 404);
  });
});

const DEV = 'dispositivo-prueba-0001';
const sendTo = (base, token, body) => fetch(`${base}/libreta-lideres/${token}/enviar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('respuestas: se guardan por aparato, reenviar corrige y el panel las muestra escapadas', async (t) => {
  await withApp(t, async ({ db, get, base }) => {
    const token = tokenOf(await (await get('/libreta-lideres')).text());
    const r1 = await sendTo(base, token, { device: DEV, name: 'Laura', answers: { l3a: 'Acuerdo <i>claro</i>', l3b: 'Empezar el lunes', inventada: 'x' } });
    assert.equal(r1.status, 204);
    const r2 = await sendTo(base, token, { device: DEV, name: 'Laura V.', answers: { l3a: 'Versión corregida' } });
    assert.equal(r2.status, 204);
    const { rows } = await db.query('SELECT name, answers FROM libreta_lideres_respuestas');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Laura V.');
    assert.deepEqual(rows[0].answers, { l3a: 'Versión corregida' });
    await sendTo(base, token, { device: 'otro-aparato-00000002', name: 'Silmar', answers: { l5a: 'Tarde <script>x</script>' } });
    const tema = await (await get('/libreta-lideres/respuestas')).text();
    assert.ok(tema.includes('Versión corregida') && tema.includes('Silmar'));
    assert.ok(!tema.includes('<script>x'));
    const per = await (await get('/libreta-lideres/respuestas?ver=persona')).text();
    assert.ok(per.includes('Laura V.'));
    const panel = await (await get('/libreta-lideres')).text();
    assert.ok(panel.includes('Respuestas de los líderes (2)'));
  });
});

test('respuestas: rechaza sin nombre, vacías, aparato inválido, token malo o enlace apagado; no toca people ni reunion_respuestas', async (t) => {
  await withApp(t, async ({ db, get, base }) => {
    const token = tokenOf(await (await get('/libreta-lideres')).text());
    assert.equal((await sendTo(base, token, { device: DEV, name: '', answers: { l1a: 'x' } })).status, 400);
    assert.equal((await sendTo(base, token, { device: DEV, name: 'Ana', answers: {} })).status, 400);
    assert.equal((await sendTo(base, token, { device: 'corto', name: 'Ana', answers: { l1a: 'x' } })).status, 400);
    assert.equal((await sendTo(base, 'token-que-no-existe-123456', { device: DEV, name: 'Ana', answers: { l1a: 'x' } })).status, 404);
    await fetch(`${base}/libreta-lideres/enlace/apagar`, { method: 'POST', redirect: 'manual' });
    assert.equal((await sendTo(base, token, { device: DEV, name: 'Ana', answers: { l1a: 'x' } })).status, 404);
    assert.equal((await db.query('SELECT 1 FROM libreta_lideres_respuestas')).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM reunion_respuestas')).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM people')).rows.length, 0);
  });
});

test('respuestas: borrar una respuesta desde el panel', async (t) => {
  await withApp(t, async ({ db, base, get }) => {
    const token = tokenOf(await (await get('/libreta-lideres')).text());
    await sendTo(base, token, { device: DEV, name: 'Ana', answers: { l1a: 'hola' } });
    const { rows } = await db.query('SELECT id FROM libreta_lideres_respuestas');
    const r = await fetch(`${base}/libreta-lideres/respuestas/${rows[0].id}/borrar`, { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal((await db.query('SELECT 1 FROM libreta_lideres_respuestas')).rows.length, 0);
  });
});

test('respuestas: al enviar, también entran en las casillas de la libreta (la misma hoja, como el REDIL)', async (t) => {
  await withApp(t, async ({ db, get, base }) => {
    const token = tokenOf(await (await get('/libreta-lideres')).text());
    await sendTo(base, token, { device: DEV, name: 'Laura', answers: { l3a: 'Acuerdo de Laura', l3b: 'El lunes' } });
    await sendTo(base, token, { device: 'otro-aparato-00000002', name: 'Silmar', answers: { l5a: 'Acuerdo de Silmar' } });
    const d = await ll.loadAll(db);
    assert.equal(d.l3a, 'Acuerdo de Laura');
    assert.equal(d.l3b, 'El lunes');
    assert.equal(d.l5a, 'Acuerdo de Silmar');
    assert.equal(d.l1a, undefined); // lo no enviado no aparece
    const panel = await (await get('/libreta-lideres')).text();
    assert.ok(panel.includes('Acuerdo de Laura') && panel.includes('Acuerdo de Silmar'));
    // Una casilla vacía en un reenvío no borra lo que ya entró a la hoja.
    await sendTo(base, token, { device: DEV, name: 'Laura', answers: { l3a: 'Acuerdo corregido' } });
    const d2 = await ll.loadAll(db);
    assert.equal(d2.l3a, 'Acuerdo corregido');
    assert.equal(d2.l3b, 'El lunes');
  });
});
