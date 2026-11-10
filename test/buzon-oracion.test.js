'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createChannels } = require('../src/channels');
const auth = require('../src/auth');
const prayer = require('../src/prayer');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const SECRET = 's'.repeat(48);
const flash = (loc) => Object.values(Object.fromEntries(new URLSearchParams(String(loc).split('?')[1] || ''))).join(' ');
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const cfg = (extra = {}) =>
  loadConfig({
    DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'https://crm.ejemplo.test', ADMIN_PASSWORD: 'clave-de-prueba-123',
    SESSION_SECRET: SECRET, DRY_RUN: 'false', ...extra,
  });

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
  const g = await db.query(`INSERT INTO care_groups (name, leader_name, leader_phone, congregation, token) VALUES
    ('Luz del Este', 'Carla Líder', '584240000003', 'Matrimonios', 'tok-a'), ('Sin Teléfono', 'Beto Líder', '', 'Jóvenes', 'tok-b') RETURNING id`);
  await db.query(`INSERT INTO congregation_pastors (congregation, name, phone) VALUES ('Matrimonios', 'Pastor Daniel', '584140000009')`);
  return g.rows.map((x) => x.id);
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

test('buzón: la petición va al líder de su grupo y al pastor de su congregación, y queda anotado sin teléfonos', async (t) => {
  await withDb(t, async (db) => {
    const [g1] = await seed(db);
    const id = await prayer.create(db, { kind: 'oracion', requester_name: 'Ana Prueba', body: 'Por la salud de mi mamá', care_group_id: g1, congregation: 'Matrimonios' });
    const c = channel();
    const r = await prayer.send({ db, config: cfg(), channels: c.channels }, id, ['lider', 'pastor']);
    assert.deepEqual(r.map((x) => [x.to, x.name, x.ok]), [['lider', 'Carla Líder', true], ['pastor', 'Pastor Daniel', true]]);
    assert.deepEqual(c.out.text.map((x) => x[0]), ['584240000003', '584140000009']);
    assert.match(c.out.text[0][1], /Petición de oración\* de Ana Prueba/);
    assert.match(c.out.text[0][1], /Hola, Carla\. Por la salud de mi mamá/);
    assert.match(c.out.text[0][1], /Grupo: Luz del Este · Congregación: Matrimonios/);
    assert.equal((await db.query('SELECT status FROM prayer_requests WHERE id = $1', [id])).rows[0].status, 'enviada');
    const sends = (await db.query('SELECT * FROM prayer_sends ORDER BY id')).rows;
    assert.equal(sends.length, 2);
    assert.ok(!JSON.stringify(sends).includes('58424'));
  });
});

test('buzón: sin teléfono, sin pastor o con la ventana de 24 h cerrada lo dice; con plantilla aprobada sí llega', async (t) => {
  await withDb(t, async (db) => {
    const [, g2] = await seed(db);
    const id = await prayer.create(db, { kind: 'informacion', requester_name: '', body: 'Reunión de líderes el sábado', care_group_id: g2, congregation: 'Jóvenes' });
    let r = await prayer.send({ db, config: cfg(), channels: channel().channels }, id, ['lider', 'pastor']);
    assert.match(r[0].detail, /no tiene un teléfono válido/);
    assert.match(r[1].detail, /no tiene pastor registrado/);
    assert.equal((await db.query('SELECT status FROM prayer_requests WHERE id = $1', [id])).rows[0].status, 'nueva');

    const id2 = await prayer.create(db, { kind: 'oracion', requester_name: 'Ana Prueba', body: 'Por trabajo', care_group_id: null, congregation: 'Matrimonios' });
    const closed = 'WeCall: la ventana de 24 h está cerrada; hace falta una plantilla aprobada';
    r = await prayer.send({ db, config: cfg(), channels: channel(closed).channels }, id2, ['pastor']);
    assert.deepEqual([r[0].ok, r[0].detail], [false, 'la ventana de 24 h está cerrada y no hay plantilla configurada']);
    const c = channel(closed);
    r = await prayer.send({ db, config: cfg({ PRAYER_TEMPLATE: 'buzon_oracion' }), channels: c.channels }, id2, ['pastor']);
    assert.equal(r[0].ok, true);
    assert.equal(c.out.tpl[0][1].name, 'buzon_oracion');
    assert.equal(c.out.tpl[0][1].bodyParams[0], 'Petición de oración de Ana Prueba: Por trabajo');
  });
});

test('buzón: cuando Grace pasa una petición de oración, queda en el buzón con el grupo y la congregación de la persona', async (t) => {
  await withDb(t, async (db) => {
    const [g1] = await seed(db);
    const p = (await db.query(`INSERT INTO people (full_name, phone, active, congregation, care_group_name) VALUES ('Ana Prueba', '584140000001', TRUE, 'Matrimonios', 'luz del este') RETURNING id, full_name`)).rows[0];
    assert.equal(await prayer.fromAgent(db, { person: p, text: 'Hola', reason: 'Pidió hablar con un pastor' }), null);
    const id = await prayer.fromAgent(db, { person: p, text: 'Oren por mi mamá, está hospitalizada', reason: 'Petición de oración: madre hospitalizada' });
    const row = (await db.query('SELECT * FROM prayer_requests WHERE id = $1', [id])).rows[0];
    assert.deepEqual([row.requester_name, row.care_group_id, row.congregation, row.source, row.status], ['Ana Prueba', g1, 'Matrimonios', 'whatsapp', 'nueva']);
  });
});

test('buzón: pantalla solo para administración; se escribe, se envía, se archiva y se guardan los pastores', async (t) => {
  const { openTestDb: open } = require('./helpers/db');
  const h = await open();
  if (!h) return t.skip('sin base de datos de prueba');
  const config = cfg({ DRY_RUN: 'true' });
  const ctx = { db: h.db, config, channels: createChannels(config, { logger: { log() {} } }) };
  const server = createApp(ctx).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const [g1] = await seed(h.db);
    const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: 'password=clave-de-prueba-123', redirect: 'manual' });
    const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const coord = { Cookie: `${auth.COOKIE}=${auth.makeSession(SECRET, Date.now(), { role: 'coordinador', pid: 7 })}` };
    const post = (p, body, headers = admin) => fetch(base + p, { method: 'POST', headers: { ...FORM, ...headers }, body: new URLSearchParams(body).toString(), redirect: 'manual' });

    assert.equal((await fetch(`${base}/oracion`, { redirect: 'manual' })).status, 303);
    assert.equal((await fetch(`${base}/oracion`, { headers: coord })).status, 403);
    assert.equal((await post('/oracion', { body: 'x' }, coord)).status, 403);
    assert.equal((await post('/oracion', { body: 'x' }, { ...admin, Origin: 'https://otro-sitio.example' })).status, 403);

    // grupo sin congregación elegida: toma la del grupo; y se envía al momento (DRY_RUN lo simula)
    const params = new URLSearchParams({ kind: 'oracion', requester_name: 'Ana Prueba', body: 'Por mi familia', care_group_id: String(g1), congregation: '' });
    params.append('to', 'lider');
    params.append('to', 'pastor');
    const r = await fetch(`${base}/oracion`, { method: 'POST', headers: { ...FORM, ...admin }, body: params.toString(), redirect: 'manual' });
    assert.match(flash(r.headers.get('location')), /Enviada a Carla Líder y Pastor Daniel/);
    const row = (await h.db.query('SELECT * FROM prayer_requests')).rows[0];
    assert.deepEqual([row.congregation, row.status], ['Matrimonios', 'enviada']);

    const page = await (await fetch(`${base}/oracion`, { headers: admin })).text();
    assert.match(page, /Buzón de oración/);
    assert.match(page, /Por mi familia/);
    assert.ok(!page.includes('584240000003')); // el teléfono del líder no se muestra

    assert.equal((await post(`/oracion/${row.id}/archivar`, {})).status, 303);
    assert.equal((await h.db.query('SELECT status FROM prayer_requests WHERE id = $1', [row.id])).rows[0].status, 'archivada');
    assert.equal((await post('/oracion', { body: '   ' })).headers.get('location').includes('err='), true);

    assert.match(flash((await post('/oracion/pastores', { name_5: 'Pastor Daniel', phone_5: 'no es teléfono' })).headers.get('location')), /no parece válido/);
    await post('/oracion/pastores', { name_3: 'Pastora Elena', phone_3: '0412-5550007' });
    const ps = (await h.db.query('SELECT congregation, name, phone FROM congregation_pastors ORDER BY congregation')).rows;
    assert.deepEqual(ps, [{ congregation: 'Jóvenes', name: 'Pastora Elena', phone: '584125550007' }]); // lo vacío se borra

    assert.match(flash((await post('/oracion/plantilla', { template: 'Mala Plantilla' })).headers.get('location')), /minúsculas/);
    await post('/oracion/plantilla', { template: 'buzon_oracion' });
    assert.equal(ctx.config.agent.prayerTemplate, 'buzon_oracion');
  } finally {
    server.close();
    await h.close();
  }
});
