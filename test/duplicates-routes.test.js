'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { duplicatesRouter } = require('../src/routes/duplicates');
const { adminRouter } = require('../src/routes/admin');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, sendWindowStart: 8, sendWindowEnd: 20, whatsapp: {}, email: {}, agent: {} };

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(duplicatesRouter({ db: h.db, config }));
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

const add = async (db, o) =>
  (await db.query('INSERT INTO people (full_name, phone, email, opt_in, access_level, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [o.name, o.phone ?? null, o.email ?? null, o.opt_in ?? false, o.access ?? 'ninguno', o.created ?? '2025-01-01T00:00:00Z'])).rows[0].id;
const count = async (db) => (await db.query('SELECT count(*)::int AS n FROM people')).rows[0].n;

test('la lista de duplicados agrupa por nombre normalizado, marca la más antigua y enlaza a la confirmación', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const a = await add(db, { name: 'María Pérez', phone: '584141112233', created: '2024-01-01T00:00:00Z' });
    const b = await add(db, { name: 'maria  PEREZ 🙏', phone: '584142223344', created: '2025-01-01T00:00:00Z' });
    await add(db, { name: 'Carlos Único', phone: '584143334455' });
    const r = await get('/personas/duplicados');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /1 grupo/);
    assert.match(html, /Más antigua/);
    assert.match(html, new RegExp(`href="/personas/${a}/unir/${b}"`)); // la más antigua primero: /personas/ANTIGUA/unir/NUEVA
    assert.ok(!html.includes('Carlos Único'));
    assert.match(html, /0414-111\.22\.33/);
  });
});

test('sin duplicados la lista lo dice, y el botón aparece en Personas y en la ficha', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const id = await add(db, { name: 'Persona Sola', phone: '584141112233' });
    assert.match(await (await get('/personas/duplicados')).text(), /No hay personas con el mismo nombre/);
    assert.match(await (await get('/personas')).text(), /href="\/personas\/duplicados">Unir duplicados</);
    assert.match(await (await get(`/personas/${id}`)).text(), new RegExp(`href="/personas/${id}/unir">Unir con otra persona<`));
  });
});

test('desde la ficha: sugiere los del mismo nombre y busca por nombre o por teléfono', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const a = await add(db, { name: 'Ana Torres', phone: '584141112233' });
    const b = await add(db, { name: 'ANA TÓRRES', phone: '584142223344' });
    const c = await add(db, { name: 'Luis Mora', phone: '584143334455' });
    const sug = await (await get(`/personas/${a}/unir`)).text();
    assert.match(sug, /Con el mismo nombre/);
    assert.match(sug, new RegExp(`/personas/${a}/unir/${b}`));
    assert.ok(!sug.includes(`/personas/${a}/unir/${c}`));
    const byName = await (await get(`/personas/${a}/unir?q=luis`)).text();
    assert.match(byName, new RegExp(`/personas/${a}/unir/${c}`));
    const byPhone = await (await get(`/personas/${a}/unir?q=0414-333.44.55`)).text();
    assert.match(byPhone, new RegExp(`/personas/${a}/unir/${c}`));
    assert.ok(!byPhone.split('Buscar otra ficha')[1].includes(`/personas/${a}/unir/${a}`)); // nunca se ofrece a sí misma
    assert.match(await (await get(`/personas/${a}/unir?q=zzzz`)).text(), /No encontré a nadie/);
    assert.match(await (await get(`/personas/${a}/unir?q=%25`)).text(), /No encontré a nadie/); // el comodín se escapa
    const none = await get('/personas/999999/unir');
    assert.equal(none.status, 303);
    assert.equal((await get('/personas/99999999999/unir')).status, 404);
  });
});

test('la confirmación compara las dos fichas, dice cuál se conserva y avisa de los riesgos', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const keep = await add(db, { name: 'Ana Torres', phone: '584141112233', created: '2024-01-01T00:00:00Z' });
    const other = await add(db, { name: 'Ana Torres', phone: '584142223344', opt_in: true, access: 'admin' });
    const html = await (await get(`/personas/${other}/unir/${keep}`)).text(); // se pide en el orden "malo"
    assert.match(html, new RegExp(`Se conserva la ficha más antigua: <strong>Ana Torres</strong> \\(#${keep}\\)`));
    assert.match(html, new RegExp(`Se elimina <strong>Ana Torres</strong> \\(#${other}\\)`));
    assert.match(html, /Tienen teléfonos distintos/);
    assert.match(html, /tenía acceso al panel/);
    assert.match(html, /name="heredar"/); // la eliminada sí había aceptado y la conservada no
    assert.match(html, /Unir en una sola ficha/);
    assert.match(html, /no se puede deshacer/i);
    // nombres distintos: advertencia
    const x = await add(db, { name: 'Persona Distinta', phone: '584145556666' });
    assert.match(await (await get(`/personas/${keep}/unir/${x}`)).text(), /Los nombres no coinciden/);
    // si la conservada ya aceptó, no se ofrece heredar nada
    const y = await add(db, { name: 'Ana Torres', phone: '584147778899', opt_in: true, created: '2023-01-01T00:00:00Z' });
    assert.ok(!(await (await get(`/personas/${y}/unir/${keep}`)).text()).includes('name="heredar"'));
    // ids repetidos o inexistentes
    assert.equal((await get(`/personas/${keep}/unir/${keep}`)).status, 303);
    assert.equal((await get(`/personas/${keep}/unir/999999`)).status, 303);
    assert.equal((await get(`/personas/${keep}/unir/99999999999`)).status, 404);
  });
});

test('unir por pantalla: una sola ficha, el consentimiento no se hereda por defecto y todo vuelve a la conservada', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const keep = await add(db, { name: 'Ana Torres', phone: '584141112233', created: '2024-01-01T00:00:00Z' });
    const other = await add(db, { name: 'ANA TÓRRES', email: 'ana@ejemplo.com', opt_in: true });
    const m = (await db.query(`INSERT INTO ministries (name) VALUES ('Alabanza') RETURNING id`)).rows[0].id;
    await db.query('INSERT INTO person_ministries (person_id, ministry_id) VALUES ($1,$2)', [other, m]);
    const r = await post(`/personas/${other}/unir/${keep}`); // sin marcar "heredar"
    assert.equal(r.status, 303);
    assert.match(loc(r), new RegExp(`^/personas/${keep}\\?ok=Se unieron en «Ana Torres» \\(#${keep}\\); se eliminó la ficha #${other}, 1 ministerios sumados`));
    assert.match(loc(r), /ese consentimiento no se heredó/);
    assert.equal(await count(db), 1);
    const p = (await db.query('SELECT email, opt_in FROM people WHERE id = $1', [keep])).rows[0];
    assert.deepEqual([p.email, p.opt_in], ['ana@ejemplo.com', false]);
    assert.match(await (await get(`/personas/${keep}`)).text(), /Ana Torres/);
    // con "heredar" marcado
    const k2 = await add(db, { name: 'Otra Persona', created: '2024-01-01T00:00:00Z' });
    const o2 = await add(db, { name: 'Otra Persona', opt_in: true });
    const r2 = await post(`/personas/${k2}/unir/${o2}`, { heredar: '1' });
    assert.ok(!loc(r2).includes('no se heredó'));
    assert.equal((await db.query('SELECT opt_in FROM people WHERE id = $1', [k2])).rows[0].opt_in, true);
  });
});

test('unir con una persona que ya no existe no rompe nada', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const a = await add(db, { name: 'Persona A' });
    const r = await post(`/personas/${a}/unir/999999`);
    assert.equal(r.status, 303);
    assert.match(loc(r), new RegExp(`^/personas/${a}/unir\\?err=Una de las dos personas ya no existe`));
    const same = await post(`/personas/${a}/unir/${a}`);
    assert.match(loc(same), /err=Elige dos personas distintas/);
    assert.equal(await count(db), 1);
  });
});

test('los nombres se escapan en todas las pantallas de unir', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const a = await add(db, { name: '<script>alert(1)</script>', phone: '584141112233', created: '2024-01-01T00:00:00Z' });
    const b = await add(db, { name: '<script>alert(1)</script>', email: '"><img src=x onerror=alert(2)>@ejemplo.com' });
    for (const path of ['/personas/duplicados', `/personas/${a}/unir`, `/personas/${a}/unir/${b}`, `/personas/${a}/unir?q=%3Cscript%3E`]) {
      const html = await (await get(path)).text();
      assert.ok(!html.includes('<script>alert(1)'), path);
      assert.ok(!html.includes('<img src=x'), path);
    }
  });
});
