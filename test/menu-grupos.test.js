'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { layout } = require('../src/views/layout');

const config = { churchName: 'Iglesia de Prueba', dryRun: false };
const navOf = (html) => html.match(/<nav>[\s\S]*?<\/nav>/)[0];

test('menú agrupado: los 6 grupos con sus sub-pestañas y todas las rutas de siempre', () => {
  const nav = navOf(layout({ title: 'Inicio', active: '/', body: '', config }));
  for (const g of ['Personas y grupos', 'Seguimiento', 'Equipo y reuniones', 'Agenda y servicios', 'Comunicación', 'Configuración'])
    assert.ok(nav.includes(`<summary>${g}</summary>`), g);
  const hrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 25);
  for (const h of ['/', '/personas', '/grupos', '/ministerios', '/registros', '/nueva-vida', '/consolidacion', '/bautizados', '/presentacion-ninos', '/oracion', '/reunion-equipo', '/libreta-lideres', '/redil/libreta', '/redil/preguntas', '/guia', '/eventos', '/calendario', '/asistencia', '/reporte', '/mensajes', '/conversaciones', '/asistente', '/configuracion', '/pruebas', '/grace'])
    assert.ok(hrefs.includes(h), h);
});

test('menú agrupado: el grupo de la página actual entra abierto y los demás cerrados', () => {
  const nav = navOf(layout({ title: 'Personas', active: '/personas', body: '', config }));
  assert.match(nav, /<details class="nav-group" open><summary>Personas y grupos<\/summary>/);
  assert.match(nav, /<details class="nav-group"><summary>Seguimiento<\/summary>/);
  assert.equal((nav.match(/<details class="nav-group" open>/g) || []).length, 1);
});

test('menú agrupado: las sub-pestañas van una debajo de la otra (bloque, no en línea)', () => {
  const html = layout({ title: 'Inicio', active: '/', body: '', config });
  assert.match(html, /nav details\.nav-group a\{display:block\}/);
});

test('menú agrupado: Grace va suelta, fuera de los grupos y con su color', () => {
  const nav = navOf(layout({ title: 'Inicio', active: '/', body: '', config }));
  assert.match(nav, /<a href="\/grace" class="grace-tab">Grace \(control remoto\)<\/a>/);
  assert.ok(nav.indexOf('/grace') > nav.lastIndexOf('</details>'), 'Grace va después de todos los grupos, suelta');
  const html = layout({ title: 'Grace', active: '/grace', body: '', config });
  assert.match(navOf(html), /<a href="\/grace" class="grace-tab on">/);
});
