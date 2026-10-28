'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { consolidationRouter } = require('../src/routes/consolidation');
const { openTestDb } = require('./helpers/db');

const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: false };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: config.timezone });

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(consolidationRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const post = (p, fields) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), redirect: 'manual' });
  const loc = (r) => decodeURIComponent((r.headers.get('location') || '').replaceAll('+', ' '));
  try {
    await fn({ db: h.db, get, post, loc });
  } finally {
    server.close();
    await h.close();
  }
}

const add = async (db, name, phone = null) => (await db.query('INSERT INTO people (full_name, phone) VALUES ($1,$2) RETURNING id', [name, phone])).rows[0].id;
const count = async (db, table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('tablero vacío: invita a registrar o importar, y la plantilla trae las columnas', async (t) => {
  await withApp(t, async ({ get }) => {
    const r = await get('/consolidacion');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Todavía no hay nadie en consolidación/);
    assert.match(html, /Embudo/);
    const csv = await (await get('/consolidacion/plantilla.csv')).text();
    assert.match(csv, /nombre,telefono,fecha_decision,sede/);
  });
});

test('registrar una decisión: crea la persona sin consentimiento y abre su ficha', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const r = await post('/consolidacion/nueva', { name: 'Lucía Fernández', phone: '0414-555.12.34', decision_date: day(-3), sede: 'Las Mercedes', invited_by: 'Su esposo' });
    assert.equal(r.status, 303);
    assert.match(loc(r), /^\/consolidacion\/\d+\?ok=Decisión registrada/);
    assert.equal((await db.query('SELECT opt_in, phone, role FROM people')).rows[0].opt_in, false);
    const ficha = await (await get(loc(r).split('?')[0])).text();
    assert.match(ficha, /Lucía Fernández/);
    assert.match(ficha, /Marcar/);
    assert.match(ficha, /Llamada de Nueva Vida/);
    // el mismo teléfono en otro formato: no duplica, lleva a la ficha que ya existe
    const dup = await post('/consolidacion/nueva', { name: 'Otra Escritura', phone: '+58 414 5551234', decision_date: day(-1), sede: 'Nuarito' });
    assert.match(loc(dup), /err=Esa persona ya estaba en consolidación/);
    assert.equal(await count(db, 'people'), 1);
    assert.equal(await count(db, 'consolidation'), 1);
  });
});

test('un nombre parecido pide confirmación y no crea nada hasta que se confirme', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    const existing = await add(db, 'María Pérez de López', '584141234567');
    const fields = { name: 'Maria Perez', phone: '', decision_date: day(-2), sede: 'Nuarito' };
    const ask = await post('/consolidacion/nueva', fields);
    assert.equal(ask.status, 200);
    const html = await ask.text();
    assert.match(html, /¿Ya la tenemos registrada\?/);
    assert.match(html, /María Pérez de López/);
    assert.equal(await count(db, 'consolidation'), 0);
    assert.equal(await count(db, 'people'), 1);
    // elección que no era candidata: se rechaza
    const other = await add(db, 'Persona Ajena', '584120000000');
    const bad = await post('/consolidacion/nueva', { ...fields, choice: String(other) });
    assert.match(loc(bad), /err=Elección no válida/);
    assert.equal(await count(db, 'consolidation'), 0);
    // misma persona
    const same = await post('/consolidacion/nueva', { ...fields, choice: String(existing) });
    assert.equal(same.status, 303);
    assert.equal(await count(db, 'people'), 2); // las dos que sembré, ninguna nueva
    assert.equal((await db.query('SELECT person_id FROM consolidation')).rows[0].person_id, existing);
  });
});

test('"es una persona nueva" crea otra ficha aunque el nombre se parezca', async (t) => {
  await withApp(t, async ({ db, post }) => {
    await add(db, 'María Pérez de López', '584141234567');
    const r = await post('/consolidacion/nueva', { name: 'Maria Perez', phone: '', decision_date: day(-2), choice: 'nueva' });
    assert.equal(r.status, 303);
    assert.equal(await count(db, 'people'), 2);
    assert.equal(await count(db, 'consolidation'), 1);
  });
});

test('validaciones al registrar: sin nombre, fecha futura o teléfono inválido no guardan nada', async (t) => {
  await withApp(t, async ({ db, post }) => {
    for (const fields of [
      { name: '', decision_date: day(-1) },
      { name: 'Alguien', decision_date: day(5) },
      { name: 'Alguien', decision_date: day(-1), phone: '12' },
      { name: 'Alguien', decision_date: 'ayer' },
    ]) {
      const r = await post('/consolidacion/nueva', fields);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /flash err/);
    }
    assert.equal(await count(db, 'people'), 0);
  });
});

test('ficha: avanzar etapa, quitarla, cambiar estado y registrar llamadas', async (t) => {
  await withApp(t, async ({ db, get, post, loc }) => {
    const vol = await add(db, 'Voluntaria Uno');
    const p = await add(db, 'Persona Ocho', '584140000008');
    const c = (await db.query(`INSERT INTO consolidation (person_id, decision_date) VALUES ($1, $2) RETURNING id`, [p, day(-10)])).rows[0].id;
    const base = `/consolidacion/${c}`;
    // etapa
    assert.match(loc(await post(`${base}/etapa`, { stage: 'llamada', date: day(-8), by: String(vol) })), /ok=Guardado/);
    assert.match(loc(await post(`${base}/etapa`, { stage: 'llamada', date: day(-20), by: '' })), /err=La fecha no puede ser anterior/);
    assert.match(loc(await post(`${base}/etapa`, { stage: 'reunion', date: day(4), by: '' })), /err=La fecha no puede ser futura/);
    assert.match(loc(await post(`${base}/etapa`, { stage: 'reunion', date: 'nunca', by: '' })), /err=Escribe una fecha válida/);
    assert.match(loc(await post(`${base}/etapa`, { stage: 'grupo', date: day(-1), by: String(vol), group_name: 'GdC Los Samanes' })), /ok=/);
    let html = await (await get(base)).text();
    assert.match(html, /GdC Los Samanes/);
    assert.match(html, /Etapa actual: <strong>Grupo de cuidado/);
    assert.match(loc(await post(`${base}/etapa/quitar`, { stage: 'grupo' })), /ok=/);
    html = await (await get(base)).text();
    assert.match(html, /Etapa actual: <strong>Llamada de Nueva Vida/);
    // estado
    assert.match(loc(await post(`${base}/estado`, { status: 'perdido', reason: '' })), /err=Elige el motivo/);
    assert.match(loc(await post(`${base}/estado`, { status: 'perdido', reason: 'se_mudo', date: day(-1) })), /ok=/);
    assert.match(await (await get(base)).text(), /Se mudó/);
    // llamadas
    assert.match(loc(await post(`${base}/llamada`, { result: 'no_contesto', by: String(vol), note: 'Apagado' })), /ok=/);
    assert.match(loc(await post(`${base}/llamada`, { result: 'quizas' })), /err=Resultado no válido/);
    assert.match(await (await get(base)).text(), /Apagado/);
    assert.match(loc(await post(`${base}/llamada`, { result: 'no_llamar' })), /ok=/);
    assert.match(await (await get(base)).text(), /Pidió no ser llamada/);
    // datos
    assert.match(loc(await post(`${base}/datos`, { decision_date: day(-9), sede: 'Nuarito', invited_by: 'Un vecino', assigned_to: String(vol) })), /ok=/);
    assert.match(loc(await post(`${base}/datos`, { decision_date: day(-2), sede: 'x' })), /err=La decisión no puede ser después/);
    // quitar de consolidación no borra a la persona
    assert.match(loc(await post(`${base}/eliminar`, {})), /ok=Quitada de consolidación/);
    assert.equal(await count(db, 'consolidation'), 0);
    assert.equal(await count(db, 'people'), 2);
  });
});

test('el tablero cuenta el embudo y filtra por etapa actual, sede y estado', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const mk = async (name, sede, data = {}) => {
      const p = await add(db, name);
      await db.query(`INSERT INTO consolidation (person_id, decision_date, sede, call_date, meeting_date) VALUES ($1,$2,$3,$4,$5)`, [p, day(-30), sede, data.call || null, data.meeting || null]);
    };
    await mk('Sin Llamada', 'Las Mercedes');
    await mk('Con Reunión', 'Las Mercedes', { call: day(-28), meeting: day(-20) });
    await mk('Solo Llamada', 'Nuarito', { call: day(-27) });
    const all = await (await get('/consolidacion')).text();
    assert.equal((all.match(/<svg class="chart"/g) || []).length, 1);
    assert.match(all, /<td>Decisión<\/td><td>3<\/td><td>100%<\/td>/);
    assert.match(all, /<td>Llamada de Nueva Vida<\/td><td>2<\/td><td>67%<\/td>/);
    const reun = await (await get('/consolidacion?etapa=reunion')).text();
    assert.match(reun, /Con Reunión/);
    assert.ok(!/Sin Llamada/.test(reun.split('<h2>Personas')[1]));
    const nua = await (await get('/consolidacion?sede=Nuarito')).text();
    assert.match(nua.split('<h2>Personas')[1], /Solo Llamada/);
    assert.ok(!/Con Reunión/.test(nua.split('<h2>Personas')[1]));
  });
});

test('los nombres se escapan en pantalla', async (t) => {
  await withApp(t, async ({ db, get }) => {
    const p = await add(db, '<script>alert(1)</script>', '584140000099');
    const c = (await db.query(`INSERT INTO consolidation (person_id, decision_date, sede, invited_by) VALUES ($1, $2, '<b>x</b>', '<i>y</i>') RETURNING id`, [p, day(-1)])).rows[0].id;
    for (const path of ['/consolidacion', `/consolidacion/${c}`]) {
      const html = await (await get(path)).text();
      assert.ok(!html.includes('<script>alert(1)'), path);
      assert.ok(!html.includes('<b>x</b>'), path);
    }
  });
});

const CSV = [
  'nombre,telefono,fecha_decision,sede,responsable',
  'Maria Perez,0414-123.45.67,2026-10-05,Las Mercedes,',
  'Jose Luis Rojas,,2026-10-12,Las Mercedes,',
  'Lucía Fernández,0424-555.00.00,2026-10-19,Nuarito,',
].join('\n');

test('importar por pantalla: revisar muestra los tres grupos; guardar exige confirmar; luego queda todo', async (t) => {
  await withApp(t, async ({ db, post, loc }) => {
    await add(db, 'María Pérez de López', '584141234567');
    await add(db, 'José Luis Rojas');
    const rev = await post('/consolidacion/importar', { csv: CSV, accion: 'revisar' });
    assert.equal(rev.status, 200);
    const html = await rev.text();
    assert.match(html, /Ya existen \(mismo teléfono\)/);
    assert.match(html, /Posible coincidencia: confirma cada una/);
    assert.match(html, /Personas nuevas/);
    assert.match(html, /name="d_3"/);
    assert.equal(await count(db, 'consolidation'), 0);

    const noConfirm = await post('/consolidacion/importar', { csv: CSV, accion: 'guardar' });
    assert.equal(noConfirm.status, 200);
    assert.match(await noConfirm.text(), /No se guardó nada: Falta confirmar 1 coincidencias/);
    assert.equal(await count(db, 'consolidation'), 0);

    const jose = (await db.query(`SELECT id FROM people WHERE full_name = 'José Luis Rojas'`)).rows[0].id;
    const ok = await post('/consolidacion/importar', { csv: CSV, accion: 'guardar', d_3: String(jose) });
    assert.equal(ok.status, 303);
    assert.match(loc(ok), /Importación lista: 3 personas nuevas en consolidación/);
    assert.equal(await count(db, 'consolidation'), 3);
    assert.equal(await count(db, 'people'), 3); // solo se creó Lucía
    assert.equal((await db.query('SELECT count(*)::int AS n FROM people WHERE opt_in')).rows[0].n, 0);
  });
});

test('importar con errores: se muestran y no se puede guardar', async (t) => {
  await withApp(t, async ({ db, post }) => {
    const bad = 'nombre,telefono,fecha_decision\nA,0414-000.00.01,31/02/2026\n,0414-000.00.02,2026-10-01';
    const r = await post('/consolidacion/importar', { csv: bad, accion: 'revisar' });
    const html = await r.text();
    assert.match(html, /No se puede guardar todavía/);
    assert.match(html, /Línea 2: Fecha no válida en fecha de decisión/);
    assert.match(html, /Línea 3: Falta el nombre/);
    assert.ok(!html.includes('Guardar todo'));
    const g = await post('/consolidacion/importar', { csv: bad, accion: 'guardar' });
    assert.match(await g.text(), /No se guardó nada: El archivo tiene errores/);
    assert.equal(await count(db, 'people'), 0);
  });
});
