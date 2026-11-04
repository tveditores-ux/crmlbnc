'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cg = require('../src/care-groups');
const fmt = require('../src/care-formats');
const { careRemoteRouter } = require('../src/routes/care-remote');
const { careGroupsRouter } = require('../src/routes/care-groups');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', publicUrl: 'http://prueba.local', dryRun: true };
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });
const base = { meeting_date: TODAY, members_count: '6', guests_count: '2' };

test('campos nuevos del reporte: todos opcionales; un reporte como los de antes sigue siendo válido', () => {
  const old = cg.parseReport(base, TODAY);
  assert.deepEqual(old.errors, []);
  assert.deepEqual([old.value.start_time, old.value.end_time, old.value.stage, old.value.stage_week, old.value.recent_guests, old.value.offering_fx, old.value.payment_ref, old.value.leader_wed, old.value.leader_sun], ['', '', '', null, null, null, '', null, null]);

  const full = cg.parseReport({ ...base, start_time: '19:00', end_time: '20:30', stage: 'Conquista', stage_week: '4', recent_guests: '3', offering: '1200,50', offering_fx: '15.25', payment_ref: '0042', leader_wed: 'si', leader_sun: 'no' }, TODAY);
  assert.deepEqual(full.errors, []);
  const v = full.value;
  assert.deepEqual([v.start_time, v.end_time, v.stage, v.stage_week, v.recent_guests, v.offering, v.offering_fx, v.payment_ref, v.leader_wed, v.leader_sun], ['19:00', '20:30', 'Conquista', 4, 3, 1200.5, 15.25, '0042', true, false]);
});

test('validación de los campos nuevos: horas, semana, referencia de 4 dígitos, montos y etapas desconocidas', () => {
  const e = (extra) => cg.parseReport({ ...base, ...extra }, TODAY).errors;
  assert.ok(e({ start_time: '7pm' }).some((m) => /como 19:00/.test(m)));
  assert.ok(e({ start_time: '25:00' }).some((m) => /como 19:00/.test(m)));
  assert.ok(e({ start_time: '19:00', end_time: '18:00' }).some((m) => /después de la de entrada/.test(m)));
  assert.ok(e({ start_time: '19:00', end_time: '19:00' }).some((m) => /después de la de entrada/.test(m)));
  assert.deepEqual(e({ start_time: '19:00' }), []); // solo la entrada también vale
  assert.ok(e({ stage_week: '0' }).some((m) => /del 1 al 52/.test(m)));
  assert.ok(e({ stage_week: '53' }).some((m) => /del 1 al 52/.test(m)));
  assert.ok(e({ stage_week: 'tres' }).some((m) => /del 1 al 52/.test(m)));
  assert.ok(e({ recent_guests: '-1' }).some((m) => /números enteros/.test(m)));
  assert.ok(e({ offering_fx: 'mucho' }).some((m) => /en divisas/.test(m)));
  assert.ok(e({ offering: '12,345' }).some((m) => /en bolívares/.test(m)));
  // la referencia del pago: nunca más de 4 números (ni la cuenta ni el teléfono completos)
  for (const bad of ['123456', '04141234567', '12ab', '1 2']) {
    const r = cg.parseReport({ ...base, payment_ref: bad }, TODAY);
    assert.ok(r.errors.some((m) => /4 últimos números/.test(m)), bad);
    assert.equal(r.value.payment_ref, '', bad); // y no se guarda lo que escribió
  }
  assert.equal(cg.parseReport({ ...base, payment_ref: '' }, TODAY).value.payment_ref, '');
  // lo desconocido no se guarda tal cual
  assert.equal(cg.parseReport({ ...base, stage: 'Inventada' }, TODAY).value.stage, '');
  assert.equal(cg.parseReport({ ...base, leader_wed: 'quizás', leader_sun: '' }, TODAY).value.leader_wed, null);
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(careRemoteRouter({ db: h.db, config }));
  app.use(careGroupsRouter({ db: h.db, config }));
  const server = app.listen(0);
  const b = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(b + p, { redirect: 'manual' });
  const post = (p, fields = {}) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await fn({ db: h.db, get, post });
  } finally {
    server.close();
    await h.close();
  }
}
const mkGroup = async (db, token = 'tokenreporte1234567890') =>
  (await db.query("INSERT INTO care_groups (name, leader_name, token) VALUES ('Grupo Reporte', 'Líder Uno', $1) RETURNING *", [token])).rows[0];

test('el líder envía el reporte ampliado desde su teléfono: el formulario lo pide, se guarda y reenviar la misma fecha lo corrige', async (t) => {
  await withApp(t, async ({ db, get, post }) => {
    const g = await mkGroup(db);
    const form = await (await get(`/g/${g.token}`)).text();
    for (const id of ['start_time', 'end_time', 'stage', 'stage_week', 'recent_guests', 'offering', 'offering_fx', 'payment_ref', 'leader_wed', 'leader_sun']) assert.match(form, new RegExp(`id="${id}"`), id);
    assert.match(form, /<h2>Ofrendas<\/h2>/);
    assert.match(form, /maxlength="4"/); // la referencia solo admite 4 caracteres
    for (const s of cg.STAGES) assert.ok(form.includes(`<option >${s}</option>`) || form.includes(`<option>${s}</option>`), s);

    const r = await post(`/g/${g.token}`, { ...base, attendance: '8', start_time: '19:05', end_time: '20:40', stage: 'Equipo', stage_week: '2', recent_guests: '3', offering: '500', offering_fx: '10', payment_ref: '1234', leader_wed: 'si', leader_sun: 'no' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Reporte recibido/);
    let row = (await db.query('SELECT * FROM care_group_reports')).rows[0];
    assert.deepEqual([row.start_time, row.end_time, row.stage, row.stage_week, row.recent_guests, Number(row.offering), Number(row.offering_fx), row.payment_ref, row.leader_wed, row.leader_sun], ['19:05', '20:40', 'Equipo', 2, 3, 500, 10, '1234', true, false]);

    // reenviar la misma fecha corrige (no duplica) y también los campos nuevos
    const again = await post(`/g/${g.token}`, { ...base, attendance: '9', start_time: '19:00', end_time: '20:30', stage: 'Conquista', stage_week: '3', offering_fx: '12', leader_wed: 'no', leader_sun: 'si' });
    assert.match(await again.text(), /Reporte corregido/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 1);
    row = (await db.query('SELECT * FROM care_group_reports')).rows[0];
    assert.deepEqual([row.start_time, row.stage, row.stage_week, Number(row.offering_fx), row.leader_wed, row.leader_sun], ['19:00', 'Conquista', 3, 12, false, true]);
    assert.equal(row.payment_ref, ''); // lo que ya no se mandó se vacía, como el resto del reporte

    // datos malos: 400, no se guarda nada y el formulario conserva lo escrito
    const bad = await post(`/g/${g.token}`, { ...base, meeting_date: day(-1), start_time: '21:00', end_time: '20:00', payment_ref: '99999', stage: 'Conquista', offering_fx: '7' });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.match(html, /después de la de entrada/);
    assert.match(html, /4 últimos números/);
    assert.match(html, /value="21:00"/);
    assert.match(html, /<option selected>Conquista<\/option>/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM care_group_reports')).rows[0].n, 1);
  });
});

test('los reportes que ya existían (sin los campos nuevos) siguen funcionando y se muestran sin errores', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db);
    // una fila como las de antes de esta versión: solo las columnas viejas
    await db.query("INSERT INTO care_group_reports (group_id, meeting_date, members_count, guests_count, attendance, offering, notes) VALUES ($1, $2, 5, 1, 6, 100, 'Reporte antiguo')", [g.id, day(-3)]);
    const r = (await db.query('SELECT * FROM care_group_reports')).rows[0];
    assert.deepEqual([r.start_time, r.stage, r.stage_week, r.recent_guests, r.offering_fx, r.payment_ref, r.leader_wed, r.leader_sun], ['', '', null, null, null, '', null, null]);
    const ficha = await (await get(`/grupos/${g.id}`)).text();
    assert.match(ficha, /Reporte antiguo/);
    assert.match(ficha, /100,00[^<]*<span class="muted">Bs\.<\/span>/);
    assert.ok(!ficha.includes('Líder en servicios')); // sin datos no se inventa nada
    assert.ok(!ficha.includes('dijo que asistió a los servicios'));
    assert.equal((await get('/grupos/reportes.csv')).status, 200);
  });
});

test('el panel muestra lo nuevo en cada reporte, cuenta la asistencia del líder a los servicios y la descarga lo trae', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db);
    const ins = (d, wed, sun, extra = {}) =>
      db.query(
        `INSERT INTO care_group_reports (group_id, meeting_date, attendance, start_time, end_time, stage, stage_week, recent_guests, offering, offering_fx, payment_ref, leader_wed, leader_sun, notes)
         VALUES ($1,$2,7,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [g.id, d, extra.s ?? '19:00', extra.e ?? '20:30', 'Conquista', 4, 2, 250, 20, '0099', wed, sun, extra.notes ?? '=cmd()']
      );
    await ins(day(-21), true, true);
    await ins(day(-14), true, false);
    await ins(day(-7), false, null); // el domingo no lo contestó
    const ficha = await (await get(`/grupos/${g.id}`)).text();
    assert.match(ficha, /Horario:<\/span> 19:00 a 20:30/);
    assert.match(ficha, /Etapa:<\/span> Conquista, semana 4/);
    assert.match(ficha, /Invitados recientes:<\/span> 2/);
    assert.match(ficha, /Líder en servicios:<\/span> miércoles sí · domingo no/);
    assert.match(ficha, /20,00 <span class="muted">divisas<\/span>/);
    assert.match(ficha, /ref\. 0099/);
    assert.match(ficha, /miércoles 2 de 3 · domingo 1 de 2<\/strong> reportes/); // 2 de 3 miércoles; 1 de los 2 domingos contestados

    const csv = await (await get('/grupos/reportes.csv')).text();
    const [head, ...lines] = csv.replace('﻿', '').trim().split(/\r?\n/);
    for (const col of ['Hora de entrada', 'Hora de salida', 'Etapa', 'Semana de la etapa', 'Invitados de las últimas 3 semanas', 'Ofrenda (divisas)', 'Referencia del pago (4 últimos)', 'Líder asistió miércoles', 'Líder asistió domingo']) assert.ok(head.includes(col), col);
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => /19:00,20:30,Conquista,4,2,20(\.00)?,0099,sí,sí/.test(l)));
    assert.ok(lines.some((l) => l.endsWith('sí,no')) && lines.some((l) => l.endsWith('no,')));
    assert.ok(csv.includes("'=cmd()")); // sigue neutralizando fórmulas
  });
});

test('reporte trimestral: las ofrendas en divisas se suman por semana, aparte de las de bolívares', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const g = await mkGroup(db);
    await db.query("INSERT INTO care_group_reports (group_id, meeting_date, attendance, offering, offering_fx) VALUES ($1, '2026-10-01', 5, 100, 10), ($1, '2026-10-08', 6, 50.5, NULL), ($1, '2026-10-15', 7, NULL, 5.25)", [g.id]);
    const q = await fmt.quarterly(db, g.id, '2026-Q4');
    assert.equal(q.offeringTotal, 150.5);
    assert.equal(q.offeringFxTotal, 15.25);
    assert.deepEqual([q.weeks[0].fx, q.weeks[1].fx, q.weeks[2].fx, q.weeks[3].fx], [10, null, 5.25, null]);
    const page = await (await get(`/grupos/${g.id}/trimestral?q=2026-Q4`)).text();
    assert.match(page, /Ofrendas en bolívares/);
    assert.match(page, /Ofrendas en divisas/);
  });
});
