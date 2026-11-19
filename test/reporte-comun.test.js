'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { reporteComunRouter } = require('../src/routes/reporte-comun');
const { careGroupsRouter } = require('../src/routes/care-groups');
const crl = require('../src/care-report-link');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: true, publicUrl: 'http://prueba.local' };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(reporteComunRouter({ db: h.db, config }));
  app.use(careGroupsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}

const newGroup = async (post, db, extra = {}) => {
  const r = await post('/grupos', { name: 'GdC Prueba', leader_name: 'Líder Uno', ...extra });
  assert.equal(r.status, 303);
  return (await db.query('SELECT * FROM care_groups ORDER BY id DESC LIMIT 1')).rows[0];
};

test('parseLeaderName: pide nombre y apellido', () => {
  assert.ok(crl.parseLeaderName('').error);
  assert.ok(crl.parseLeaderName('María').error);
  assert.equal(crl.parseLeaderName('  María   Pérez ').value, 'María Pérez');
});

test('el remoto es aparte: sin pestañas, solo nombre y reporte; el enlace es el mismo para todos', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const link = await crl.ensureLink(db);
    const html = await (await get(`/reportes/${link.token}`)).text();
    assert.match(html, /Reporte semanal/);
    assert.match(html, /Tu nombre y apellido/);
    assert.ok(!html.includes('class="tabs"'), 'sin barra de pestañas');
    for (const x of ['REDIL', 'Datos del grupo', 'Planificador', 'Ruta de crecimiento', 'F.O.D.A.']) assert.ok(!html.includes(x), x);
    assert.equal((await get('/reportes/token-inventado-largo')).status, 404);
    await crl.setLinkActive(db, false);
    assert.equal((await get(`/reportes/${link.token}`)).status, 404, 'apagado no abre');
  });
});

test('nombre reconocido (sin tildes): el reporte entra directo a su grupo y reenviar corrige', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await newGroup(post, db, { leader_name: 'María Pérez' });
    const link = await crl.ensureLink(db);
    const sent = await post(`/reportes/${link.token}`, { leader_name: 'maria perez', meeting_date: TODAY, members_count: '7', guests_count: '2' });
    assert.equal(sent.status, 200);
    assert.match(await sent.text(), /Reporte recibido/);
    let rows = (await db.query('SELECT * FROM care_group_reports WHERE group_id = $1', [g.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attendance, 9);
    assert.equal(rows[0].source, 'enlace_comun');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_report_submissions')).rows[0].n, 0, 'nada queda pendiente');

    const again = await post(`/reportes/${link.token}`, { leader_name: 'María Pérez', meeting_date: TODAY, members_count: '8', guests_count: '2' });
    assert.match(await again.text(), /Reporte corregido/);
    rows = (await db.query('SELECT * FROM care_group_reports WHERE group_id = $1', [g.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attendance, 10);
  });
});

test('nombre no reconocido: queda pendiente y el panel lo asigna a su grupo', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g1 = await newGroup(post, db, { name: 'GdC Uno', leader_name: 'Ana Díaz' });
    const link = await crl.ensureLink(db);

    const unknown = await post(`/reportes/${link.token}`, { leader_name: 'Persona Desconocida', meeting_date: TODAY, attendance: '5' });
    assert.equal(unknown.status, 200);
    assert.match(await unknown.text(), /Administración lo asigna/);
    assert.equal(await crl.countPending(db), 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 0, 'no entró solo');

    const pageHtml = await (await get('/grupos/reporte-comun')).text();
    assert.match(pageHtml, /Reporte semanal: enlace común/);
    assert.match(pageHtml, new RegExp(`/reportes/${link.token}`));
    assert.match(pageHtml, /Reportes por asignar \(1\)/);

    const [target] = await crl.listPending(db);
    const applied = await post(`/grupos/reporte-comun/pendientes/${target.id}/aplicar`, { group_id: String(g1.id) });
    assert.equal(applied.status, 303);
    const rows = (await db.query('SELECT * FROM care_group_reports WHERE group_id = $1', [g1.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attendance, 5);
    assert.equal(await crl.countPending(db), 0);

    await post(`/reportes/${link.token}`, { leader_name: 'Otra Desconocida', meeting_date: TODAY, attendance: '3' });
    const [other] = await crl.listPending(db);
    await post(`/grupos/reporte-comun/pendientes/${other.id}/descartar`, {});
    assert.equal(await crl.countPending(db), 0);
  });
});

test('líder con más de un grupo: el remoto le pide elegir cuál y el reporte entra a ese grupo', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const g1 = await newGroup(post, db, { name: 'GdC Uno', leader_name: 'Ana Díaz' });
    const g2 = await newGroup(post, db, { name: 'GdC Dos', leader_name: 'Ana Díaz' });
    const ajeno = await newGroup(post, db, { name: 'GdC Ajeno', leader_name: 'Otra Persona' });
    const link = await crl.ensureLink(db);
    const count = async () => (await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n;

    // Sin elegir: no se guarda nada; vuelve el formulario con lo escrito y la lista de SUS grupos.
    const first = await post(`/reportes/${link.token}`, { leader_name: 'ana diaz', meeting_date: TODAY, attendance: '6', notes: 'Nota de prueba' });
    assert.equal(first.status, 400);
    const html = await first.text();
    assert.match(html, /Llevas más de un grupo/);
    assert.match(html, /name="group_id"/);
    assert.match(html, new RegExp(`value="${g1.id}"[^>]*>GdC Uno`));
    assert.match(html, new RegExp(`value="${g2.id}"[^>]*>GdC Dos`));
    assert.ok(!html.includes('GdC Ajeno'), 'no muestra grupos de otros líderes');
    assert.match(html, /Nota de prueba/, 'conserva lo escrito');
    assert.equal(await count(), 0);
    assert.equal(await crl.countPending(db), 0, 'tampoco queda pendiente');

    // Un grupo que no es suyo no vale.
    const wrong = await post(`/reportes/${link.token}`, { leader_name: 'Ana Díaz', meeting_date: TODAY, attendance: '6', group_id: String(ajeno.id) });
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /no es uno de los tuyos/);
    assert.equal(await count(), 0);

    // Eligiendo uno de los suyos: entra directo a ese grupo.
    const ok = await post(`/reportes/${link.token}`, { leader_name: 'Ana Díaz', meeting_date: TODAY, attendance: '6', group_id: String(g2.id) });
    assert.equal(ok.status, 200);
    const okHtml = await ok.text();
    assert.match(okHtml, /Reporte recibido/);
    assert.match(okHtml, /GdC Dos/);
    const rows = (await db.query('SELECT group_id, attendance, source FROM care_group_reports')).rows;
    assert.deepEqual(rows.map((r) => [r.group_id, r.attendance, r.source]), [[g2.id, 6, 'enlace_comun']]);

    // El otro grupo, la misma semana, es otro reporte (no pisa el primero).
    await post(`/reportes/${link.token}`, { leader_name: 'Ana Díaz', meeting_date: TODAY, attendance: '4', group_id: String(g1.id) });
    assert.equal(await count(), 2);
  });
});

test('el co-líder también es reconocido por su nombre', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const g = await newGroup(post, db, { name: 'Matrimonios Prueba', leader_name: 'Pedro Gómez', co_leader_name: 'Luisa Ríos de Gómez' });
    const link = await crl.ensureLink(db);
    const r = await post(`/reportes/${link.token}`, { leader_name: 'Luisa Rios de Gomez', meeting_date: TODAY, attendance: '8' });
    assert.match(await r.text(), /Reporte recibido/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports WHERE group_id = $1', [g.id])).rows[0].n, 1);
  });
});

test('errores: sin nombre completo o sin cifras no se guarda nada; robots tampoco', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await newGroup(post, db, { leader_name: 'María Pérez' });
    const link = await crl.ensureLink(db);
    const noName = await post(`/reportes/${link.token}`, { leader_name: 'María', meeting_date: TODAY, attendance: '5' });
    assert.equal(noName.status, 400);
    const noNums = await post(`/reportes/${link.token}`, { leader_name: 'María Pérez', meeting_date: TODAY });
    assert.equal(noNums.status, 400);
    const bot = await post(`/reportes/${link.token}`, { leader_name: 'María Pérez', meeting_date: TODAY, attendance: '5', web: 'spam' });
    assert.match(await bot.text(), /Gracias/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_report_submissions')).rows[0].n, 0);
  });
});
