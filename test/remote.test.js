'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { remoteRouter } = require('../src/routes/attendance-remote');
const { dayNameFor, createRateLimiter } = require('../src/attendance-store');

const TOKEN = 'abcdefghijklmnop1234';
const config = { churchName: 'Iglesia', timezone: 'America/Caracas', dryRun: false };

function setup({ link = { id: 1, sede: 'Las Mercedes', label: 'Conteo', active: true } } = {}) {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM attendance_links/.test(sql)) return { rows: params[0] === TOKEN && link ? [link] : [] };
      if (/INSERT INTO service_attendance/.test(sql)) return { rows: [{ created: true }] };
      return { rows: [] };
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(remoteRouter({ db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, fields) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { calls, server, base, post };
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });

test('dayNameFor da el día correcto sin importar la zona horaria', () => {
  assert.equal(dayNameFor('2025-08-03'), 'Domingo');
  assert.equal(dayNameFor('2025-03-25'), 'Martes');
  assert.equal(dayNameFor('2025-10-15'), 'Miércoles');
});

test('limitador: permite hasta el máximo y luego bloquea; se reinicia con la ventana', () => {
  const l = createRateLimiter({ max: 2, windowMs: 1000 });
  assert.ok(l.take('a', 0) && l.take('a', 1) && !l.take('a', 2));
  assert.ok(l.take('b', 2));
  assert.ok(l.take('a', 5000));
});

test('enlace inexistente o mal formado: 404 y sin tocar la base de datos de asistencia', async () => {
  const { server, base, calls, post } = setup();
  try {
    assert.equal((await fetch(`${base}/a/zzzzzzzzzzzzzzzzzzzz`)).status, 404);
    assert.equal((await fetch(`${base}/a/corto`)).status, 404);
    assert.equal((await post('/a/zzzzzzzzzzzzzzzzzzzz', { service_date: today() })).status, 404);
    assert.ok(!calls.some((c) => /INSERT/.test(c.sql)));
  } finally {
    server.close();
  }
});

test('enlace desactivado: no abre el formulario', async () => {
  const { server, base } = setup({ link: null });
  try {
    assert.equal((await fetch(`${base}/a/${TOKEN}`)).status, 404);
  } finally {
    server.close();
  }
});

test('envío válido: guarda con la sede del enlace, día calculado y origen "telefono"', async () => {
  const { server, base, calls, post } = setup();
  try {
    assert.match(await (await fetch(`${base}/a/${TOKEN}`)).text(), /Las Mercedes/);
    const r = await post(`/a/${TOKEN}`, { sede: 'Agua Viva', service_date: day(-1), horario: '10:00', att_end: '97', guests: '2' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Servicio registrado/);
    const ins = calls.find((c) => /INSERT INTO service_attendance/.test(c.sql));
    assert.equal(ins.params[1], 'Las Mercedes'); // el cuerpo no puede cambiar la sede del enlace
    assert.equal(ins.params[2], require('../src/attendance-store').dayNameFor(day(-1)));
    assert.equal(ins.params[15], 'telefono');
    assert.equal(ins.params[6], 97);
    assert.ok(calls.some((c) => /UPDATE attendance_links SET uses/.test(c.sql)));
  } finally {
    server.close();
  }
});

test('rechaza fechas futuras, muy viejas, sin cifras y números enormes', async () => {
  const { server, post, calls } = setup();
  try {
    const base = { horario: '10:00', att_end: '50' };
    assert.equal((await post(`/a/${TOKEN}`, { ...base, service_date: day(3) })).status, 400);
    assert.equal((await post(`/a/${TOKEN}`, { ...base, service_date: day(-90) })).status, 400);
    assert.equal((await post(`/a/${TOKEN}`, { horario: '10:00', service_date: day(-1) })).status, 400);
    assert.equal((await post(`/a/${TOKEN}`, { ...base, service_date: day(-1), guests: '99999' })).status, 400);
    assert.equal((await post(`/a/${TOKEN}`, { att_end: '50', service_date: day(-1) })).status, 400); // sin horario
    assert.ok(!calls.some((c) => /INSERT INTO service_attendance/.test(c.sql)));
  } finally {
    server.close();
  }
});

test('trampa antirrobots: si el campo oculto viene lleno, no guarda nada', async () => {
  const { server, post, calls } = setup();
  try {
    const r = await post(`/a/${TOKEN}`, { web: 'http://spam', service_date: day(-1), horario: '10:00', att_end: '50' });
    assert.equal(r.status, 200);
    assert.ok(!calls.some((c) => /INSERT INTO service_attendance/.test(c.sql)));
  } finally {
    server.close();
  }
});

test('después de 40 envíos desde la misma conexión responde 429', async () => {
  const { server, post } = setup();
  try {
    let last;
    for (let i = 0; i < 41; i++) last = await post(`/a/${TOKEN}`, { service_date: day(-1), horario: '10:00', att_end: '5' });
    assert.equal(last.status, 429);
  } finally {
    server.close();
  }
});

test('importador: reemplazar borra dentro de la transacción, solo si se pide, y revisar no escribe', async () => {
  const { attendanceRouter } = require('../src/routes/attendance');
  const log = [];
  const client = { query: async (sql, p) => (log.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')), { rows: [] }), release() {} };
  const db = {
    async query(sql) {
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 203 }] };
      if (/AS k FROM service_attendance/.test(sql)) return { rows: [{ k: '2025-08-03|las mercedes|10:00' }] };
      return { rows: [] };
    },
    connect: async () => client,
  };
  const csv = 'fecha,sede,dia,horario,inicio,intermedio,final\n2025-08-03,Las Mercedes,Domingo,10:00,1,2,3\n2026-10-24,Agua Viva,Sábado,10:00,4,5,6\n';
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(attendanceRouter({ db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (fields) => fetch(`${base}/asistencia/importar`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    let r = await post({ csv, accion: 'revisar', reemplazar: '1' });
    assert.match(await r.text(), /se borrarán 203 registros actuales y se cargarán 2/);
    assert.equal(log.length, 0); // revisar no toca nada
    r = await post({ csv, accion: 'importar' });
    assert.equal(r.status, 303);
    assert.ok(!log.some((l) => /^DELETE/.test(l)));
    assert.equal(log.filter((l) => /^INSERT/.test(l)).length, 2);
    log.length = 0;
    r = await post({ csv, accion: 'importar', reemplazar: '1' });
    assert.equal(r.status, 303);
    assert.deepEqual(log.slice(0, 2), ['BEGIN', 'DELETE FROM service_attendance']);
    assert.equal(log[log.length - 1], 'COMMIT');
    assert.match(decodeURIComponent(r.headers.get('location').replace(/+/g, ' ')), /se quitaron 203 registros y se cargaron 2/);
  } finally {
    server.close();
  }
});
