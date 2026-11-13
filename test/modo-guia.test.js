'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { layout } = require('../src/views/layout');
const guide = require('../src/views/guide');

const config = { churchName: 'Iglesia de Prueba', dryRun: false };

test('modo guía: está en las pantallas del panel, no en las públicas, y cada pestaña del menú tiene su explicación', () => {
  const html = layout({ title: 'Inicio', active: '/', body: '<p>hola</p>', config });
  assert.match(html, /guia-btn/);
  assert.match(html, /\.guia-tip\{/);
  const hrefs = [...html.match(/<nav>[\s\S]*?<\/nav>/)[0].matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 10);
  for (const h of hrefs) assert.ok(guide.NAV_HELP[h], `falta la explicación de ${h} en NAV_HELP`);

  const pub = layout({ title: 'Formulario', body: '<p>hola</p>', config, bare: true });
  assert.ok(!pub.includes('guia-btn'));
  assert.ok(!pub.includes('guia-tip'));
});

test('modo guía: el script es JavaScript válido y no se puede cerrar la etiqueta desde los textos', () => {
  const html = layout({ title: 'Inicio', active: '/', body: '', config });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const g = scripts.find((s) => s.includes('crm-guia'));
  assert.ok(g);
  assert.doesNotThrow(() => new vm.Script(g));
  for (const [src, flags] of guide.BUTTON_RULES.map(([re]) => [re.source, re.flags])) assert.doesNotThrow(() => new RegExp(src, flags));
  const rule = (t) => (guide.BUTTON_RULES.find(([re]) => re.test(t)) || [])[1];
  assert.match(rule('Guardar'), /Guarda/);
  assert.match(rule('✕'), /Borra/);
  assert.match(rule('Enviar por WhatsApp'), /WhatsApp/);
  assert.match(rule('Descargar lista'), /Descarga/);
});
