'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fmt = require('../src/care-formats');
const { careRemoteRouter } = require('../src/routes/care-remote');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

test('trimestres: límites, etiqueta y validación', () => {
  assert.equal(fmt.quarterOf('2026-02-15'), '2026-Q1');
  assert.equal(fmt.quarterOf('2026-12-31'), '2026-Q4');
  assert.deepEqual(fmt.quarterBounds('2026-Q4'), { start: '2026-10-01', end: '2027-01-01' });
  assert.deepEqual(fmt.quarterBounds('2026-Q2'), { start: '2026-04-01', end: '2026-07-01' });
  assert.ok(fmt.validQuarter('2026-Q3') && !fmt.validQuarter('2026-Q5') && !fmt.validQuarter("2026-Q1'; --"));
  assert.ok(fmt.validMonth('2026-12') && !fmt.validMonth('2026-13') && !fmt.validMonth('2026-1'));
});

test('parsePeople: junta repetidos, ignora hitos inventados y deja los hitos en el orden del libro', () => {
  const list = fmt.parsePeople({
    n_0: ' Ana  Uno ', m_0: ['B', 'NV', 'XX'], o_0: 'Servidora',
    n_1: 'ana uno', m_1: 'CC',
    n_2: '', m_2: 'B',
    n_3: 'Luis Dos',
  });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].milestones, ['NV', 'B', 'CC']);
  assert.equal(list[0].name, 'Ana Uno');
  assert.equal(list[0].other, 'Servidora');
  assert.deepEqual(list[1].milestones, []);
});

test('parsePlan y parseFoda: validan y limpian', () => {
  assert.ok(fmt.parsePlan({ month: '2026-10' }).errors.some((e) => /al menos una semana/.test(e)));
  assert.ok(fmt.parsePlan({ month: 'octubre', snack_1: 'pan' }).errors.some((e) => /mes/.test(e)));
  const p = fmt.parsePlan({ month: '2026-10', stage: 'Inventada', snack_1: ' Café ', key_element_3: 'Gracia' });
  assert.deepEqual(p.errors, []);
  assert.equal(p.value.stage, '');
  assert.equal(p.value.weeks[0].snack, 'Café');
  assert.equal(p.value.weeks[2].key_element, 'Gracia');
  assert.equal(p.value.weeks.length, 4);
  assert.ok(fmt.parseFoda({ quarter: '2026-Q4' }).errors.length);
  assert.deepEqual(fmt.parseFoda({ quarter: '2026-Q4', strengths: 'Unidad' }).errors, []);
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(careRemoteRouter({ db: h.db, config }));
  app.use(careGroupsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  // los valores repetidos (varias casillas con el mismo nombre) se pasan como lista de pares
  const post = (p, fields = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields)), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}

const mkGroup = async (db, name = 'GdC Prueba', token = 'tokenprueba1234567890') =>
  (await db.query('INSERT INTO care_groups (name, leader_name, token) VALUES ($1, $2, $3) RETURNING *', [name, 'Líder Uno', token])).rows[0];

test('trimestral: 13 semanas desde el inicio del trimestre, totales y promedios solo con semanas reportadas', async (t) => {
  await withApp(t, async ({ db }) => {
    const g = await mkGroup(db);
    const ins = (d, att, guests, off) => db.query('INSERT INTO care_group_reports (group_id, meeting_date, attendance, guests_count, offering) VALUES ($1,$2,$3,$4,$5)', [g.id, d, att, guests, off]);
    await ins('2026-10-01', 10, 2, 5); // semana 1
    await ins('2026-10-08', 14, 4, 7.5); // semana 2
    await ins('2026-12-31', 20, 6, 0); // día 92: va a la semana 13
    await ins('2026-09-30', 99, 99, 99); // trimestre anterior: no cuenta
    await ins('2027-01-01', 99, 99, 99); // trimestre siguiente: no cuenta
    const q = await fmt.quarterly(db, g.id, '2026-Q4');
    assert.equal(q.weeks.length, 13);
    assert.equal(q.reports, 3);
    assert.equal(q.weeks[0].attendance, 10);
    assert.equal(q.weeks[1].offering, 7.5);
    assert.equal(q.weeks[12].attendance, 20);
    assert.equal(q.weeks[5].attendance, null);
    assert.equal(q.offeringTotal, 12.5);
    assert.equal(q.attendanceAvg, 14.7);
    assert.equal(q.guestsAvg, 4);
  });
});

test('el líder llena planificador, ruta de crecimiento y F.O.D.A. desde su enlace y se ve en el panel', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db);
    const T = `/g/${g.token}`;
    for (const p of ['', '/planificador', '/gente', '/foda', '/trimestral']) {
      const r = await get(T + p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }

    const month = today().slice(0, 7);
    const plan = await post(`${T}/planificador`, { month, stage: 'Conquista', snack_1: 'Galletas', dynamics_1: 'Rompehielo', key_element_2: 'Perdón <b>total</b>', support_4: 'Video' });
    assert.equal(plan.status, 200);
    assert.match(await plan.text(), /Plan del mes guardado/);
    await post(`${T}/planificador`, { month, stage: 'Equipo', snack_1: 'Pan' }); // reenviar corrige
    const plans = (await db.query('SELECT * FROM care_group_plans')).rows;
    assert.equal(plans.length, 1);
    assert.equal(plans[0].stage, 'Equipo');
    assert.equal(plans[0].weeks[0].snack, 'Pan');

    const quarter = fmt.quarterOf(today());
    await post(`${T}/foda`, { quarter, strengths: 'Unidad', threats: '<script>x</script>' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_foda')).rows[0].n, 1);

    const ppl = await post(`${T}/gente`, [['n_0', 'Ana Uno'], ['m_0', 'NV'], ['m_0', 'B'], ['o_0', 'Servidora'], ['n_1', 'Luis Dos'], ['m_1', 'NV']]);
    assert.match(await ppl.text(), /2 personas/);
    const rows = (await db.query('SELECT * FROM care_group_people ORDER BY sort')).rows;
    assert.deepEqual(rows[0].milestones, ['NV', 'B']);
    assert.equal(rows[1].name, 'Luis Dos');

    const gente = await (await get(`${T}/gente`)).text();
    assert.match(gente, /value="Ana Uno"/);
    assert.match(gente, /value="NV" checked/);

    const detail = await (await get(`/grupos/${g.id}`)).text();
    assert.match(detail, /Ruta de crecimiento/);
    assert.match(detail, /Ana Uno/);
    assert.match(detail, /Pan/);
    assert.match(detail, /Unidad/);
    assert.ok(!detail.includes('<script>x</script>'));
    assert.match(detail, /&lt;script&gt;/);

    const list = await (await get('/grupos')).text();
    assert.match(list, /personas por hito/);
    assert.match(await (await get(`/grupos/${g.id}/trimestral`)).text(), /Reporte trimestral/);
    assert.equal((await get(`/grupos/${g.id}/trimestral?q=basura`)).status, 200);
  });
});

test('ruta de crecimiento: una lista vacía no borra a nadie; trampa, enlaces caídos y datos malos', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db);
    const T = `/g/${g.token}`;
    await post(`${T}/gente`, { n_0: 'Ana Uno', m_0: 'NV' });
    const empty = await post(`${T}/gente`, { n_0: '' });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /no se guardó/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_people')).rows[0].n, 1);

    const bot = await post(`${T}/gente`, { n_0: 'Spam', web: 'x' });
    assert.equal(bot.status, 200);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM care_group_people WHERE name = 'Spam'")).rows[0].n, 0);

    assert.equal((await post(`${T}/planificador`, { month: 'x', snack_1: 'a' })).status, 400);
    assert.equal((await post(`${T}/foda`, { quarter: '2026-Q9', strengths: 'a' })).status, 400);

    await post(`/grupos/${g.id}/enlace/desactivar`);
    for (const p of ['/planificador', '/gente', '/foda', '/trimestral']) assert.equal((await get(T + p)).status, 404, p);
    assert.equal((await post(`${T}/gente`, { n_0: 'Otro' })).status, 404);
  });
});

test('borrar un grupo borra su ruta, plan y F.O.D.A. (cascada)', async (t) => {
  await withApp(t, async ({ db }) => {
    const g = await mkGroup(db);
    await db.query("INSERT INTO care_group_people (group_id, name) VALUES ($1,'A')", [g.id]);
    await db.query("INSERT INTO care_group_plans (group_id, month) VALUES ($1,'2026-10')", [g.id]);
    await db.query("INSERT INTO care_group_foda (group_id, quarter) VALUES ($1,'2026-Q4')", [g.id]);
    await db.query('DELETE FROM care_groups WHERE id = $1', [g.id]);
    for (const tb of ['care_group_people', 'care_group_plans', 'care_group_foda']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${tb}`)).rows[0].n, 0, tb);
    }
  });
});
