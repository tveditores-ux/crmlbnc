'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const charts = require('../src/views/charts');

test('niceMax redondea el tope del eje a 1, 2 o 5 por potencia de diez', () => {
  assert.equal(charts.niceMax(0), 1);
  assert.equal(charts.niceMax(97), 100);
  assert.equal(charts.niceMax(130), 200);
  assert.equal(charts.niceMax(4.2), 5);
});

test('sin datos las gráficas muestran un aviso, no un SVG roto', () => {
  assert.match(charts.barChart([]), /Aún no hay datos/);
  assert.match(charts.barChart([{ label: 'a', value: 0 }]), /Aún no hay datos/);
  assert.match(charts.lineChart([], []), /Aún no hay datos/);
  assert.match(charts.hBarChart(null), /Aún no hay datos/);
  assert.match(charts.stackedBar([{ label: 'x', value: 0, color: '#000' }]), /Sin participantes/);
  assert.match(charts.donut([]), /Aún no hay datos/);
});

test('las gráficas escapan el texto y guardan los valores en el título accesible', () => {
  const html = charts.barChart([{ label: '<script>x</script>', value: 7 }], { title: 'Prueba "con comillas"' });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /role="img"/);
  assert.match(html, /&quot;con comillas&quot;/);
  assert.match(html, /<title>[^<]*: 7<\/title>/);
});

test('lineChart corta la línea donde faltan datos y pone leyenda con varias series', () => {
  const html = charts.lineChart(['ene', 'feb', 'mar'], [
    { name: 'A', values: [10, null, 30] },
    { name: 'B', values: [5, 6, 7] },
  ]);
  assert.equal((html.match(/<path /g) || []).length, 2);
  assert.match(html, /M[\d.]+ [\d.]+ M/); // dos tramos en la serie con hueco
  assert.match(html, /class="legend"/);
  assert.equal(charts.monthLabel('2025-08'), 'ago 25');
});

test('stackedBar y donut calculan porcentajes', () => {
  const s = charts.stackedBar([
    { label: 'Sí', value: 3, color: '#0a0' },
    { label: 'No', value: 1, color: '#a00' },
  ]);
  assert.match(s, /Sí: 3 \(75%\)/);
  assert.match(charts.donut([{ label: 'a', value: 1, color: '#000' }, { label: 'b', value: 3, color: '#111' }]), />25%</);
});

test('la página de asistencia se dibuja completa con gráficas', async () => {
  const express = require('express');
  const { attendanceRouter } = require('../src/routes/attendance');
  const rows = [
    { id: 1, iso: '2025-08-03', d: '03/08/2025', sede: 'Las Mercedes', day_name: 'Domingo', horario: '10:00', att_start: 70, att_mid: 91, att_end: 97, guests: 2, conversions: 2, servers: 29, pastors: 3, kids: 5, preteens: 0, teens: 0, notes: 'Dos <b>conversiones</b>' },
  ];
  const db = {
    async query(sql) {
      if (/date_trunc\('month'/.test(sql))
        return { rows: [{ ym: '2025-07', sede: 'Agua Viva', prom: 20, guests: 1, conv: 0 }, { ym: '2025-08', sede: 'Agua Viva', prom: 25, guests: 2, conv: 1 }, { ym: '2025-08', sede: 'Las Mercedes', prom: 97, guests: 2, conv: 2 }] };
      if (/day_name AS label/.test(sql)) return { rows: [{ label: 'Domingo', value: 60 }, { label: 'Martes', value: 25 }] };
      if (/GROUP BY sede/.test(sql)) return { rows: [{ sede: 'Las Mercedes', servicios: 1, prom_final: 97, invitados: 2, conversiones: 2 }] };
      if (/DISTINCT sede/.test(sql)) return { rows: [{ sede: 'Las Mercedes' }] };
      return { rows };
    },
  };
  const config = { churchName: 'Iglesia', timezone: 'America/Caracas', dryRun: true };
  const app = express();
  app.use(attendanceRouter({ db, config }));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/asistencia`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.equal((html.match(/<svg class="chart"/g) || []).length, 4);
    assert.match(html, /Dos &lt;b&gt;conversiones/);
    assert.match(html, /jul 25/);
  } finally {
    server.close();
  }
});

test('el reporte se dibuja con indicadores y todas sus gráficas', async () => {
  const express = require('express');
  const { reportRouter } = require('../src/routes/report');
  const db = {
    async query(sql) {
      if (/count\(\*\)::int AS servicios/.test(sql)) return { rows: [{ servicios: 203, prom: 54, maximo: 218, conv: 40, invitados: 90, servidores: 20 }] };
      if (/AS prom, coalesce\(sum\(conversions\),0\)::int AS conv, coalesce\(sum\(guests\)/.test(sql)) return { rows: [{ prom: 50, conv: 30, invitados: 100 }] };
      if (/date_trunc\('week'/.test(sql)) return { rows: [{ label: '01/01', wk: new Date(), value: 30 }, { label: '08/01', wk: new Date(), value: 45 }] };
      if (/GROUP BY 1 ORDER BY 2 DESC/.test(sql)) return { rows: [{ label: 'Las Mercedes', value: 76 }, { label: 'Agua Viva', value: 33 }] };
      if (/AS label, round\(avg\(att_end\)\)::int AS value FROM service_attendance WHERE .* horario/.test(sql)) return { rows: [{ label: '10:00', value: 70 }] };
      if (/date_trunc\('month'/.test(sql)) return { rows: [{ ym: '2025-08', conv: 3, guests: 5 }] };
      if (/AS inicio/.test(sql)) return { rows: [{ inicio: 30, medio: 45, final: 54 }] };
      if (/AS servidores, round\(avg\(pastors\)/.test(sql)) return { rows: [{ servidores: 20.5, pastores: 3, ninos: 9, preadolescentes: 1, adolescentes: 6 }] };
      if (/ORDER BY att_end DESC/.test(sql)) return { rows: [{ label: '05/10/25 · Las Mercedes 10:00', value: 162 }] };
      if (/SELECT DISTINCT sede/.test(sql)) return { rows: [{ sede: 'Las Mercedes' }] };
      if (/FROM people WHERE active/.test(sql)) return { rows: [{ total: 181, phone: 90, email: 5, optin: 0 }] };
      if (/att_end = \$/.test(sql)) return { rows: [{ d: '05/10/2025', sede: 'Las Mercedes', horario: '10:00' }] };
      return { rows: [{}] };
    },
  };
  const app = express();
  app.use(reportRouter({ db, config: { churchName: 'Iglesia', timezone: 'America/Caracas', dryRun: false } }));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/reporte?desde=2025-01-01&hasta=2025-10-31`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, />203</);
    assert.match(html, /\+8%/); // 54 frente a 50
    assert.ok((html.match(/<svg/g) || []).length >= 9);
    assert.match(html, /Imprimir o guardar PDF/);
  } finally {
    server.close();
  }
});
