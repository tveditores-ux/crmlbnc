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

test('nombre no reconocido o ambiguo: queda pendiente y el panel lo asigna a su grupo', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g1 = await newGroup(post, db, { name: 'GdC Uno', leader_name: 'Ana Díaz' });
    await newGroup(post, db, { name: 'GdC Dos', leader_name: 'Ana Díaz' });
    const link = await crl.ensureLink(db);

    const unknown = await post(`/reportes/${link.token}`, { leader_name: 'Persona Desconocida', meeting_date: TODAY, attendance: '5' });
    assert.match(await unknown.text(), /Administración lo asigna/);
    const amb = await post(`/reportes/${link.token}`, { leader_name: 'Ana Díaz', meeting_date: TODAY, attendance: '6' });
    assert.equal(amb.status, 200);
    assert.equal(await crl.countPending(db), 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 0, 'ninguno entró solo');

    const pageHtml = await (await get('/grupos/reporte-comun')).text();
    assert.match(pageHtml, /Reporte semanal: enlace común/);
    assert.match(pageHtml, new RegExp(`/reportes/${link.token}`));
    assert.match(pageHtml, /Reportes por asignar \(2\)/);

    const pend = await crl.listPending(db);
    const target = pend.find((s) => s.leader_name === 'Ana Díaz');
    const applied = await post(`/grupos/reporte-comun/pendientes/${target.id}/aplicar`, { group_id: String(g1.id) });
    assert.equal(applied.status, 303);
    const rows = (await db.query('SELECT * FROM care_group_reports WHERE group_id = $1', [g1.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attendance, 6);
    assert.equal(await crl.countPending(db), 1);

    const other = pend.find((s) => s.leader_name === 'Persona Desconocida');
    await post(`/grupos/reporte-comun/pendientes/${other.id}/descartar`, {});
    assert.equal(await crl.countPending(db), 0);
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
