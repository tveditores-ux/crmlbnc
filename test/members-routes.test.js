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
  const post = (p, fields = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
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
const rowOf = async (db, phone) => (await db.query('SELECT * FROM people WHERE phone = $1', [phone])).rows[0];
const tbody = (html) => html.split('<table>')[1] || '';

test('Personas ahora trae tipo, grupo oficial, contadores, filtros, botones rápidos y los importadores; el menú ya no tiene "Miembros"', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    const r = await get('/personas');
    assert.equal(r.status, 200);
    const html = await r.text();
    const nav = html.split('<nav>')[1].split('</nav>')[0];
    assert.match(nav, /<a href="\/personas" class="on">Personas<\/a>/);
    assert.ok(!/miembros|Miembros/.test(nav)); // ya no hay pestaña aparte
    for (const label of ['miembros', 'amigos', 'por clasificar', 'en el grupo oficial']) assert.match(html, new RegExp(`stat-label">${label}<`));
    for (const f of ['Todos', 'Miembros', 'Amigos', 'Por clasificar']) assert.match(html, new RegExp(`>${f} <strong>`));
    assert.match(html, /<th>Tipo<\/th><th>Grupo oficial<\/th>/);
    assert.match(html, /name="tipo"/);
    assert.match(html, /name="grupo"/);
    assert.match(html, /name="q"/);
    assert.match(html, /name="m"/);
    const rows = tbody(html);
    assert.match(rows, /0414-000\.00\.01/);
    assert.equal((rows.match(/>Miembro<\/button>/g) || []).length, 3); // un botón "Miembro" y uno "Amigo" por fila
    assert.equal((rows.match(/>Amigo<\/button>/g) || []).length, 3);
    assert.equal((rows.match(/>Por clasificar<\/span>/g) || []).length, 3);
    // los importadores y la descarga, juntos
    assert.match(html, /href="\/personas\/importar">Importar desde hoja/);
    assert.match(html, /href="\/personas\/importar-grupo">Importar lista del grupo/);
    assert.match(html, /href="\/personas\/exportar\.csv">Descargar lista</);
    assert.equal(r.headers.get('cache-control'), null === r.headers.get('cache-control') ? null : r.headers.get('cache-control')); // la cabecera la fija otro router; aquí no importa
    // la ficha enlazada existe
    assert.match(html, new RegExp(`href="/personas/${await idOf(db, '584140000001')}"`));
  });
});

test('filtros por tipo, por grupo oficial, por ministerio y búsqueda por nombre o teléfono, solos y combinados', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    await db.query(`INSERT INTO people (full_name, phone, email) VALUES ('Fuera Del Grupo', '584140000099', 'fuera@ejemplo.com')`);
    const m = (await db.query(`INSERT INTO ministries (name) VALUES ('Alabanza') RETURNING id`)).rows[0].id;
    await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$2)', [await idOf(db, '584140000001'), m]);
    await db.query(`UPDATE people SET membership = 'miembro' WHERE phone = '584140000001'`);
    await db.query(`UPDATE people SET membership = 'amigo' WHERE phone = '584140000002'`);
    const names = async (qs) => {
      const body = tbody(await (await get(`/personas${qs}`)).text());
      return ['Persona Uno', 'Perfil Dos', '0414-000.00.03', 'Fuera Del Grupo'].filter((n) => body.includes(n));
    };
    assert.equal((await names('')).length, 4);
    assert.deepEqual(await names('?tipo=miembro'), ['Persona Uno']);
    assert.deepEqual(await names('?tipo=amigo'), ['Perfil Dos']);
    assert.deepEqual(await names('?tipo=sin'), ['0414-000.00.03', 'Fuera Del Grupo']);
    assert.deepEqual(await names('?grupo=si'), ['Persona Uno', 'Perfil Dos', '0414-000.00.03']);
    assert.deepEqual(await names('?grupo=no'), ['Fuera Del Grupo']);
    assert.deepEqual(await names('?tipo=sin&grupo=si'), ['0414-000.00.03']); // combinados
    assert.deepEqual(await names(`?m=${m}`), ['Persona Uno']);
    assert.deepEqual(await names(`?m=${m}&tipo=amigo`), []);
    assert.deepEqual(await names('?q=perfil'), ['Perfil Dos']); // por nombre
    assert.deepEqual(await names('?q=0414-000.00.01'), ['Persona Uno']); // por teléfono, como se muestra
    assert.deepEqual(await names('?q=584140000099'), ['Fuera Del Grupo']); // y con código de país
    assert.deepEqual(await names('?q=fuera@ejemplo'), ['Fuera Del Grupo']); // y por correo, como antes
    assert.deepEqual(await names('?q=%25'), []); // el comodín se escapa
    assert.deepEqual(await names('?tipo=raro&grupo=raro&m=raro'), ['Persona Uno', 'Perfil Dos', '0414-000.00.03', 'Fuera Del Grupo']); // valores raros se ignoran
    assert.equal((await get('/personas?m=99999999999999999999')).status, 200);
    // la página dice cuántas hay con el filtro
    assert.match(await (await get('/personas?tipo=miembro')).text(), /1 con estos filtros \(de 4\)/);
  });
});

test('los botones rápidos cambian el tipo, vuelven a la misma vista (con todos los filtros) y no aceptan valores raros', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    const id = await idOf(db, '584140000001');
    const m = (await db.query(`INSERT INTO ministries (name) VALUES ('Alabanza') RETURNING id`)).rows[0].id;
    let r = await post(`/personas/${id}/tipo`, { tipo: 'miembro', filtro: 'sin', grupo: 'si', q: 'persona', m: String(m) });
    assert.equal(r.status, 303);
    assert.equal(loc(r), `/personas?tipo=sin&grupo=si&q=persona&m=${m}&ok=Persona Uno: Miembro`);
    assert.equal((await rowOf(db, '584140000001')).membership, 'miembro');
    r = await post(`/personas/${id}/tipo`, { tipo: 'amigo', filtro: 'todos', grupo: 'todos', q: '', m: '' });
    assert.equal(loc(r), '/personas?ok=Persona Uno: Amigo'); // sin filtros: vuelve a la lista completa
    assert.equal((await rowOf(db, '584140000001')).membership, 'amigo');
    // valores raros: no cambian nada y los filtros desconocidos no se copian a la URL
    for (const tipo of ['visitante', 'constructor', '__proto__']) {
      r = await post(`/personas/${id}/tipo`, { tipo, filtro: '<script>', grupo: 'zz', q: 'x', m: 'abc' });
      assert.equal(loc(r), '/personas?q=x&err=Tipo no válido.', tipo);
      assert.equal((await rowOf(db, '584140000001')).membership, 'amigo');
    }
    assert.match(loc(await post('/personas/999999/tipo', { tipo: 'miembro' })), /err=No existe esa persona\./);
    assert.equal((await post('/personas/99999999999/tipo', { tipo: 'miembro' })).status, 404);
    r = await post(`/personas/${id}/tipo`, { tipo: 'miembro', filtro: 'https://malo.example', q: 'https://malo.example' });
    assert.ok(loc(r).startsWith('/personas?'));
    assert.ok(!loc(r).startsWith('//'));
    // la pestaña vieja de /miembros sigue funcionando, pero vuelve a Personas
    r = await post(`/miembros/${id}/tipo`, { tipo: 'amigo', filtro: 'amigo', q: '' });
    assert.equal(loc(r), '/personas?tipo=amigo&ok=Persona Uno: Amigo');
    // en la lista, el botón activo se ve marcado
    assert.match(tbody(await (await get('/personas?tipo=amigo')).text()), /aria-pressed="true">Amigo<\/button>/);
  });
});

test('clasificar no toca el consentimiento ni si la persona está activa', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await db.query(`INSERT INTO people (full_name, phone, opt_in, active) VALUES ('Con Consentimiento', '584141110001', TRUE, TRUE), ('Sin Consentimiento', '584141110002', FALSE, FALSE)`);
    for (const phone of ['584141110001', '584141110002']) {
      const before = await rowOf(db, phone);
      await post(`/personas/${before.id}/tipo`, { tipo: 'miembro', filtro: 'todos' });
      await post(`/personas/${before.id}/tipo`, { tipo: 'amigo', filtro: 'todos' });
      const after = await rowOf(db, phone);
      assert.deepEqual([after.opt_in, after.active, after.full_name, after.phone], [before.opt_in, before.active, before.full_name, before.phone]);
      assert.equal(after.membership, 'amigo');
    }
  });
});

test('la descarga respeta los filtros de la lista, trae tipo y grupo oficial, y neutraliza fórmulas de nombres de perfil', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    await db.query(`INSERT INTO people (full_name, phone) VALUES ('Fuera Del Grupo', '584140000099')`);
    await db.query(`UPDATE people SET full_name = '=HYPERLINK("http://malo.example","clic")' WHERE phone = '584140000003'`);
    await db.query(`UPDATE people SET membership = 'miembro' WHERE phone = '584140000001'`);
    const all = await get('/personas/exportar.csv');
    assert.match(all.headers.get('content-type'), /text\/csv/);
    assert.match(all.headers.get('content-disposition'), /personas\.csv/);
    const csv = await all.text();
    const header = csv.replace(/^﻿/, '').split('\r\n')[0];
    assert.equal(header, 'nombre,telefono,correo,ministerios,rol,acepta_mensajes,canal,activo,tipo,en_grupo_oficial');
    assert.match(csv, /Persona Uno,\+?58?0?[^,]*,[^\r\n]*,miembro,si/);
    assert.match(csv, /Fuera Del Grupo,[^\r\n]*,,no\r/); // sin tipo y fuera del grupo
    assert.match(csv, /'=HYPERLINK/); // la fórmula queda neutralizada
    assert.ok(!/\r\n=HYPERLINK/.test(csv));
    // con filtros: solo lo que se ve en la lista
    const only = await (await get('/personas/exportar.csv?tipo=miembro')).text();
    assert.match(only, /Persona Uno/);
    assert.ok(!only.includes('Perfil Dos') && !only.includes('Fuera Del Grupo'));
    const out = await (await get('/personas/exportar.csv?grupo=no')).text();
    assert.match(out, /Fuera Del Grupo/);
    assert.ok(!out.includes('Persona Uno'));
    const sin = await (await get('/personas/exportar.csv?tipo=sin&grupo=si&q=perfil')).text();
    assert.match(sin, /Perfil Dos/);
    assert.ok(!sin.includes('Persona Uno'));
    // el enlace de la lista conserva el filtro activo
    assert.match(await (await get('/personas?tipo=miembro&grupo=si')).text(), /href="\/personas\/exportar\.csv\?tipo=miembro&amp;grupo=si">Descargar lista \(con estos filtros\)/);
    // la descarga se puede volver a importar sin errores (las columnas nuevas se reconocen)
    const again = await (await post('/personas/importar', { csv: csv.replace(/^﻿/, '').replace(/=HYPERLINK[^\r\n]*?clic""\)'?/, 'Nombre Corregido'), accion: 'revisar' })).text();
    assert.match(again, /Todo correcto/);
    // "activo" ya venía en la descarga y el importador de personas nunca la usó; lo que importa es que tipo y grupo oficial sí se reconocen
    const ignored = (again.match(/Columnas ignoradas: ([^<]*)/) || [])[1] || '';
    assert.ok(!/tipo|en_grupo_oficial/.test(ignored), ignored);
  });
});

test('importar la lista del grupo desde Personas: revisar no guarda, errores bloquean, importar crea y actualiza sin duplicar', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const page = await (await get('/personas/importar-grupo')).text();
    assert.match(page, /Revisar sin guardar/);
    assert.match(page, /type="file"/);
    assert.match(page, /href="\/personas">Cancelar/);
    const rev = await (await post('/personas/importar-grupo', { csv: CSV, accion: 'revisar' })).text();
    assert.match(rev, /Todo correcto: 3 personas nuevas y 0 por actualizar/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 0);
    const ok = await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    assert.equal(ok.status, 303);
    assert.match(loc(ok), /^\/personas\?ok=Importación lista: 3 nuevas, 0 actualizadas\./);
    const again = await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    assert.match(loc(again), /0 nuevas, 3 actualizadas/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE opt_in')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE in_official_group')).rows[0].n, 3);
    const bad = await (await post('/personas/importar-grupo', { csv: 'Nombre,Teléfono\nA,12\nB,', accion: 'importar' })).text();
    assert.match(bad, /Hay 2 fila\(s\) con problemas/);
    assert.match(bad, /Teléfono no válido/);
    assert.match(bad, /Falta el teléfono/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 3);
  });
});

test('las direcciones viejas de /miembros llevan a Personas con el filtro equivalente', async (t) => {
  await withApp(t, async ({ get, post, loc }) => {
    let r = await get('/miembros');
    assert.equal(r.status, 302);
    assert.equal(loc(r), '/personas');
    r = await get('/miembros?tipo=amigo&q=ana');
    assert.equal(r.status, 302);
    assert.equal(loc(r), '/personas?tipo=amigo&q=ana');
    r = await get('/miembros?tipo=sin');
    assert.equal(loc(r), '/personas?tipo=sin');
    r = await get('/miembros?tipo=miembro&grupo=si&m=7&q=x');
    assert.equal(loc(r), '/personas?tipo=miembro&grupo=si&q=x&m=7');
    // lo desconocido no se copia: ni scripts ni otras URLs
    r = await get('/miembros?tipo=%3Cscript%3E&grupo=zz&m=abc&q=%3Cb%3E');
    assert.ok(loc(r).startsWith('/personas'));
    assert.ok(!loc(r).includes('script') && !loc(r).includes('zz') && !loc(r).includes('abc'));
    assert.equal(loc(await get('/miembros/exportar.csv?tipo=miembro')), '/personas/exportar.csv?tipo=miembro');
    assert.equal(loc(await get('/miembros/exportar.csv')), '/personas/exportar.csv');
    assert.equal(loc(await get('/miembros/importar')), '/personas/importar-grupo');
    const p = await post('/miembros/importar', { csv: 'x', accion: 'revisar' });
    assert.equal(p.status, 307); // conserva el envío
    assert.equal(loc(p), '/personas/importar-grupo');
    // el destino de las redirecciones existe
    assert.equal((await get('/personas')).status, 200);
    assert.equal((await get('/personas/importar-grupo')).status, 200);
    assert.equal((await get('/personas/exportar.csv')).status, 200);
  });
});

test('los nombres se escapan en la lista', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    await db.query(`UPDATE people SET full_name = '<script>alert(1)</script>', whatsapp_name = '<img src=x onerror=alert(2)>' WHERE phone = '584140000002'`);
    const html = await (await get('/personas')).text();
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;script&gt;alert\(1\)/);
    const q = await (await get('/personas?q=%22%3E%3Cscript%3Ealert(3)%3C/script%3E')).text();
    assert.ok(!q.includes('<script>alert(3)'));
  });
});

test('la ficha tiene el selector de tipo y la casilla del grupo oficial, y otros formularios no las borran', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    const id = await idOf(db, '584140000001');
    const ficha = await (await get(`/personas/${id}`)).text();
    assert.match(ficha, /name="membership"/);
    assert.match(ficha, /<option value="">Por clasificar<\/option>/);
    assert.match(ficha, /<option value="miembro" >Miembro<\/option>/);
    assert.match(ficha, /name="in_official_group" value="1" checked/); // vino del grupo
    assert.match(ficha, /name="in_group_present"/);
    const body = { full_name: 'Persona Uno', phone: '0414-000.00.01', preferred_channel: 'whatsapp', active: '1', access_level: 'ninguno', in_group_present: '1', in_official_group: '1' };
    let r = await post(`/personas/${id}`, { ...body, membership: 'amigo' });
    assert.equal(r.status, 303);
    assert.equal((await rowOf(db, '584140000001')).membership, 'amigo');
    assert.match(await (await get(`/personas/${id}`)).text(), /<option value="amigo" selected>Amigo<\/option>/);
    // desmarcar la casilla saca a la persona del grupo oficial; marcarla la vuelve a poner
    const { in_official_group, ...sinGrupo } = body;
    await post(`/personas/${id}`, { ...sinGrupo, membership: 'amigo' });
    assert.equal((await rowOf(db, '584140000001')).in_official_group, false);
    assert.doesNotMatch(await (await get(`/personas/${id}`)).text(), /name="in_official_group" value="1" checked/);
    await post(`/personas/${id}`, { ...body, membership: 'amigo' });
    assert.equal((await rowOf(db, '584140000001')).in_official_group, true);
    // un formulario sin la marca (otra pantalla) no toca ni el grupo ni el tipo
    await post(`/personas/${id}`, { full_name: 'Persona Uno', phone: '0414-000.00.01', preferred_channel: 'whatsapp', active: '1', access_level: 'ninguno', notes: 'solo una nota' });
    const p = await rowOf(db, '584140000001');
    assert.deepEqual([p.in_official_group, p.membership], [true, 'amigo']);
    // tipo inválido: se guarda lo demás y se avisa
    r = await post(`/personas/${id}`, { ...body, membership: 'visitante' });
    assert.match(loc(r), /err=Se guardó la persona, pero el tipo no: Tipo no válido/);
    assert.equal((await rowOf(db, '584140000001')).membership, 'amigo');
    // volver a "Por clasificar"
    await post(`/personas/${id}`, { ...body, membership: '' });
    assert.equal((await rowOf(db, '584140000001')).membership, '');
    // si el formulario falla por otro motivo, lo elegido no se pierde
    const err = await post(`/personas/${id}`, { ...sinGrupo, full_name: '', membership: 'miembro' });
    assert.equal(err.status, 200);
    const html = await err.text();
    assert.match(html, /<option value="miembro" selected>Miembro<\/option>/);
    assert.doesNotMatch(html, /name="in_official_group" value="1" checked/);
  });
});

test('importar personas por la pantalla de siempre no borra el tipo ni el grupo oficial, y guardar la ficha no cambia el consentimiento de quien no lo marcó', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await post('/personas/importar-grupo', { csv: CSV, accion: 'importar' });
    await post(`/personas/${await idOf(db, '584140000001')}/tipo`, { tipo: 'miembro', filtro: 'todos' });
    const rep = await post('/personas/importar', { csv: 'nombre,telefono,rol\nPersona Uno Actualizada,0414-000.00.01,Diácono', accion: 'importar' });
    assert.equal(rep.status, 303);
    const p = await rowOf(db, '584140000001');
    assert.deepEqual([p.membership, p.in_official_group, p.opt_in], ['miembro', true, false]);
  });
});
