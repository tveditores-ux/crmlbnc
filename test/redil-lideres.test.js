'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { careRemoteRouter } = require('../src/routes/care-remote');
const redil = require('../src/redil-remote');
const { openTestDb } = require('./helpers/db');

// Todos los datos son inventados.
const config = { churchName: 'Iglesia de Prueba', timezone: 'America/Caracas', defaultCountryCode: '58', dryRun: true };
const TOK = (n) => `lider${String(n).padStart(2, '0')}abcdefghijklmn`;

async function setup(t) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const { db } = h;
  const person = async (name, phone) => (await db.query('INSERT INTO people (full_name, phone) VALUES ($1,$2) RETURNING id', [name, phone])).rows[0].id;
  const group = async (n, name, leader, phone) =>
    (await db.query('INSERT INTO care_groups (name, leader_name, leader_phone, token) VALUES ($1,$2,$3,$4) RETURNING id', [name, leader, phone, TOK(n)])).rows[0].id;
  const event = async (title, type, hours, cancelled = false) =>
    (await db.query("INSERT INTO events (title, event_type, starts_at, location, cancelled) VALUES ($1,$2, now() + ($3 || ' hours')::interval, 'Templo principal', $4) RETURNING id", [title, type, String(hours), cancelled])).rows[0].id;
  const invite = (ev, p, n) => db.query('INSERT INTO event_participants (event_id, person_id, token) VALUES ($1,$2,$3)', [ev, p, `part${n}`.padEnd(20, 'x')]);
  const status = async (ev, p) => (await db.query('SELECT status, response_channel FROM event_participants WHERE event_id=$1 AND person_id=$2', [ev, p])).rows[0];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(careRemoteRouter({ db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p);
  const post = (p, f) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const close = async () => { server.close(); await h.close(); };
  return { db, person, group, event, invite, status, get, post, close };
}

test('el líder ve el REDIL de mañana al que está convocado y confirma que va', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const ana = await s.person('Ana Pérez', '584145550001');
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    const redilId = await s.event('REDIL de noviembre', 'REDIL ordinario', 20);
    await s.invite(redilId, ana, 1);

    const page = await (await s.get(`/g/${TOK(1)}/redil`)).text();
    assert.match(page, /REDIL de noviembre/);
    assert.match(page, /REDIL ordinario/);
    assert.match(page, /Falta tu respuesta/);
    assert.ok(!page.includes('part1xxx')); // el token del participante nunca sale
    // y el aviso en su pantalla principal
    assert.match(await (await s.get(`/g/${TOK(1)}`)).text(), /Tienes un REDIL por confirmar/);

    const ok = await s.post(`/g/${TOK(1)}/redil`, { event_id: redilId, r: 'si' });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Confirmaste tu asistencia/);
    assert.deepEqual(await s.status(redilId, ana), { status: 'confirmado', response_channel: 'enlace_lider' });
    // ya no hay aviso pendiente, y puede cambiar de idea
    assert.ok(!(await (await s.get(`/g/${TOK(1)}`)).text()).includes('Tienes un REDIL por confirmar'));
    assert.match(await (await s.post(`/g/${TOK(1)}/redil`, { event_id: redilId, r: 'no' })).text(), /no podrás asistir/);
    assert.equal((await s.status(redilId, ana)).status, 'no_puede');
  } finally {
    await s.close();
  }
});

test('solo cuenta lo que le corresponde: otros eventos, cancelados, pasados, no convocado o de otro líder no se pueden responder', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const ana = await s.person('Ana Pérez', '584145550001');
    const beto = await s.person('Beto Ríos', '584145550002');
    const g = { leader_phone: '584145550001' };
    await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    await s.group(2, 'Grupo Sin Ficha', 'Carla Mora', '584145550003'); // líder que no está en Personas
    const general = await s.event('Culto de jóvenes', '', 20);
    const cancelado = await s.event('REDIL cancelado', 'REDIL extraordinario', 20, true);
    const pasado = await s.event('REDIL viejo', 'REDIL ordinario', -72);
    const lejano = await s.event('REDIL lejano', 'REDIL ordinario', 24 * 40);
    const soloBeto = await s.event('REDIL de Beto', 'REDIL extendido', 20);
    const sinConvocar = await s.event('REDIL sin convocar', 'REDIL ordinario', 20);
    for (const [i, ev] of [general, cancelado, pasado, lejano].entries()) await s.invite(ev, ana, 10 + i);
    await s.invite(soloBeto, beto, 20);

    assert.deepEqual(await redil.listForLeader(s.db, g), []);
    for (const ev of [general, cancelado, pasado, lejano, soloBeto, sinConvocar]) {
      const r = await s.post(`/g/${TOK(1)}/redil`, { event_id: ev, r: 'si' });
      assert.equal(r.status, 400, `evento ${ev}`);
    }
    assert.equal((await s.status(soloBeto, beto)).status, 'pendiente');
    assert.equal((await s.status(general, ana)).status, 'pendiente');
    // el líder sin ficha en Personas no ve nada ni rompe la pantalla
    const sin = await s.get(`/g/${TOK(2)}/redil`);
    assert.equal(sin.status, 200);
    assert.match(await sin.text(), /No tienes ningún REDIL por confirmar/);
    assert.equal((await s.post(`/g/${TOK(2)}/redil`, { event_id: soloBeto, r: 'si' })).status, 400);
    // respuesta inválida
    const ok = await s.event('REDIL válido', 'REDIL ordinario', 10);
    await s.invite(ok, ana, 30);
    assert.equal((await s.post(`/g/${TOK(1)}/redil`, { event_id: ok, r: 'tal vez' })).status, 400);
    assert.equal((await s.status(ok, ana)).status, 'pendiente');
  } finally {
    await s.close();
  }
});

test('enlace inválido, desactivado o grupo inactivo: no abre; el robot de la trampa no responde nada', async (t) => {
  const s = await setup(t);
  if (!s) return;
  try {
    const ana = await s.person('Ana Pérez', '584145550001');
    const gid = await s.group(1, 'Grupo Esperanza', 'Ana Pérez', '584145550001');
    const ev = await s.event('REDIL', 'REDIL ordinario', 10);
    await s.invite(ev, ana, 1);
    assert.equal((await s.get('/g/zzzzzzzzzzzzzzzzzzzz/redil')).status, 404);
    assert.equal((await s.post('/g/zzzzzzzzzzzzzzzzzzzz/redil', { event_id: ev, r: 'si' })).status, 404);
    await s.post(`/g/${TOK(1)}/redil`, { event_id: ev, r: 'si', web: 'spam' });
    assert.equal((await s.status(ev, ana)).status, 'pendiente');
    await s.db.query('UPDATE care_groups SET link_active = FALSE WHERE id = $1', [gid]);
    assert.equal((await s.get(`/g/${TOK(1)}/redil`)).status, 404);
  } finally {
    await s.close();
  }
});
