'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pn = require('../src/presentaciones-ninos');
const { presentacionesNinosRouter } = require('../src/routes/presentaciones-ninos');
const pastoral = require('../src/agent-pastoral');
const { openTestDb } = require('./helpers/db');

const config = { timezone: 'America/Caracas', defaultCountryCode: '58', churchName: 'Iglesia de Prueba', dryRun: false };
const HOY = '2026-11-25';

test('validación: nombre obligatorio, fechas sanas y sede de la lista', () => {
  assert.ok(pn.validateRow({ name: '' }, HOY).errors.length >= 1);
  const ok = pn.validateRow({ name: 'Samuel Pérez', birth_date: '10/05/2026', presentation_date: '2026-11-22', sede: 'Las Mercedes', parents: 'José y María Pérez', presented_by: 'Pastor Eliezer' }, HOY);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.birth_date, '2026-05-10');
  assert.equal(ok.value.presentation_date, '2026-11-22');
  assert.ok(pn.validateRow({ name: 'X', presentation_date: '2027-01-01' }, HOY).errors.some((e) => e.includes('futura')));
  assert.ok(pn.validateRow({ name: 'X', birth_date: '2026-06-01', presentation_date: '2026-05-01' }, HOY).errors.some((e) => e.includes('antes del nacimiento')));
  assert.ok(pn.validateRow({ name: 'X', sede: 'Otra' }, HOY).errors.some((e) => e.includes('sede')));
});

async function withApp(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(presentacionesNinosRouter({ db: h.db, config }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ db: h.db, base });
  } finally {
    server.close();
    await h.close();
  }
}

test('registro: se agrega, se lista escapado, no crea personas y se puede borrar', async (t) => {
  await withApp(t, async ({ db, base }) => {
    const post = (body) => fetch(base + '/presentacion-ninos', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' });
    const r = await post({ name: 'Samuel <b>Pérez</b>', birth_date: '2026-05-10', presentation_date: '2026-11-22', sede: 'Las Mercedes', parents: 'José y María Pérez', presented_by: 'Pastor Eliezer' });
    assert.equal(r.status, 303);
    const html = await (await fetch(base + '/presentacion-ninos')).text();
    assert.ok(html.includes('Samuel &lt;b&gt;Pérez&lt;/b&gt;'));
    assert.ok(html.includes('22/11/2026'));
    assert.ok(html.includes('José y María Pérez'));
    assert.equal((await db.query('SELECT 1 FROM people')).rows.length, 0); // no crea personas
    const { rows } = await db.query('SELECT id FROM presentaciones_ninos');
    assert.equal(rows.length, 1);
    const del = await fetch(`${base}/presentacion-ninos/${rows[0].id}/borrar`, { method: 'POST', redirect: 'manual' });
    assert.equal(del.status, 303);
    assert.equal((await db.query('SELECT 1 FROM presentaciones_ninos')).rows.length, 0);
  });
});

test('cargar una lista: CSV con columnas, simples por línea, sin duplicar los que ya están', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  try {
    await pn.add(h.db, { name: 'Samuel Pérez', presentation_date: '2026-11-22', sede: 'Las Mercedes' }, HOY);
    const csv = ['nombre,nacimiento,fecha_presentacion,sede,padres', 'Samuel Pérez,,22/11/2026,Las Mercedes,José y María', 'Ana Lucía Ruiz,05/01/2026,22/11/2026,Nuarito,Pedro Ruiz', 'Ana Lucía Ruiz,05/01/2026,22/11/2026,Nuarito,Pedro Ruiz'].join('\n');
    const prep = await pn.prepareImport(h.db, csv, { today: HOY, defaults: { source: 'Lista cargada' } });
    assert.equal(prep.mode, 'csv');
    assert.deepEqual(prep.records.map((x) => x.status), ['ya_estaba', 'nueva', 'repetida']);
    const s = await pn.applyImport(h.db, prep);
    assert.equal(s.saved, 1);
    assert.equal(s.skipped, 2);
    const simple = await pn.prepareImport(h.db, 'Lucas Gómez\nMaría Fernanda León', { today: HOY, defaults: { presentation_date: '2026-11-22', sede: 'Las Mercedes', source: 'Presentaciones 2026' } });
    assert.equal(simple.mode, 'lista');
    assert.equal(simple.records.length, 2);
    assert.equal(simple.records[0].value.presentation_date, '2026-11-22');
    await pn.applyImport(h.db, simple);
    assert.equal((await h.db.query('SELECT 1 FROM presentaciones_ninos')).rows.length, 4);
  } finally {
    await h.close();
  }
});

test('cargar una lista por la página: revisar muestra la vista previa y guardar la aplica', async (t) => {
  await withApp(t, async ({ db, base }) => {
    const post = (body) => fetch(base + '/presentacion-ninos/importar', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), redirect: 'manual' });
    const csv = 'nombre,fecha_presentacion\nSamuel Pérez,22/11/2026\nAna Lucía Ruiz,22/11/2026';
    const rev = await post({ csv, accion: 'revisar' });
    const htmlRev = await rev.text();
    assert.ok(htmlRev.includes('niños nuevos') && htmlRev.includes('Samuel Pérez'));
    assert.equal((await db.query('SELECT 1 FROM presentaciones_ninos')).rows.length, 0); // revisar no guarda
    const save = await post({ csv, accion: 'guardar' });
    assert.equal(save.status, 303);
    assert.equal((await db.query('SELECT 1 FROM presentaciones_ninos')).rows.length, 2);
  });
});

test('Grace pastoral: la herramienta de presentaciones existe y devuelve los niños', async (t) => {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba');
  try {
    assert.ok(pastoral.TOOLS.some((x) => x.name === 'presentaciones_ninos'));
    await pn.add(h.db, { name: 'Ana Lucía', presentation_date: '2026-11-22', sede: 'Nuarito', parents: 'Pedro y Ana', presented_by: 'Pastor Sequera' }, HOY);
    const out = await pastoral.runTool(h.db, config, 'presentaciones_ninos', {}, new Date('2026-11-25T12:00:00Z'));
    assert.equal(out.total, 1);
    assert.equal(out.ninos[0].nombre, 'Ana Lucía');
    assert.equal(out.ninos[0].sede, 'Nuarito');
  } finally {
    await h.close();
  }
});
