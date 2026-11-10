'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const brief = require('../src/daily-brief');
const pastoral = require('../src/agent-pastoral');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const cfg = (extra = {}) =>
  loadConfig({
    DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'https://crm.ejemplo.test', ADMIN_PASSWORD: 'clave-de-prueba-123',
    SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'false', AGENT_PASTORAL_PHONES: '0412-5550001', BIRTHDAY_BRIEF: 'true', ...extra,
  });
// 10 de noviembre de 2026: 6:30 y 7:30 en Caracas (UTC-4)
const ANTES = new Date('2026-11-10T10:30:00Z');
const DESPUES = new Date('2026-11-10T11:30:00Z');

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
  await db.query(`INSERT INTO people (full_name, phone, active, birth_date) VALUES
    ('Ana Cumple', '584140000001', TRUE, '1990-11-10'), ('Beto Otro Día', '584140000002', TRUE, '1985-03-02'), ('Cira Inactiva', '584140000003', FALSE, '10/11/1970')`);
  await db.query(`INSERT INTO care_groups (name, leader_name, leader_phone, leader_birth_date, token) VALUES ('Luz del Este', 'Dario Líder', '584240000004', '10/11/1980', 'tok-a')`);
};
const channel = (fail) => {
  const out = { text: [], tpl: [] };
  return {
    out,
    channels: {
      dryRun: false,
      whatsapp: {
        available: true,
        sendText: async (to, text) => {
          if (fail) throw new Error(fail);
          out.text.push([to, text]);
        },
        sendTemplate: async (to, t) => out.tpl.push([to, t]),
      },
    },
  };
};

test('aviso de cumpleaños: a la hora elegida, una sola vez al día, solo a los números pastorales, con personas activas y líderes', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const config = cfg();
    const c = channel();
    assert.deepEqual(await brief.runDailyBrief({ db, config, channels: c.channels }, ANTES), { skipped: 'todavía no es la hora' });
    const r = await brief.runDailyBrief({ db, config, channels: c.channels }, DESPUES);
    assert.deepEqual([r.count, r.sent, r.failed], [2, 1, 0]);
    assert.equal(c.out.text.length, 1);
    const [to, text] = c.out.text[0];
    assert.equal(to, '584125550001');
    assert.match(text, /Cumpleaños de hoy, martes 10 de noviembre/);
    assert.match(text, /Ana Cumple/);
    assert.match(text, /Dario Líder \(Líder · Luz del Este\)/);
    assert.ok(!/Beto|Cira|1990|584/.test(text)); // ni otros días, ni inactivos, ni edades, ni teléfonos
    assert.deepEqual(await brief.runDailyBrief({ db, config, channels: c.channels }, new Date('2026-11-10T20:00:00Z')), { skipped: 'ya se avisó hoy' });
    assert.equal(c.out.text.length, 1);
  });
});

test('aviso de cumpleaños: apagado o sin números no envía; si la ventana de 24 h está cerrada usa la plantilla, y sin plantilla lo anota', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    assert.deepEqual(await brief.runDailyBrief({ db, config: cfg({ BIRTHDAY_BRIEF: 'false' }), channels: channel().channels }, DESPUES), { skipped: 'apagado' });
    assert.deepEqual(await brief.runDailyBrief({ db, config: cfg({ AGENT_PASTORAL_PHONES: '' }), channels: channel().channels }, DESPUES), { skipped: 'sin números con acceso pastoral' });

    let c = channel('WeCall: la ventana de 24 h está cerrada; hace falta una plantilla aprobada');
    let r = await brief.runDailyBrief({ db, config: cfg({ BIRTHDAY_BRIEF_TEMPLATE: 'cumpleanos_hoy' }), channels: c.channels }, DESPUES);
    assert.deepEqual([r.sent, r.failed], [1, 0]);
    assert.equal(c.out.tpl[0][1].name, 'cumpleanos_hoy');
    assert.equal(c.out.tpl[0][1].bodyParams[0], 'Ana Cumple, Dario Líder (Líder · Luz del Este)');

    await db.query('DELETE FROM system_state WHERE key = $1', [brief.STATE_KEY]);
    c = channel('WeCall: la ventana de 24 h está cerrada; hace falta una plantilla aprobada');
    r = await brief.runDailyBrief({ db, config: cfg(), channels: c.channels }, DESPUES);
    assert.deepEqual([r.sent, r.failed], [0, 1]);
  });
});

test('Grace (modo pastoral) responde los cumpleaños de hoy o de un rango', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const config = cfg();
    const hoy = await pastoral.runTool(db, config, 'cumpleanos', {}, DESPUES);
    assert.equal(hoy.total, 2);
    assert.deepEqual(hoy.cumpleanos.map((x) => x.nombre).sort(), ['Ana Cumple', 'Dario Líder']);
    const anio = await pastoral.runTool(db, config, 'cumpleanos', { desde: '2026-01-01', hasta: '2026-12-31' }, DESPUES);
    assert.ok(anio.rango.hasta < '2026-03-05'); // como mucho dos meses por consulta
    assert.ok(!JSON.stringify(anio).includes('584'));
  });
});
