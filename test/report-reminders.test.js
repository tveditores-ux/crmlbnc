'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const rr = require('../src/report-reminders');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const cfg = (extra = {}) =>
  loadConfig({
    DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'https://crm.ejemplo.test', ADMIN_PASSWORD: 'clave-de-prueba-123',
    SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'false', AGENT_PASTORAL_PHONES: '0412-5550001', REPORT_REMINDER: 'true', ...extra,
  });
// Martes 10 de noviembre de 2026: 8:30 (antes de la hora por defecto, 9) y 9:30 en Caracas (UTC-4)
const ANTES = new Date('2026-11-10T12:30:00Z');
const DESPUES = new Date('2026-11-10T13:30:00Z');
const MAS_TARDE = new Date('2026-11-10T20:00:00Z');

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}
const seed = async (db) => {
  await db.query(`INSERT INTO people (full_name, phone, active, opt_in) VALUES
    ('Ana Líder', '584140000001', TRUE, TRUE),
    ('Beto Líder', '584140000002', TRUE, TRUE),
    ('Cira Líder', '584140000003', TRUE, FALSE),
    ('Dario Líder', '584140000004', TRUE, TRUE)`);
  await db.query(`INSERT INTO care_groups (name, leader_name, leader_phone, meeting_day, token) VALUES
    ('Luz del Este', 'Ana Líder', '584140000001', 'Lunes', 'tok-luz'),
    ('Betel', 'Beto Líder', '584140000002', 'Lunes', 'tok-betel'),
    ('Grupo Cira', 'Cira Líder', '584140000003', 'Domingo', 'tok-cira'),
    ('Grupo de Hoy', 'Dario Líder', '584140000004', 'Martes', 'tok-hoy')`);
  // Betel sí reportó su reunión del lunes 9; Luz del Este solo tiene un reporte viejo (lunes 2)
  await db.query(`INSERT INTO care_group_reports (group_id, meeting_date) SELECT id, '2026-11-09' FROM care_groups WHERE name = 'Betel'`);
  await db.query(`INSERT INTO care_group_reports (group_id, meeting_date) SELECT id, '2026-11-02' FROM care_groups WHERE name = 'Luz del Este'`);
};
const channel = (failText) => {
  const out = { text: [], tpl: [] };
  return {
    out,
    channels: {
      dryRun: false,
      whatsapp: {
        available: true,
        sendText: async (to, text) => {
          if (failText) throw new Error(failText);
          out.text.push([to, text]);
        },
        sendTemplate: async (to, t) => out.tpl.push([to, t]),
      },
    },
  };
};

test('la reunión debida es la más reciente ya pasada; si es hoy, todavía no toca', () => {
  assert.equal(rr.lastMeetingDate('Lunes', '2026-11-10'), '2026-11-09');
  assert.equal(rr.lastMeetingDate('Domingo', '2026-11-10'), '2026-11-08');
  assert.equal(rr.lastMeetingDate('Miércoles', '2026-11-10'), '2026-11-04');
  assert.equal(rr.lastMeetingDate('Martes', '2026-11-10'), null); // hoy
  assert.equal(rr.lastMeetingDate('', '2026-11-10'), null);
  assert.equal(rr.lastMeetingDate('Feriado', '2026-11-10'), null);
});

test('recordatorio de reporte: solo a quien le falta, una vez por reunión, con resumen pastoral una vez al día', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const config = cfg();
    const c = channel();

    // antes de la hora configurada no hace nada
    const early = await rr.runReportReminders({ db, config, channels: c.channels }, ANTES);
    assert.equal(early.reason, 'todavía no es la hora');
    assert.equal(c.out.text.length, 0);

    const r = await rr.runReportReminders({ db, config, channels: c.channels }, DESPUES);
    // 4 grupos revisados; sin reporte: Luz del Este (lunes 9) y Grupo Cira (domingo 8).
    // Betel reportó el 9 y el Grupo de Hoy se reúne hoy: no entran.
    assert.deepEqual([r.checked, r.due, r.sent, r.failed, r.skipped, r.briefSent], [4, 2, 1, 0, 1, true]);

    // el recordatorio va solo a Ana, con su grupo, la fecha y su enlace
    const toAna = c.out.text.filter(([to]) => to === '584140000001');
    assert.equal(toAna.length, 1);
    assert.match(toAna[0][1], /Luz del Este/);
    assert.match(toAna[0][1], /lunes 9 de noviembre/);
    assert.match(toAna[0][1], /https:\/\/crm\.ejemplo\.test\/g\/tok-luz/);
    // a Cira (sin opt-in), Beto (al día) y Dario (reunión hoy) no se les escribe
    assert.ok(!c.out.text.some(([to]) => ['584140000003', '584140000002', '584140000004'].includes(to)));

    // el resumen va solo al número pastoral, una vez, con los grupos que faltan
    const briefs = c.out.text.filter(([to]) => to === '584125550001');
    assert.equal(briefs.length, 1);
    assert.match(briefs[0][1], /Luz del Este — Ana Líder — último reporte: 2\/11/);
    assert.match(briefs[0][1], /Grupo Cira — Cira Líder — último reporte: sin reportes/);
    assert.match(briefs[0][1], /1 enviados · 1 omitidos · 0 fallidos/);
    assert.ok(!/584|tok-/.test(briefs[0][1])); // sin teléfonos ni enlaces de nadie

    // segunda pasada el mismo día: no se duplica ni el recordatorio ni el resumen
    const r2 = await rr.runReportReminders({ db, config, channels: c.channels }, MAS_TARDE);
    assert.deepEqual([r2.sent, r2.failed, r2.briefSent], [0, 0, false]);
    assert.equal(c.out.text.length, 2);
    const logs = (await db.query('SELECT status FROM care_report_reminders')).rows;
    assert.deepEqual(logs, [{ status: 'enviado' }]);
  });
});

test('recordatorio de reporte: apagado no hace nada; ventana de 24 h cerrada usa la plantilla configurada', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    assert.equal((await rr.runReportReminders({ db, config: cfg({ REPORT_REMINDER: 'false' }), channels: channel().channels }, DESPUES)).reason, 'apagado');

    const c = channel('WeCall: la ventana de 24 h está cerrada; hace falta una plantilla aprobada');
    const r = await rr.runReportReminders({ db, config: cfg({ REPORT_REMINDER_TEMPLATE: 'recordatorio_reporte_gdc' }), channels: c.channels }, DESPUES);
    assert.equal(r.sent, 1);
    assert.equal(c.out.tpl.length, 1);
    const [to, tpl] = c.out.tpl[0];
    assert.equal(to, '584140000001');
    assert.equal(tpl.name, 'recordatorio_reporte_gdc');
    assert.deepEqual(tpl.bodyParams, ['Ana', 'Luz del Este', 'lunes 9 de noviembre', 'https://crm.ejemplo.test/g/tok-luz']);
  });
});
