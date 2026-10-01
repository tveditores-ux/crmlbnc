'use strict';
const express = require('express');
const { adminRouter } = require('./routes/admin');
const { publicRouter } = require('./routes/public');
const { layout } = require('./views/layout');
const { esc } = require('./util');
const auth = require('./auth');

/**
 * Crea la aplicación Express.
 * ctx = { db (pg Pool), config, channels }
 */
function createApp(ctx) {
  const { db, config } = ctx;
  const app = express();
  const limiter = auth.createLoginLimiter();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway está detrás de un proxy

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Guardamos el cuerpo crudo para validar la firma de Meta.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));

  app.get('/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: 'db' });
    }
  });

  app.use(publicRouter(ctx));

  /* ---------- Inicio de sesión ---------- */
  const loginPage = (error) =>
    layout({
      title: 'Entrar',
      config,
      bare: true,
      body: `<form method="post" action="/entrar" class="card" style="max-width:380px;margin:40px auto">
        <h1>Entrar</h1><p class="sub">Panel de comunicación</p>
        ${error ? `<div class="flash err">${esc(error)}</div>` : ''}
        <label>Contraseña</label><input type="password" name="password" required autofocus autocomplete="current-password">
        <div class="actions"><button>Entrar</button></div></form>`,
    });

  app.get('/entrar', (req, res) => res.send(loginPage()));

  app.post('/entrar', (req, res) => {
    const ip = req.ip;
    if (limiter.blocked(ip)) return res.status(429).send(loginPage('Demasiados intentos. Espera 15 minutos.'));
    if (!auth.passwordMatches(req.body.password, config.adminPassword)) {
      limiter.fail(ip);
      return res.status(401).send(loginPage('Contraseña incorrecta.'));
    }
    limiter.clear(ip);
    const secure = config.publicUrl.startsWith('https://');
    res.setHeader(
      'Set-Cookie',
      `${auth.COOKIE}=${auth.makeSession(config.sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
        auth.MAX_AGE_MS / 1000
      }${secure ? '; Secure' : ''}`
    );
    res.redirect(303, '/');
  });

  app.post('/salir', (req, res) => {
    res.setHeader('Set-Cookie', `${auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(303, '/entrar');
  });

  // Todo lo demás requiere sesión.
  app.use((req, res, next) => {
    const cookies = auth.parseCookies(req.headers.cookie);
    if (auth.verifySession(cookies[auth.COOKIE], config.sessionSecret)) return next();
    if (req.method === 'GET') return res.redirect(303, '/entrar');
    res.sendStatus(401);
  });

  app.use(adminRouter(ctx));

  app.use((req, res) => res.status(404).send(layout({ title: 'No encontrado', config, body: '<h1>Página no encontrada</h1>' })));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res
      .status(500)
      .send(layout({ title: 'Error', config, body: `<h1>Algo salió mal</h1><p class="muted">${esc(err.message)}</p>` }));
  });

  return app;
}

module.exports = { createApp };
