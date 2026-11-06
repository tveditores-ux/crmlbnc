'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cal = require('../src/calendar');
const views = require('../src/views/calendar');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
test('semana de lunes a domingo y meses', () => {
  assert.deepEqual(cal.weekRange('2026-11-06'), { from: '2026-11-02', to: '2026-11-08' }); // viernes
  assert.deepEqual(cal.weekRange('2026-11-02'), { from: '2026-11-02', to: '2026-11-08' }); // lunes
  assert.deepEqual(cal.weekRange('2026-11-08'), { from: '2026-11-02', to: '2026-11-08' }); // domingo
  assert.deepEqual(cal.weekRange('2026-12-31'), { from: '2026-12-28', to: '2027-01-03' }); // cruza de año
  assert.deepEqual(cal.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.equal(cal.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(cal.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(cal.validMonth('2026-13'), false);
  assert.equal(cal.validMonth('2026-11'), true);
  assert.equal(cal.dayLabel('2026-11-06'), 'viernes 6 de noviembre');
});

test('fechas de nacimiento: dos formatos, basura se ignora, 29 de febrero cae el 28 en años normales', () => {
  assert.deepEqual(cal.parseBirth('1990-05-04'), { month: 5, day: 4 });
  assert.deepEqual(cal.parseBirth('04/05/1990'), { month: 5, day: 4 });
  for (const bad of ['', null, 'ayer', '1990-13-01', '1990-00-10', '99/99/1990']) assert.equal(cal.parseBirth(bad), null, String(bad));
  assert.deepEqual(cal.birthdayDates({ month: 2, day: 29 }, '2027-02-01', '2027-02-28'), ['2027-02-28']);
  assert.deepEqual(cal.birthdayDates({ month: 2, day: 29 }, '2028-02-01', '2028-02-29'), ['2028-02-29']);
  assert.deepEqual(cal.birthdayDates({ month: 1, day: 2 }, '2026-12-28', '2027-01-03'), ['2027-01-02']); // semana que cruza el año
  assert.deepEqual(cal.birthdayDates({ month: 6, day: 15 }, '2026-11-02', '2026-11-08'), []);
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

async function seed(db) {
  const ev = (title, type, at, cancelled = false) =>
    db.query('INSERT INTO events (title, event_type, starts_at, location, cancelled) VALUES ($1,$2,$3,$4,$5)', [title, type, at, 'Templo principal', cancelled]);
  await ev('Culto de jóvenes', '', '2026-11-07T22:00:00Z'); // 6:00 p. m. en Caracas (UTC-4)
  await ev('REDIL de noviembre', 'REDIL ordinario', '2026-11-06T12:00:00Z');
  await ev('Evento cancelado', '', '2026-11-07T15:00:00Z', true);
  await ev('Evento de otro mes', '', '2026-12-20T15:00:00Z');
  await ev('Casi medianoche', '', '2026-11-09T03:30:00Z'); // 11:30 p. m. del domingo 8 en Caracas
  const person = (name, phone, birth, active = true, role = '') =>
    db.query('INSERT INTO people (full_name, phone, birth_date, active, role) VALUES ($1,$2,$3,$4,$5)', [name, phone, birth, active, role]);
  await person('Ana Pérez', '584145550001', '1990-11-07');
  await person('Beto Ríos', '584145550002', '1985-11-07', true, 'Diácono');
  await person('Carla Mora', '584145550003', '1992-11-09'); // lunes siguiente: fuera de la semana
  await person('Dani Inactivo', '584145550004', '1990-11-06', false);
  await person('Elena Sin Fecha', '584145550005', '');
  await person('Fabio Fecha Rota', '584145550006', 'no sé');
  await person('Líder Lucas', '584145550007', '1980-11-06'); // líder: está en Personas y es líder de un grupo
  const g = (name, leader, phone, birth, co = '', coBirth = '', active = true) =>
    db.query('INSERT INTO care_groups (name, leader_name, leader_phone, leader_birth_date, co_leader_name, co_leader_birth_date, token, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [name, leader, phone, birth, co, coBirth, `tok${name.length}${leader.length}`.padEnd(20, 'x'), active]);
  await g('Grupo Esperanza', 'Líder Lucas', '584145550007', '1980-11-06'); // el mismo, no debe salir dos veces
  await g('Grupo Pareja', 'Marta Gil', '', '1975-11-08', 'Pedro Gil', '1974-11-08'); // líderes que no están en Personas
  await g('Grupo cerrado', 'Ex Líder', '', '1970-11-06', '', '', false);
}

test('collect: eventos con su hora local, cumpleaños sin repetir, nadie inactivo ni cancelado ni con fecha rota', async (t) => {
  await withDb(t, async (db) => {
    await seed(db);
    const week = cal.weekRange('2026-11-06');
    const items = await cal.collect(db, 'America/Caracas', week.from, week.to);
    const view = items.map((i) => `${i.date} ${i.time || '--'} ${i.kind} ${i.title}`);
    assert.deepEqual(view, [
      '2026-11-06 -- lider Líder Lucas', // los cumpleaños (todo el día) van primero en su día
      '2026-11-06 08:00 redil REDIL de noviembre',
      '2026-11-07 -- cumple Ana Pérez',
      '2026-11-07 -- cumple Beto Ríos',
      '2026-11-07 18:00 actividad Culto de jóvenes',
      '2026-11-08 -- lider Marta Gil',
      '2026-11-08 -- lider Pedro Gil',
      '2026-11-08 23:30 actividad Casi medianoche',
    ]);
    assert.ok(!view.join().includes('Dani Inactivo') && !view.join().includes('Ex Líder') && !view.join().includes('cancelado'));
    assert.ok(items.every((i) => !/\b(19|20)\d\d\b/.test(i.sub))); // nunca la edad ni el año de nacimiento
    const nov = await cal.collect(db, 'America/Caracas', '2026-11-01', '2026-11-30');
    assert.ok(nov.some((i) => i.title === 'Carla Mora' && i.date === '2026-11-09'));
    assert.ok(!nov.some((i) => i.title === 'Evento de otro mes'));
  });
});

test('cintillo: solo lo que queda desde hoy, con "Hoy" y "Mañana"; sin nada, un aviso', () => {
  const items = [
    { date: '2026-11-05', time: '', kind: 'cumple', title: 'Ya pasó', sub: '', href: '' },
    { date: '2026-11-06', time: '', kind: 'lider', title: 'Líder Lucas', sub: '', href: '' },
    { date: '2026-11-07', time: '18:00', kind: 'actividad', title: 'Culto <b>de jóvenes</b>', sub: '', href: '/eventos/3' },
    { date: '2026-11-08', time: '', kind: 'cumple', title: 'Marta Gil', sub: '', href: '/personas/1' },
  ];
  const html = views.ticker({ items, today: '2026-11-06', weekFrom: '2026-11-02', weekTo: '2026-11-08' });
  assert.ok(!html.includes('Ya pasó'));
  assert.match(html, /<strong>Hoy<\/strong> ⭐ Líder Lucas/);
  assert.match(html, /<strong>Mañana<\/strong> 📅 Culto &lt;b&gt;de jóvenes&lt;\/b&gt; · 18:00/); // escapado
  assert.match(html, /<strong>Domingo 8<\/strong> 🎂 Marta Gil/);
  assert.ok(html.includes('href="/eventos/3"') && !html.includes('href="/personas/1"')); // los cumpleaños no enlazan a la ficha desde el cintillo
  assert.match(html, /prefers-reduced-motion/);
  assert.match(views.ticker({ items: [], today: '2026-11-06' }), /No hay actividades ni cumpleaños el resto de esta semana/);
});

test('pantallas: /calendario y el cintillo en Inicio, solo con sesión; filtros y mes inválido no rompen nada', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const cfg = loadConfig({ DATABASE_URL: 'postgres://prueba', CHURCH_NAME: 'Iglesia de Prueba', PUBLIC_URL: 'http://localhost', ADMIN_PASSWORD: 'clave-de-prueba-123', SESSION_SECRET: 's'.repeat(48), DRY_RUN: 'true', TIMEZONE: 'America/Caracas' });
  const app = createApp({ db: h.db, config: cfg, channels: { whatsapp: { available: false }, email: { available: false } } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/calendario`, { redirect: 'manual' })).status, 303); // sin sesión
    const login = await fetch(`${base}/entrar`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'clave-de-prueba-123' }).toString(), redirect: 'manual' });
    const H = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const get = async (p) => ({ status: (await fetch(base + p, { headers: H })).status, text: await (await fetch(base + p, { headers: H })).text() });

    const today = cal.today('America/Caracas');
    const month = today.slice(0, 7);
    const soon = `${today}T${'23:00:00'}`; // hoy mismo, tarde
    await h.db.query("INSERT INTO events (title, starts_at, location) VALUES ('Reunión de prueba', (now() AT TIME ZONE 'America/Caracas')::date + time '15:00' AT TIME ZONE 'America/Caracas', 'Sala')");
    const [dd, mm] = [today.slice(8), today.slice(5, 7)];
    await h.db.query("INSERT INTO people (full_name, phone, birth_date) VALUES ('Cumpleañera Hoy', '584145559999', $1)", [`1991-${mm}-${dd}`]);

    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /class="ticker/);
    assert.match(home.text, /Reunión de prueba/);
    assert.match(home.text, /Cumpleañera Hoy/);
    assert.match(home.text, /<a href="\/calendario" class="">Calendario<\/a>/);

    const page = await get(`/calendario?mes=${month}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Agenda de/);
    assert.match(page.text, /Cumpleañera Hoy/);
    const onlyAct = await get(`/calendario?mes=${month}&ver=actividades`);
    assert.match(onlyAct.text, /Reunión de prueba/);
    assert.ok(!onlyAct.text.includes('Cumpleañera Hoy'));
    const onlyBd = await get(`/calendario?mes=${month}&ver=cumpleanos`);
    assert.ok(!onlyBd.text.includes('Reunión de prueba') && onlyBd.text.includes('Cumpleañera Hoy'));
    assert.equal((await get('/calendario?mes=basura&ver=cualquiera')).status, 200); // cae a mes actual y a "todo"
    assert.equal((await fetch(`${base}/calendario`, { headers: H })).headers.get('cache-control'), 'no-store');
    void soon;
  } finally {
    server.close();
    await h.close();
  }
});
