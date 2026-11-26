'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { openTestDb } = require('./helpers/db');
const rc = require('../src/redil-confirm');

async function seed(h) {
  const ins = (name, phone, active, optIn) =>
    h.db.query('INSERT INTO people (full_name, phone, active, opt_in) VALUES ($1,$2,$3,$4) RETURNING id', [name, phone, active, optIn]);
  const yamilet = (await ins('Yamilet Abarca de Escalona', '0414-555.11.22', true, true)).rows[0].id;
  await ins('Líder Sin Aceptar', '0414-555.33.44', true, false); // en Personas pero sin opt_in
  await ins('Colíder Lista', '0414-555.55.66', true, true); // co-líder, se resuelve por nombre
  let n = 0;
  const grp = (name, leader, phone, co) =>
    h.db.query('INSERT INTO care_groups (name, leader_name, leader_phone, co_leader_name, active, token) VALUES ($1,$2,$3,$4,true,$5)', [name, leader, phone, co || '', `tok${++n}`]);
  await grp('Grupo Anfitriones', 'Yamilet Abarca de Escalona', '0414-555.11.22', 'Colíder Lista');
  await grp('Grupo Sin Aceptar', 'Líder Sin Aceptar', '0414-555.33.44', null);
  await grp('Grupo Fantasma', 'No Está En Personas', '0414-555.77.88', null);
  await grp('Grupo Repetido', 'Yamilet Abarca de Escalona', '0414-555.11.22', null); // misma líder, otro grupo
  return { yamilet };
}

test('destinatarios: solo recibe quien está en Personas, activo y acepta mensajes; una vez por persona', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  try {
    await seed(h);
    const list = await rc.recipients(h.db);
    const byName = Object.fromEntries(list.map((x) => [x.name, x]));
    assert.equal(byName['Yamilet Abarca de Escalona'].listo, true);
    assert.equal(list.filter((x) => x.name === 'Yamilet Abarca de Escalona').length, 1); // dos grupos, una sola entrada
    assert.equal(byName['Colíder Lista'].listo, true); // co-líder resuelta por nombre
    assert.equal(byName['Líder Sin Aceptar'].listo, false);
    assert.match(byName['Líder Sin Aceptar'].motivo, /no acepta mensajes/);
    assert.equal(byName['No Está En Personas'].listo, false);
    assert.match(byName['No Está En Personas'].motivo, /no está en Personas/);
  } finally {
    await h.close();
  }
});

test('el botón: la página lista a los líderes y el envío manda la plantilla solo a los marcados que pueden', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  const { yamilet } = await seed(h);
  const sent = [];
  const channels = {
    dryRun: false,
    whatsapp: {
      available: true,
      sendText: async () => ({ id: 'x' }),
      sendTemplate: async (to, tpl) => {
        sent.push({ to, tpl });
        return { id: 'ok' };
      },
    },
    email: { available: false },
  };
  const config = loadConfig({ DATABASE_URL: 'x', SESSION_SECRET: 's'.repeat(48), ADMIN_PASSWORD: 'clave-de-prueba-123', PUBLIC_URL: 'https://crm.ejemplo.test' });
  const app = createApp({ db: h.db, config, channels });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/entrar', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'clave-de-prueba-123' }), redirect: 'manual' });
    const cookie = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const pageHtml = await (await fetch(base + '/redil/confirmar', { headers: cookie })).text();
    assert.ok(pageHtml.includes('Confirmación REDIL') && pageHtml.includes('Yamilet Abarca de Escalona') && pageHtml.includes('no acepta mensajes'));
    const res = await fetch(base + '/redil/confirmar', {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ fecha: '2026-12-01', hora: '7:00 p. m.', quien: String(yamilet) }),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.ok(decodeURIComponent((res.headers.get('location') || '').replaceAll('+', ' ')).includes('Confirmación enviada a 1 líder'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '584145551122');
    assert.equal(sent[0].tpl.name, 'confirmacion_redil');
    assert.deepEqual(sent[0].tpl.bodyParams, ['Yamilet', 'martes 1 de diciembre', '7:00 p. m.']);
  } finally {
    server.close();
    await h.close();
  }
});
