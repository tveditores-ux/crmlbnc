'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { nuevaVidaRouter } = require('../src/routes/nueva-vida');
const { consolidationRouter } = require('../src/routes/consolidation');
const nv = require('../src/nuevavida/store');
const { openTestDb } = require('./helpers/db');

const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: false };
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(nuevaVidaRouter({ db: h.db, config }));
  app.use(consolidationRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
    return fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  };
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

const CSV = [
  nv.TEMPLATE_HEADERS.join(','),
  `Ana Torres,0414-111.22.33,,${day(-40)},,Las Mercedes,29,soltera,"Urb. Secreta, calle 2",Fiesta,Llamó Eduardo,,Tabla,no,,texto A`,
  `Luis Mora,0424-222.33.44,,${day(-30)},,Nuarito,17,,,,,,Tabla,si,fecha heredada,texto B`,
  `,0412-333.44.55,,${day(-20)},,,,,,,,,Hoja,si,nombre ilegible,texto C original`,
].join('\n');

test('la lista no muestra direcciones ni edades, y la ficha sí; los textos se escapan', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/nueva-vida/importar', { csv: CSV, accion: 'guardar' });
    await db.query(`UPDATE nueva_vida SET full_name = '<script>alert(1)</script>' WHERE phone = '584242223344'`);
    const list = await (await get('/nueva-vida')).text();
    assert.ok(!list.includes('Urb. Secreta'));
    assert.ok(!list.includes('<script>alert(1)'));
    assert.match(list, /Ana Torres/);
    assert.match(list, /\(sin nombre leído\)/);
    assert.equal((list.match(/class="badge b-warn"/g) || []).length >= 2, true); // las dos marcadas para revisar
    const id = (await db.query(`SELECT id FROM nueva_vida WHERE full_name = 'Ana Torres'`)).rows[0].id;
    const ficha = await (await get(`/nueva-vida/${id}`)).text();
    assert.match(ficha, /Urb\. Secreta/);
    assert.match(ficha, /texto A/);
    const minor = (await db.query(`SELECT id FROM nueva_vida WHERE phone = '584242223344'`)).rows[0].id;
    const fm = await (await get(`/nueva-vida/${minor}`)).text();
    assert.match(fm, /Menor de edad/);
    assert.ok(!fm.includes('<script>alert(1)'));
    assert.equal((await get('/nueva-vida')).headers.get('cache-control'), 'no-store');
  });
});

test('cargar por pantalla: revisar no guarda, errores bloquean, guardar omite lo que ya estaba', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const rev = await (await post('/nueva-vida/importar', { csv: CSV, accion: 'revisar' })).text();
    assert.match(rev, /personas nuevas/);
    assert.match(rev, /Guardar 3 personas/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida')).rows[0].n, 0);
    const ok = await post('/nueva-vida/importar', { csv: CSV, accion: 'guardar' });
    assert.equal(ok.status, 303);
    assert.match(loc(ok), /Carga lista: 3 personas nuevas/);
    const again = await post('/nueva-vida/importar', { csv: CSV, accion: 'guardar' });
    assert.match(loc(again), /0 personas nuevas, 3 omitidas/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida')).rows[0].n, 3);
    const bad = await (await post('/nueva-vida/importar', { csv: 'nombre,telefono\nA,12', accion: 'guardar' })).text();
    assert.match(bad, /No se puede guardar todavía/);
    assert.match(bad, /Línea 2: Teléfono no válido/);
  });
});

test('filtros de la lista y borrado', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await post('/nueva-vida/importar', { csv: CSV, accion: 'guardar' });
    const fuente = await (await get('/nueva-vida?fuente=Hoja')).text();
    assert.ok(!fuente.split('<h2>Personas')[1].includes('Ana Torres'));
    assert.match(fuente.split('<h2>Personas')[1], /sin nombre leído/);
    const q = await (await get('/nueva-vida?q=ana')).text();
    assert.match(q.split('<h2>Personas')[1], /Ana Torres/);
    assert.ok(!q.split('<h2>Personas')[1].includes('Luis Mora'));
    const id = (await db.query(`SELECT id FROM nueva_vida WHERE full_name = 'Luis Mora'`)).rows[0].id;
    assert.match(loc(await post(`/nueva-vida/${id}/eliminar`, {})), /ok=Registro borrado/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM nueva_vida')).rows[0].n, 2);
    assert.equal((await get('/nueva-vida/99999999999')).status, 404);
  });
});

test('editar corrige el nombre ilegible y quita la marca de revisión', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await post('/nueva-vida/importar', { csv: CSV, accion: 'guardar' });
    const id = (await db.query(`SELECT id FROM nueva_vida WHERE phone = '584123334455'`)).rows[0].id;
    const bad = await post(`/nueva-vida/${id}`, { name: '', phone: '0412-333.44.55', decision_date: day(-20) });
    assert.equal(bad.status, 200);
    assert.match(await bad.text(), /Escribe el nombre/);
    const ok = await post(`/nueva-vida/${id}`, { name: 'María Corregida', phone: '0412-333.44.55', decision_date: day(-20), sede: 'Las Mercedes', needs_review: '' });
    assert.match(loc(ok), /ok=Guardado/);
    const row = (await db.query('SELECT full_name, needs_review FROM nueva_vida WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { full_name: 'María Corregida', needs_review: false });
    const fut = await post(`/nueva-vida/${id}`, { name: 'María', decision_date: day(5) });
    assert.match(await fut.text(), /La fecha no puede ser futura/);
  });
});

test('conectar desde la ficha y en bloque; lo histórico no cuenta en el embudo hasta que se pide', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await db.query(`INSERT INTO people (full_name, phone) VALUES ('Ana Torres Pérez', '584141112233')`);
    await db.query(`INSERT INTO people (full_name) VALUES ('Luis Alberto Mora')`);
    await post('/nueva-vida/importar', { csv: CSV, accion: 'guardar' });
    const ids = (await db.query('SELECT id FROM nueva_vida ORDER BY id')).rows.map((r) => r.id);

    // en bloque: Ana se conecta; Luis pide confirmar; la de nombre ilegible se rechaza
    const bulk = await post('/nueva-vida/conectar', { ids: ids.map(String), historical: '1' });
    assert.match(loc(bulk), /1 conectadas, 1 piden confirmar el nombre \(ábrelas una por una\), 1 sin nombre legible/);
    assert.equal((await post('/nueva-vida/conectar', { historical: '1' })).status, 303);
    assert.match(loc(await post('/nueva-vida/conectar', {})), /err=Elige al menos una persona/);

    // el embudo normal no la cuenta; con "incluir históricas" sí
    const funnel = await (await get('/consolidacion')).text();
    assert.match(funnel, /<td>Decisión<\/td><td>0<\/td>/);
    const hist = await (await get('/consolidacion?historicos=1')).text();
    assert.match(hist, /<td>Decisión<\/td><td>1<\/td>/);
    assert.match(hist, /Histórica/);
    assert.match(hist, /Estás viendo también a las personas históricas/);

    // desde la ficha de Luis: pide confirmar, luego se conecta con la persona elegida
    const luis = ids[1];
    const ask = await post(`/nueva-vida/${luis}/conectar`, { historical: '1' });
    assert.equal(ask.status, 200);
    const html = await ask.text();
    assert.match(html, /¿Ya la tenemos registrada\?/);
    assert.match(html, /Luis Alberto Mora/);
    const similar = (await db.query(`SELECT id FROM people WHERE full_name = 'Luis Alberto Mora'`)).rows[0].id;
    assert.match(loc(await post(`/nueva-vida/${luis}/conectar`, { historical: '1', choice: '999999' })), /err=Elección no válida/);
    const done = await post(`/nueva-vida/${luis}/conectar`, { historical: '1', choice: String(similar) });
    assert.equal(done.status, 303);
    assert.match(loc(done), /^\/consolidacion\/\d+\?ok=Conectada a consolidación/);
    const rec = (await db.query('SELECT person_id FROM nueva_vida WHERE id = $1', [luis])).rows[0];
    assert.equal(rec.person_id, similar);
    assert.match(loc(await post(`/nueva-vida/${luis}/conectar`, { historical: '1' })), /err=Esa persona ya estaba conectada/);
    // la ficha de consolidación marca que es histórica; la de Nueva Vida enlaza a ella
    const cid = (await db.query('SELECT consolidation_id FROM nueva_vida WHERE id = $1', [luis])).rows[0].consolidation_id;
    assert.match(await (await get(`/consolidacion/${cid}`)).text(), /Histórica/);
    assert.match(await (await get(`/nueva-vida/${luis}`)).text(), /En consolidación \(histórica\)/);
    // ninguna persona quedó con consentimiento
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE opt_in')).rows[0].n, 0);
  });
});

test('registrar a mano un nuevo creyente y conectarlo como NO histórico', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const r = await post('/nueva-vida', { name: 'Persona Reciente', phone: '0416-700.80.90', decision_date: day(-2), sede: 'Las Mercedes', age: '31' });
    assert.match(loc(r), /^\/nueva-vida\/\d+\?ok=Registrado/);
    const id = Number(loc(r).match(/\/nueva-vida\/(\d+)/)[1]);
    assert.equal((await post('/nueva-vida', { name: '' })).status, 200);
    const c = await post(`/nueva-vida/${id}/conectar`, {}); // sin marcar "histórica"
    assert.equal(c.status, 303);
    assert.match(await (await get('/consolidacion')).text(), /<td>Decisión<\/td><td>1<\/td>/); // entra en el embudo real
  });
});
