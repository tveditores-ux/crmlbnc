'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createChannels } = require('../src/channels');
const agent = require('../src/agent');
const pastoral = require('../src/agent-pastoral');
const settings = require('../src/settings');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const SECRET = 's'.repeat(48);
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const PASTOR = '584125550001';
const MIEMBRO = '584145550002';
const cfg = (extra = {}) =>
  loadConfig({
    DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'https://crm.ejemplo.test', ADMIN_PASSWORD: 'clave-de-prueba-123',
    SESSION_SECRET: SECRET, DRY_RUN: 'false', AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant-inventada-0001', AGENT_PASTORAL_PHONES: '0412-5550001', ...extra,
  });
const NOW = new Date('2026-11-09T15:00:00Z');

async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

async function seed(db) {
  await db.query(`INSERT INTO people (full_name, phone, active, congregation, role, address, cedula) VALUES
    ('Pastor Prueba', '${PASTOR}', TRUE, 'Adultos', 'Pastor', 'Calle Secreta 1', 'V-11111111'),
    ('Miembro Prueba', '${MIEMBRO}', TRUE, 'Jóvenes', '', 'Calle Secreta 2', 'V-22222222')`);
  await db.query(`INSERT INTO service_attendance (service_date, sede, horario, att_start, att_mid, att_end, guests, conversions, kids) VALUES
    ('2026-11-08', 'Principal', '10:00', 300, 350, 340, 12, 4, 60),
    ('2026-11-08', 'Principal', '12:00', 200, 220, 210, 5, 1, 30),
    ('2026-09-01', 'Principal', '10:00', 100, 100, 100, 0, 0, 0)`);
  const g = await db.query(`INSERT INTO care_groups (name, leader_name, leader_phone, congregation, meeting_day, token) VALUES
    ('Luz del Este', 'Carla Líder', '584240000003', 'Adultos', 'Jueves', 'tok-a'), ('Sal y Luz', 'Dario Líder', '584240000004', 'Jóvenes', 'Viernes', 'tok-b') RETURNING id`);
  await db.query(`INSERT INTO care_group_reports (group_id, meeting_date, attendance, guests_count, offering, payment_ref, testimonies) VALUES ($1, '2026-11-06', 14, 3, 250, '9876', 'Sanidad de una hermana')`, [g.rows[0].id]);
  await db.query(`INSERT INTO nueva_vida (full_name, phone, decision_date, sede, address) VALUES ('Nuevo Creyente', '584160000005', '2026-11-08', 'Principal', 'Calle Secreta 3')`);
  await db.query(`INSERT INTO bautizados (full_name, phone, baptism_date, sede, minister) VALUES ('Bautizado Prueba', '584160000006', '2026-10-20', 'Principal', 'Pastor Prueba')`);
}

test('números autorizados: se normalizan, se validan y solo esos tienen modo pastoral', () => {
  assert.deepEqual(pastoral.parsePhones('0412-5550001, +58 414 5550002\n0412-5550001'), { value: '584125550001,584145550002' });
  assert.ok(pastoral.parsePhones('0412-5550001, hola').error);
  assert.ok(pastoral.parsePhones(Array(11).fill('0412555000').map((x, i) => x + i).join(',')).error);
  assert.deepEqual(pastoral.parsePhones('  '), { value: '' });
  const c = cfg();
  assert.equal(pastoral.isPastoral(c, PASTOR), true);
  assert.equal(pastoral.isPastoral(c, MIEMBRO), false);
  assert.equal(pastoral.isPastoral(cfg({ AGENT_PASTORAL_PHONES: '' }), PASTOR), false);
  assert.equal(settings.formatPhones('584125550001,584145550002'), '0412-5550001, 0414-5550002');
});

test('herramientas: traen asistencia, grupos, reportes, nuevos creyentes, bautizos y personas, nunca teléfonos, direcciones, cédulas ni referencias de pago', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const c = cfg();
    const run = (name, input = {}) => pastoral.runTool(db, c, name, input, NOW);

    const asis = await run('asistencia_servicios');
    assert.equal(asis.servicios_encontrados, 2); // el de septiembre queda fuera de los últimos 30 días
    assert.equal(asis.totales.asistencia_maxima, 350 + 220);
    assert.equal(asis.totales.conversiones, 5);
    assert.equal(asis.servicios[0].fecha, '2026-11-08');
    assert.equal((await run('asistencia_servicios', { desde: '2026-01-01', hasta: '2026-12-31' })).servicios_encontrados, 3);

    const grupos = await run('grupos_cuidado');
    assert.equal(grupos.grupos_encontrados, 2);
    assert.equal(grupos.grupos.find((x) => x.grupo === 'Luz del Este').ultimo_reporte, '2026-11-06');

    const rep = await run('reportes_grupos');
    assert.equal(rep.reportes_encontrados, 1);
    assert.equal(rep.totales.asistencia, 14);
    assert.deepEqual(rep.grupos_sin_reporte, [{ grupo: 'Sal y Luz', lider: 'Dario Líder' }]);

    const nv = await run('nuevos_creyentes', { desde: '2026-11-08', hasta: '2026-11-08' });
    assert.equal(nv.total, 1);
    assert.equal(nv.personas[0].nombre, 'Nuevo Creyente');

    assert.equal((await run('bautizados')).total, 1);
    const res = await run('personas_resumen');
    assert.equal(res.personas.activas, 2);
    const bp = await run('buscar_persona', { nombre: 'miembro' });
    assert.equal(bp.personas[0].nombre, 'Miembro Prueba');
    assert.ok((await run('buscar_persona', { nombre: 'x' })).error);
    assert.ok((await run('borrar_todo')).error); // no existe ninguna herramienta que cambie datos

    const all = JSON.stringify([asis, grupos, rep, nv, await run('bautizados'), res, bp, await run('eventos')]);
    for (const secreto of ['584', '0412', 'Calle Secreta', 'V-1111', 'V-2222', '9876']) assert.ok(!all.includes(secreto), secreto);
  });
});

/** Modelo falso con herramientas: pide una herramienta y luego responde con lo que recibió. */
function toolModel(toolName, input, finalText) {
  const log = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    log.push(body);
    const last = body.messages[body.messages.length - 1];
    const gotResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    if (body.tools && !gotResult) {
      return { ok: true, status: 200, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input }] }) };
    }
    const result = gotResult ? JSON.parse(last.content.find((b) => b.type === 'tool_result').content) : null;
    const text = typeof finalText === 'function' ? finalText(result) : finalText;
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ respuesta: text, escalar: false, motivo: '' }) }] }) };
  };
  return { fetchImpl, log };
}

const sent = () => {
  const out = [];
  return { out, channels: { dryRun: false, whatsapp: { available: true, sendText: async (to, text) => out.push([to, text]) }, email: { available: false } } };
};

test('WhatsApp: el pastor autorizado pregunta y Grace consulta los datos; un miembro no recibe herramientas', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const c = cfg();
    let s = sent();
    let m = toolModel('asistencia_servicios', {}, (r) => `El último servicio fue el ${r.servicios[0].fecha} con ${r.totales.asistencia_maxima} personas y ${r.totales.conversiones} conversiones.`);
    let r = await agent.handleInbound({ db, config: c, channels: s.channels }, { from: PASTOR, body: '¿Cuántos vinieron el último servicio?', type: 'text' }, { fetchImpl: m.fetchImpl, now: NOW });
    assert.equal(r.handledAs, 'agente');
    assert.deepEqual(s.out, [[PASTOR, 'El último servicio fue el 2026-11-08 con 570 personas y 5 conversiones.']]);
    assert.ok(m.log[0].tools && m.log[0].tools.some((x) => x.name === 'reportes_grupos'));
    assert.match(m.log[0].system, /MODO PASTORAL/);

    s = sent();
    m = toolModel('asistencia_servicios', {}, 'Hola, ¿en qué te ayudo?');
    r = await agent.handleInbound({ db, config: c, channels: s.channels }, { from: MIEMBRO, body: '¿Cuántos vinieron el último servicio?', type: 'text' }, { fetchImpl: m.fetchImpl, now: NOW });
    assert.equal(m.log.length, 1);
    assert.equal(m.log[0].tools, undefined); // sin herramientas: nunca ve los datos de la iglesia
    assert.doesNotMatch(m.log[0].system, /MODO PASTORAL/);
  });
});

test('modo pastoral: listas de cifras no se confunden con teléfonos, pero un celular inventado sí se bloquea; el probador lo marca', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const c = cfg();
    const lista = 'Asistencia del domingo:\n- 10:00: 350\n- 12:00: 220\n- 2026-11-08: 4 conversiones';
    let s = sent();
    await agent.handleInbound({ db, config: c, channels: s.channels }, { from: PASTOR, body: 'Dame la asistencia', type: 'text' }, { fetchImpl: toolModel('asistencia_servicios', {}, lista).fetchImpl, now: NOW });
    assert.deepEqual(s.out, [[PASTOR, lista]]);

    s = sent();
    const r = await agent.handleInbound({ db, config: c, channels: s.channels }, { from: PASTOR, body: 'Dame el teléfono de Carla', type: 'text' }, { fetchImpl: toolModel('grupos_cuidado', {}, 'Su número es 0424-123.45.67').fetchImpl, now: NOW });
    assert.equal(r.handledAs, 'agente_escalado');
    assert.deepEqual(s.out, [[PASTOR, agent.FALLBACK_REPLY]]);

    const dry = await agent.dryAnswer({ db, config: c }, { phone: PASTOR, text: 'Asistencia' }, { fetchImpl: toolModel('asistencia_servicios', {}, 'Fueron 570.').fetchImpl, now: NOW });
    assert.equal(dry.kind, 'modelo');
    assert.equal(dry.pastoral, true);
    assert.equal(dry.reply, 'Fueron 570.');
  });
});

test('panel: solo administración guarda los números con acceso pastoral; se validan y vacío quita el acceso', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const config = cfg({ AGENT_PASTORAL_PHONES: '' });
  const ctx = { db: h.db, config, channels: createChannels(config) };
  const server = createApp(ctx).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
    const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const post = (f, headers = admin) => fetch(`${base}/configuracion/agente`, { method: 'POST', headers: { ...FORM, ...headers }, body: new URLSearchParams(f), redirect: 'manual' });

    const bad = await post({ pastoral_phones: 'no es un número' });
    assert.match(decodeURIComponent((bad.headers.get('location') || '').replaceAll('+', ' ')), /no es un número de teléfono válido/);
    assert.equal(pastoral.isPastoral(config, PASTOR), false);

    assert.equal((await post({ pastoral_phones: '0412-5550001' })).status, 303);
    assert.equal(pastoral.isPastoral(config, PASTOR), true); // aplicado al instante
    const page = await (await fetch(`${base}/configuracion`, { headers: admin })).text();
    assert.match(page, /Números con acceso pastoral/);
    assert.ok(page.includes('value="0412-5550001"'));

    await post({ pastoral_phones: '' });
    assert.equal(pastoral.isPastoral(config, PASTOR), false);
    assert.equal((await post({ pastoral_phones: '0412-5550001' }, {})).status, 401); // sin sesión
  } finally {
    server.close();
    await h.close();
  }
});

test('panel: el aviso diario de cumpleaños se enciende, con hora y plantilla validadas', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const config = cfg();
  const ctx = { db: h.db, config, channels: createChannels(config) };
  const server = createApp(ctx).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/entrar`, { method: 'POST', headers: FORM, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
    const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const post = (f) => fetch(`${base}/configuracion/agente`, { method: 'POST', headers: { ...FORM, ...admin }, body: new URLSearchParams(f), redirect: 'manual' });
    const msg = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
    assert.match(msg(await post({ birthday_brief: 'si', brief_hour: '25' })), /de 0 a 23/);
    assert.match(msg(await post({ brief_template: 'Cumple Hoy!' })), /minúsculas/);
    assert.equal(config.agent.birthdayBrief, false);
    await post({ birthday_brief: 'si', brief_hour: '6', brief_template: 'cumpleanos_hoy' });
    assert.deepEqual([config.agent.birthdayBrief, config.agent.briefHour, config.agent.briefTemplate], [true, 6, 'cumpleanos_hoy']);
    const page = await (await fetch(`${base}/configuracion`, { headers: admin })).text();
    assert.match(page, /Aviso diario de cumpleaños/);
    await post({ birthday_brief: 'no', brief_template: '' });
    assert.deepEqual([config.agent.birthdayBrief, config.agent.briefTemplate], [false, '']);
  } finally {
    server.close();
    await h.close();
  }
});
