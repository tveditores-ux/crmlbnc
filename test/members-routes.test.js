'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { membersRouter } = require('../src/routes/members');
const { adminRouter } = require('../src/routes/admin');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, sendWindowStart: 8, sendWindowEnd: 20, whatsapp: {}, email: {}, agent: {} };

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(membersRouter({ db: h.db, config }));
  app.use(adminRouter({ db: h.db, config, channels: { whatsapp: { available: false }, email: { available: false } } }));
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

const CSV = ['Nombre,Teléfono,Admin,Origen del nombre', 'Persona Uno,0414-000.00.01,No,', 'Perfil Dos,0414-000.00.02,Sí,Perfil de WhatsApp', '(sin nombre),0414-000.00.03,No,'].join('\n');
const idOf = async (db, phone) => (await db.query('SELECT id FROM people WHERE phone = $1', [phone])).rows[0].id;
const tipoOf = async (db, phone) => (await db.query('SELECT membership FROM people WHERE phone = $1', [phone])).rows[0].membership;

test('la lista muestra contadores, filtros, botones y enlaces a la ficha; está en el menú; sin caché', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    const r = await get('/miembros');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /<a href="\/miembros" class="on">Miembros y amigos<\/a>/);
    assert.match(html.split('<nav>')[1], /Personas<\/a><a href="\/miembros"/); // justo después de Personas
    for (const label of ['miembros', 'amigos', 'por clasificar', 'en el grupo oficial']) assert.match(html, new RegExp(`stat-label">${label}<`));
    for (const f of ['Todos', 'Miembros', 'Amigos', 'Por clasificar']) assert.match(html, new RegExp(`>${f} <strong>`));
    assert.match(html, /name="q"/);
    assert.match(html, new RegExp(`href="/personas/${await idOf(db, '584140000001')}"`));
    assert.match(html, /0414-000\.00\.01/); // displayPhone
    assert.equal((html.match(/>Miembro<\/button>/g) || []).length, 3); // un botón "Miembro" y uno "Amigo" por fila
    assert.equal((html.match(/>Amigo<\/button>/g) || []).length, 3);
    assert.match(html, /Descargar lista/);
    assert.match(html, /\/miembros\/importar/);
  });
});

test('los botones cambian el tipo, vuelven al mismo filtro y búsqueda, y no aceptan valores raros', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    const id = await idOf(db, '584140000001');
    let r = await post(`/miembros/${id}/tipo`, { tipo: 'miembro', filtro: 'sin', q: 'persona' });
    assert.equal(r.status, 303);
    assert.match(loc(r), /^\/miembros\?tipo=sin&q=persona&ok=Persona Uno: Miembro$/);
    assert.equal(await tipoOf(db, '584140000001'), 'miembro');
    r = await post(`/miembros/${id}/tipo`, { tipo: 'amigo', filtro: 'todos', q: '' });
    assert.match(loc(r), /^\/miembros\?ok=Persona Uno: Amigo$/); // sin filtro ni búsqueda: vuelve a la lista completa
    assert.equal(await tipoOf(db, '584140000001'), 'amigo');
    // valores raros: no cambian nada, y el filtro desconocido se ignora (no se copia a la URL)
    for (const tipo of ['visitante', 'constructor', '__proto__']) {
      r = await post(`/miembros/${id}/tipo`, { tipo, filtro: '<script>', q: 'x' });
      assert.match(loc(r), /^\/miembros\?q=x&err=Tipo no válido\.$/, tipo);
      assert.equal(await tipoOf(db, '584140000001'), 'amigo');
    }
    r = await post('/miembros/999999/tipo', { tipo: 'miembro', filtro: 'todos' });
    assert.match(loc(r), /err=No existe esa persona\./);
    assert.equal((await post('/miembros/99999999999/tipo', { tipo: 'miembro' })).status, 404);
    // un redirect nunca sale del sitio
    r = await post(`/miembros/${id}/tipo`, { tipo: 'miembro', filtro: 'https://malo.example', q: 'https://malo.example' });
    assert.ok(loc(r).startsWith('/miembros'));
    assert.ok(!loc(r).startsWith('//'));
    // la lista filtrada solo trae a los de ese tipo y muestra el aviso
    await post(`/miembros/${await idOf(db, '584140000002')}/tipo`, { tipo: 'amigo', filtro: 'todos' });
    assert.equal(await tipoOf(db, '584140000001'), 'miembro'); // el último cambio válido de arriba
    const amigos = (await (await get('/miembros?tipo=amigo')).text()).split('<h2>')[1];
    assert.match(amigos, /Perfil Dos/);
    assert.ok(!amigos.includes('Persona Uno'));
    const miembros = (await (await get('/miembros?tipo=miembro')).text()).split('<h2>')[1];
    assert.match(miembros, /Persona Uno/);
    assert.ok(!miembros.includes('Perfil Dos'));
    assert.match(await (await get('/miembros?tipo=miembro&q=zzzz')).text(), /No hay nadie con ese filtro/);
    const sin = (await (await get('/miembros?tipo=sin')).text()).split('<h2>')[1];
    assert.match(sin, /0414-000\.00\.03/);
    assert.ok(!sin.includes('Perfil Dos'));
    const q = (await (await get('/miembros?q=0414-000.00.02')).text()).split('<h2>')[1];
    assert.match(q, /Perfil Dos/);
    assert.ok(!q.includes('0414-000.00.03'));
  });
});

test('descargar la lista respeta el filtro, usa displayPhone y neutraliza fórmulas de nombres de perfil', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    await db.query(`UPDATE people SET full_name = '=HYPERLINK("http://malo.example","clic")' WHERE phone = '584140000003'`);
    await post(`/miembros/${await idOf(db, '584140000001')}/tipo`, { tipo: 'miembro', filtro: 'todos' });
    const all = await get('/miembros/exportar.csv');
    assert.match(all.headers.get('content-type'), /text\/csv/);
    assert.match(all.headers.get('content-disposition'), /miembros-y-amigos\.csv/);
    const csv = await all.text();
    assert.match(csv, /Nombre,Teléfono,Tipo,En el grupo oficial/);
    assert.match(csv, /Persona Uno,0414-000\.00\.01,Miembro,Sí/);
    assert.match(csv, /Perfil Dos,0414-000\.00\.02,Por clasificar,Sí/);
    assert.ok(!/\r\n=HYPERLINK/.test(csv)); // la fórmula no queda al inicio de una celda
    assert.match(csv, /'=HYPERLINK/);
    const only = await (await get('/miembros/exportar.csv?tipo=miembro')).text();
    assert.match(only, /Persona Uno/);
    assert.ok(!only.includes('Perfil Dos'));
    const sin = await (await get('/miembros/exportar.csv?tipo=sin&q=perfil')).text();
    assert.match(sin, /Perfil Dos/);
    assert.ok(!sin.includes('Persona Uno'));
  });
});

test('importar por pantalla: revisar no guarda, errores bloquean, importar crea y actualiza sin duplicar', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const page = await (await get('/miembros/importar')).text();
    assert.match(page, /Revisar sin guardar/);
    assert.match(page, /type="file"/);
    const rev = await (await post('/miembros/importar', { csv: CSV, accion: 'revisar' })).text();
    assert.match(rev, /Todo correcto: 3 personas nuevas y 0 por actualizar/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 0);
    const ok = await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    assert.equal(ok.status, 303);
    assert.match(loc(ok), /^\/miembros\?ok=Importación lista: 3 nuevas, 0 actualizadas\./);
    const again = await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    assert.match(loc(again), /0 nuevas, 3 actualizadas/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE opt_in')).rows[0].n, 0);
    const bad = await (await post('/miembros/importar', { csv: 'Nombre,Teléfono\nA,12\nB,', accion: 'importar' })).text();
    assert.match(bad, /Hay 2 fila\(s\) con problemas/);
    assert.match(bad, /Teléfono no válido/);
    assert.match(bad, /Falta el teléfono/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3);
  });
});

test('los nombres se escapan en pantalla', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    await db.query(`UPDATE people SET full_name = '<script>alert(1)</script>', whatsapp_name = '<img src=x onerror=alert(2)>' WHERE phone = '584140000002'`);
    const html = await (await get('/miembros')).text();
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;script&gt;alert\(1\)/);
    const q = await (await get('/miembros?q=%22%3E%3Cscript%3Ealert(3)%3C/script%3E')).text();
    assert.ok(!q.includes('<script>alert(3)'));
  });
});

test('la ficha de la persona tiene el selector de tipo y lo guarda sin que otros cambios lo borren', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    const id = await idOf(db, '584140000001');
    const ficha = await (await get(`/personas/${id}`)).text();
    assert.match(ficha, /name="membership"/);
    assert.match(ficha, /<option value="">Por clasificar<\/option>/);
    assert.match(ficha, /<option value="miembro" >Miembro<\/option>/);
    const body = { full_name: 'Persona Uno', phone: '0414-000.00.01', preferred_channel: 'whatsapp', active: '1', access_level: 'ninguno' };
    let r = await post(`/personas/${id}`, { ...body, membership: 'amigo' });
    assert.equal(r.status, 303);
    assert.equal(await tipoOf(db, '584140000001'), 'amigo');
    assert.match(await (await get(`/personas/${id}`)).text(), /<option value="amigo" selected>Amigo<\/option>/);
    r = await post(`/personas/${id}`, { ...body, membership: 'visitante' });
    assert.match(loc(r), /err=Se guardó la persona, pero el tipo no: Tipo no válido/);
    assert.equal(await tipoOf(db, '584140000001'), 'amigo');
    // un formulario sin el campo (por ejemplo, otra pantalla) no toca el tipo
    r = await post(`/personas/${id}`, { ...body, notes: 'solo una nota' });
    assert.equal(r.status, 303);
    assert.equal(await tipoOf(db, '584140000001'), 'amigo');
    // al volver a "Por clasificar"
    await post(`/personas/${id}`, { ...body, membership: '' });
    assert.equal(await tipoOf(db, '584140000001'), '');
    // si el formulario falla por otro motivo, el tipo elegido no se pierde al mostrarlo de nuevo
    const err = await post(`/personas/${id}`, { ...body, full_name: '', membership: 'miembro' });
    assert.equal(err.status, 200);
    assert.match(await err.text(), /<option value="miembro" selected>Miembro<\/option>/);
  });
});

test('importar personas por la pantalla de siempre no borra el tipo ni el grupo oficial', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await post('/miembros/importar', { csv: CSV, accion: 'importar' });
    await post(`/miembros/${await idOf(db, '584140000001')}/tipo`, { tipo: 'miembro', filtro: 'todos' });
    const rep = await post('/personas/importar', { csv: 'nombre,telefono,rol\nPersona Uno Actualizada,0414-000.00.01,Diácono', accion: 'importar' });
    assert.equal(rep.status, 303);
    const p = (await db.query(`SELECT full_name, role, membership, in_official_group FROM people WHERE phone = '584140000001'`)).rows[0];
    assert.deepEqual([p.membership, p.in_official_group], ['miembro', true]);
  });
});
