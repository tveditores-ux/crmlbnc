'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { layout } = require('../src/views/layout');

test('el favicon se sirve sin sesión y las páginas lo declaran', async () => {
  const app = createApp({ db: { async query() { return { rows: [] }; } }, config: { churchName: 'Iglesia', sessionSecret: 'x'.repeat(32), timezone: 'America/Caracas', publicUrl: 'http://localhost', google: {}, dryRun: true }, channels: {} });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [p, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image'], ['/apple-touch-icon.png', 'image/png']]) {
      const res = await fetch(base + p, { redirect: 'manual' });
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), new RegExp(type.replace('+', '\\+')), p);
    }
  } finally {
    server.close();
  }
  const html = layout({ title: 'X', body: '', config: { churchName: 'Iglesia' }, bare: true });
  assert.match(html, /rel="icon" href="\/favicon\.svg"/);
  assert.match(html, /rel="apple-touch-icon"/);
});
