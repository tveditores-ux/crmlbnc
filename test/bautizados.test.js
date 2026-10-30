'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bautizadosRouter } = require('../src/routes/bautizados');
const bz = require('../src/bautizados/store');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: false };
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });
const dmy = (iso) => iso.split('-').reverse().join('/');

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(bautizadosRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

test('bautizados: fechas y validación de una fila', () => {
  assert.equal(bz.parseDate('15/08/1998'), '1998-08-15');
  assert.equal(bz.parseDate('2026-03-01'), '2026-03-01');
  assert.equal(bz.parseDate('31/02/2026'), null);
  assert.equal(bz.parseDate('01/01/1900'), null);
  const ok = bz.validateRow({ name: '  Ana   Torres ', phone: '0414-111.22.33', baptism_date: '01/03/2026' }, '58', '2026-10-30');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.full_name, 'Ana Torres');
  assert.equal(ok.value.phone, '584141112233');
  assert.equal(ok.value.baptism_date, '2026-03-01');
  const bad = bz.validateRow({ name: '', phone: '12', baptism_date: '01/12/2026' }, '58', '2026-10-30');
  assert.equal(bad.errors.length, 3);
});

test('bautizados: lista simple (un nombre por línea, con teléfono opcional) con fecha y sede para todos', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const lista = 'Ana Torres, 0414-111.22.33\nLuis Mora\n\nluis mora\nCarmen Díaz';
    const fields = { csv: lista, baptism_date: day(-10), sede: 'Las Mercedes', source: 'Bautizos de prueba' };
    const rev = await (await post('/bautizados/importar', { ...fields, accion: 'revisar' })).text();
    assert.match(rev, /lista simple/);
    assert.match(rev, /Guardar 3 bautizados/); // "luis mora" repetido se omite
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizados')).rows[0].n, 0); // revisar no guarda
    const r = await post('/bautizados/importar', { ...fields, accion: 'guardar' });
    assert.equal(r.status, 303);
    assert.match(loc(r), /3 bautizados nuevos, 1 omitidos/);
    const rows = (await db.query('SELECT full_name, phone, baptism_date::text AS d, sede, source FROM bautizados ORDER BY full_name')).rows;
    assert.deepEqual(rows.map((x) => x.full_name), ['Ana Torres', 'Carmen Díaz', 'Luis Mora']);
    assert.equal(rows[0].phone, '584141112233');
    assert.ok(rows.every((x) => x.d === day(-10) && x.sede === 'Las Mercedes' && x.source === 'Bautizos de prueba'));
    // cargar la misma lista otra vez no duplica
    const again = await post('/bautizados/importar', { ...fields, accion: 'guardar' });
    assert.match(loc(again), /0 bautizados nuevos/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizados')).rows[0].n, 3);
  });
});

test('bautizados: archivo CSV con columnas; un error impide guardar todo', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const csv = ['Nombre;Teléfono;Fecha_bautismo;Sede;Ministro', `Pedro Pérez;0424-222.33.44;${dmy(day(-5))};Nuarito;Pastor Prueba`, 'María Gil;;15/08/1998;;'].join('\n');
    const bad = csv + '\nJosé Ruiz;;99/99/2020;;';
    const r1 = await (await post('/bautizados/importar', { csv: bad, accion: 'guardar' })).text();
    assert.match(r1, /No se puede guardar todavía/);
    assert.match(r1, /Línea 4: Fecha no válida/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizados')).rows[0].n, 0);
    const r2 = await post('/bautizados/importar', { csv, baptism_date: day(-1), accion: 'guardar' });
    assert.match(loc(r2), /2 bautizados nuevos/);
    const p = (await db.query("SELECT phone, baptism_date::text AS d, minister, source FROM bautizados WHERE full_name = 'Pedro Pérez'")).rows[0];
    assert.deepEqual(p, { phone: '584242223344', d: day(-5), minister: 'Pastor Prueba', source: 'Lista cargada' });
    const m = (await db.query("SELECT baptism_date::text AS d FROM bautizados WHERE full_name = 'María Gil'")).rows[0];
    assert.equal(m.d, '1998-08-15'); // la fecha de la fila manda sobre la de toda la lista
  });
});

test('bautizados: agregar uno por uno, sin duplicar, corregir, escapar y borrar', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const r = await post('/bautizados', { name: 'Rosa <b>Peña</b>', phone: '0412-333.44.55', baptism_date: day(-3), sede: '', minister: '', note: '' });
    assert.equal(r.status, 303);
    assert.match(loc(r), /Agregado/);
    const id = (await db.query('SELECT id FROM bautizados')).rows[0].id;
    const dup = await post('/bautizados', { name: 'Otra Persona', phone: '+58 412 3334455', baptism_date: '' });
    assert.equal(loc(dup).split('?')[0], `/bautizados/${id}`);
    assert.match(loc(dup), /ya estaba registrada/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizados')).rows[0].n, 1);
    const sinNombre = await (await post('/bautizados', { name: ' ', baptism_date: day(-1) })).text();
    assert.match(sinNombre, /Falta el nombre/);
    const futura = await (await post('/bautizados', { name: 'Futuro', baptism_date: day(5) })).text();
    assert.match(futura, /no puede ser futura/);
    const list = await (await get('/bautizados')).text();
    assert.ok(!list.includes('<b>Peña</b>'));
    assert.match(list, /Rosa &lt;b&gt;Peña/);
    assert.match(list, /Cargar una lista/);
    assert.match(list, /Agregar un bautizado/);
    assert.equal((await get('/bautizados')).headers.get('cache-control'), 'no-store');
    await post(`/bautizados/${id}`, { name: 'Rosa Peña', phone: '', baptism_date: day(-3), sede: 'Centro', minister: 'Pastor Prueba', note: 'nota' });
    const x = (await db.query('SELECT full_name, phone, sede FROM bautizados WHERE id = $1', [id])).rows[0];
    assert.deepEqual(x, { full_name: 'Rosa Peña', phone: null, sede: 'Centro' });
    const del = await post(`/bautizados/${id}/eliminar`, {});
    assert.match(loc(del), /borrado/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizados')).rows[0].n, 0);
  });
});

test('bautizados: reporte para imprimir con filtros, vínculo desde la lista y sin notas', async (t) => {
  await withApp(t, async ({ get, post }) => {
    await post('/bautizados/importar', { csv: 'Ana Torres, 0414-111.22.33\nLuis Mora', baptism_date: day(-10), sede: 'Las Mercedes', minister: 'Pastor Prueba', accion: 'guardar' });
    await post('/bautizados/importar', { csv: 'Carmen <i>Díaz</i>', baptism_date: day(-40), sede: 'Nuarito', accion: 'guardar' });
    await post('/bautizados', { name: 'Pedro Gil', baptism_date: day(-10), sede: 'Nuarito', note: 'nota privada' });
    const list = await (await get('/bautizados?sede=Nuarito')).text();
    assert.match(list, /href="\/bautizados\/reporte\?sede=Nuarito"/);
    assert.match(list, /Imprimir reporte/);
    const all = await (await get('/bautizados/reporte')).text();
    assert.match(all, /Reporte de bautizados/);
    assert.match(all, /window\.print\(\)/);
    assert.match(all, /<div class="stat">4<\/div>/);
    assert.match(all, /Pastor Prueba/);
    assert.ok(!all.includes('<i>Díaz</i>'));
    assert.ok(!all.includes('nota privada'));
    const sede = await (await get('/bautizados/reporte?sede=Nuarito')).text();
    assert.match(sede, /<div class="stat">2<\/div>/);
    assert.match(sede, /Sede: Nuarito/);
    const rango = await (await get(`/bautizados/reporte?desde=${day(-15)}&hasta=${day(0)}`)).text();
    assert.match(rango, /<div class="stat">3<\/div>/);
    assert.ok(!rango.includes('Carmen'));
  });
});

test('bautizados: gráficas por mes, por sede y por año en la lista y en el reporte', async (t) => {
  await withApp(t, async ({ get, post }) => {
    const empty = await (await get('/bautizados')).text();
    assert.ok(!empty.includes('Bautizados por mes'));
    await post('/bautizados/importar', { csv: 'Ana Torres\nLuis Mora', baptism_date: '2026-10-24', sede: 'Las Mercedes', accion: 'guardar' });
    await post('/bautizados/importar', { csv: 'Carmen Díaz', baptism_date: '2026-07-10', sede: 'Nuarito', accion: 'guardar' });
    const list = await (await get('/bautizados')).text();
    assert.match(list, /Bautizados por mes/);
    assert.match(list, /aria-label="Bautizados por sede"/);
    assert.match(list, /<title>jul 26: 1<\/title>/);
    assert.match(list, /<title>ago 26: 0<\/title>/); // los meses sin bautizos salen en cero
    assert.match(list, /<title>oct 26: 2<\/title>/);
    assert.ok(!list.includes('Bautizados por año')); // un solo año: no hace falta
    await post('/bautizados', { name: 'Rosa Peña', baptism_date: '15/08/1998', sede: 'Nuarito' });
    const rep = await (await get('/bautizados/reporte')).text();
    assert.match(rep, /aria-label="Bautizados por año"/);
    assert.match(rep, /<title>Nuarito: 2<\/title>/);
    const nuarito = await (await get('/bautizados/reporte?sede=Nuarito&anio=2026')).text();
    assert.match(nuarito, /<title>jul 26: 1<\/title>/);
    assert.ok(!nuarito.includes('oct 26'));
  });
});

test('bautizados: completar teléfonos desde Personas y Nueva Vida, solo lo que se elige a mano', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await db.query(`INSERT INTO people (full_name, phone, opt_in) VALUES ('Ana María Torres', '584141112233', FALSE), ('Ariana Lucena', '584125550000', FALSE), ('Diego', '584125551111', FALSE), ('Rosa Peña', '584125552222', FALSE)`);
    await db.query(`INSERT INTO nueva_vida (full_name, phone) VALUES ('Luis Mora', '584245553333')`);
    await post('/bautizados/importar', { csv: 'Ana Torres\nEsteban Lucena\nDiego\nLuis Mora\nRosa Peña, 0412-555.22.22\nCarlos Gil', baptism_date: day(-5), accion: 'guardar' });
    const list = await (await get('/bautizados')).text();
    assert.match(list, /Completar teléfonos \(5 sin teléfono\)/);
    const page = await (await get('/bautizados/telefonos')).text();
    assert.match(page, /Ana María Torres/); // nombre parecido
    assert.match(page, /Luis Mora/); // desde Nueva Vida
    assert.ok(!page.includes('Ariana Lucena')); // solo el apellido: no es sugerencia
    assert.ok(!page.includes('0412-555.11.11')); // "Diego" solo, sin apellido: no alcanza
    assert.ok(!page.includes('Rosa Peña')); // Rosa ya tiene teléfono, y su número no se ofrece a nadie más
    assert.ok(!page.includes('Carlos Gil'));
    const id = async (name) => (await db.query('SELECT id FROM bautizados WHERE full_name = $1', [name])).rows[0].id;
    const ana = await id('Ana Torres');
    const luis = await id('Luis Mora');
    const p = (await db.query("SELECT id FROM people WHERE full_name = 'Ana María Torres'")).rows[0].id;
    const nvId = (await db.query("SELECT id FROM nueva_vida WHERE full_name = 'Luis Mora'")).rows[0].id;
    // Una elección inventada (otra persona que no era sugerencia) no se guarda.
    const fake = (await db.query("SELECT id FROM people WHERE full_name = 'Ariana Lucena'")).rows[0].id;
    const esteban = await id('Esteban Lucena');
    const r = await post('/bautizados/telefonos', { [`b_${ana}`]: `p:${p}`, [`b_${luis}`]: `n:${nvId}`, [`b_${esteban}`]: `p:${fake}` });
    assert.match(loc(r), /Teléfonos guardados: 2\. 1 no se guardaron/);
    const rows = Object.fromEntries((await db.query('SELECT full_name, phone, note FROM bautizados')).rows.map((x) => [x.full_name, x]));
    assert.equal(rows['Ana Torres'].phone, '584141112233');
    assert.match(rows['Ana Torres'].note, /Teléfono tomado de Personas \(Ana María Torres\)/);
    assert.equal(rows['Luis Mora'].phone, '584245553333');
    assert.equal(rows['Esteban Lucena'].phone, null);
    assert.equal(rows['Carlos Gil'].phone, null);
    const none = await post('/bautizados/telefonos', {});
    assert.match(loc(none), /No elegiste/);
  });
});

test('bautizados: foto individual y por lote (JSON), validada, servida con sesión y borrada con el registro', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7), Buffer.from([0xff, 0xd9])]);
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    await post('/bautizados/importar', { csv: 'Ana Torres\nLuis Mora', baptism_date: day(-3), accion: 'guardar' });
    const id = async (name) => (await db.query('SELECT id FROM bautizados WHERE full_name = $1', [name])).rows[0].id;
    const ana = await id('Ana Torres');
    const luis = await id('Luis Mora');
    assert.equal((await get(`/bautizados/${ana}/foto`)).status, 404);
    // Individual (formulario de la ficha)
    const r1 = await post(`/bautizados/${ana}/foto`, { photo_data: dataUrl });
    assert.match(loc(r1), new RegExp(`/bautizados/${ana}\\?ok=Foto guardada`));
    const img = await get(`/bautizados/${ana}/foto`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(img.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg);
    // Por lote: la página pide JSON
    const json = (p, fields) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields) });
    const base = (await get('/bautizados')).url.replace(/\/bautizados$/, '');
    const ok = await json(`${base}/bautizados/${luis}/foto`, { photo_data: dataUrl });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: 'Foto guardada.' });
    const bad = await json(`${base}/bautizados/${luis}/foto`, { photo_data: 'data:image/png;base64,AAAA' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /No pude leer la foto/);
    const notJpeg = await json(`${base}/bautizados/${luis}/foto`, { photo_data: `data:image/jpeg;base64,${Buffer.alloc(400, 1).toString('base64')}` });
    assert.equal(notJpeg.status, 400);
    const missing = await json(`${base}/bautizados/999999/foto`, { photo_data: dataUrl });
    assert.equal(missing.status, 404);
    // La lista muestra la miniatura y cuenta las fotos; la página de lote trae la lista para emparejar
    const list = await (await get('/bautizados')).text();
    assert.match(list, new RegExp(`src="/bautizados/${ana}/foto\\?v=\\d+"`));
    assert.match(list, /<div class="stat">2<\/div><div class="stat-label">con foto/);
    const lote = await (await get('/bautizados/fotos')).text();
    assert.match(lote, /"name":"Ana Torres","key":"ana torres"/);
    assert.match(lote, /\(ya tiene foto\)/);
    // Quitar la foto y borrar el registro (la foto se va con él)
    const q = await post(`/bautizados/${ana}/foto/eliminar`, {});
    assert.match(loc(q), /Foto quitada/);
    assert.equal((await get(`/bautizados/${ana}/foto`)).status, 404);
    await post(`/bautizados/${luis}/eliminar`, {});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizados_fotos')).rows[0].n, 0);
  });
});

test('bautizados: fotos generales del bautizo por fecha, validadas, servidas con sesión y borrables', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 9), Buffer.from([0xff, 0xd9])]);
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    await post('/bautizados/importar', { csv: 'Ana Torres\nLuis Mora', baptism_date: day(-6), sede: 'Las Mercedes', accion: 'guardar' });
    const empty = await (await get('/bautizados/generales')).text();
    assert.match(empty, /Todavía no hay fotos generales/);
    assert.match(empty, new RegExp(`<option value="${day(-6)}" selected>`)); // propone la fecha del último bautizo
    const base = (await get('/bautizados')).url.replace(/\/bautizados$/, '');
    const send = (fields) => fetch(`${base}/bautizados/generales`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields) });
    const ok = await send({ photo_data: dataUrl, baptism_date: day(-6), sede: 'Las Mercedes', note: 'Todos con los <b>pastores</b>' });
    assert.equal(ok.status, 200);
    const { id } = await ok.json();
    await send({ photo_data: dataUrl, baptism_date: day(-6) });
    assert.equal((await send({ photo_data: dataUrl, baptism_date: '' })).status, 400);
    assert.equal((await send({ photo_data: dataUrl, baptism_date: day(3) })).status, 400);
    assert.equal((await send({ photo_data: 'data:image/png;base64,AAAA', baptism_date: day(-6) })).status, 400);
    const page = await (await get('/bautizados/generales')).text();
    assert.match(page, new RegExp(`Bautizo del ${day(-6).split('-').reverse().join('/')}`));
    assert.match(page, /\(2 fotos\)/);
    assert.match(page, /Todos con los &lt;b&gt;pastores/);
    assert.match(await (await get('/bautizados')).text(), /href="\/bautizados\/generales"/);
    const img = await get(`/bautizados/generales/${id}/foto`);
    assert.equal(img.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg);
    const del = await post(`/bautizados/generales/${id}/eliminar`, {});
    assert.match(loc(del), /Foto borrada/);
    assert.equal((await get(`/bautizados/generales/${id}/foto`)).status, 404);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bautizos_fotos_generales')).rows[0].n, 1);
  });
});
