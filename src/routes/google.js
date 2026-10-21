'use strict';
const express = require('express');
const crypto = require('crypto');
const auth = require('../auth');
const { layout } = require('../views/layout');
const { esc } = require('../util');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STATE_COOKIE = 'oauth_state';

/** Valida las afirmaciones de un id_token recibido directamente de Google (TLS) en el intercambio del código. */
function validateIdToken(claims, clientId, now = Date.now()) {
  if (!claims || typeof claims !== 'object') return 'Respuesta de Google no válida.';
  if (claims.aud !== clientId) return 'La respuesta de Google no es para esta aplicación.';
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) return 'Emisor no válido.';
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return 'La respuesta de Google venció.';
  if (!claims.email || claims.email_verified !== true) return 'Tu correo de Google no está verificado.';
  return null;
}

function decodeJwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

function googleRouter(ctx, { fetchImpl = globalThis.fetch } = {}) {
  const { db, config } = ctx;
  const r = express.Router();
  const g = config.google;
  const redirectUri = g.callbackUrl || `${config.publicUrl}/auth/google/callback`;
  const secure = config.publicUrl.startsWith('https://');
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  const failPage = (res, msg, status = 403) =>
    res.status(status).send(
      layout({
        title: 'Entrar',
        config,
        bare: true,
        body: `<div class="card" style="max-width:420px;margin:40px auto"><h1>No se pudo entrar</h1>
          <div class="flash err">${esc(msg)}</div><div class="actions"><a class="btn sec" href="/entrar">Volver</a></div></div>`,
      })
    );

  r.get('/auth/google', (req, res) => {
    if (!g.clientId || !g.clientSecret) return res.status(404).send('Acceso con Google no configurado.');
    const state = crypto.randomBytes(24).toString('base64url');
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieFlags}; Max-Age=600`);
    const q = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      prompt: 'select_account',
    });
    res.redirect(303, `https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  });

  r.get(
    '/auth/google/callback',
    ah(async (req, res) => {
      if (!g.clientId || !g.clientSecret) return res.status(404).send('Acceso con Google no configurado.');
      const cookies = auth.parseCookies(req.headers.cookie);
      res.setHeader('Set-Cookie', `${STATE_COOKIE}=; ${cookieFlags}; Max-Age=0`);
      const expected = Buffer.from(String(cookies[STATE_COOKIE] || ''));
      const given = Buffer.from(String(req.query.state || ''));
      if (!expected.length || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        return failPage(res, 'La sesión de inicio expiró. Inténtalo de nuevo.');
      }
      if (req.query.error || !req.query.code) return failPage(res, 'Google no confirmó el inicio de sesión.');

      let claims;
      try {
        const resp = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: String(req.query.code),
            client_id: g.clientId,
            client_secret: g.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.id_token) return failPage(res, 'Google rechazó el inicio de sesión.');
        claims = decodeJwtPayload(data.id_token);
      } catch (err) {
        console.error('[google] error:', err.message);
        return failPage(res, 'No se pudo hablar con Google. Inténtalo en un momento.', 502);
      }
      const problem = validateIdToken(claims, g.clientId);
      if (problem) return failPage(res, problem);

      const email = String(claims.email).toLowerCase();
      let session;
      if ((g.adminEmails || []).includes(email)) {
        session = auth.makeSession(config.sessionSecret, Date.now(), { role: 'admin', pid: null });
      } else {
        const { rows } = await db.query(
          `SELECT id, full_name, access_level, active FROM people WHERE lower(google_email) = lower($1) LIMIT 1`,
          [email]
        );
        const p = rows[0];
        if (!p || !p.active || p.access_level !== 'admin') {
          return failPage(res, 'Este correo no tiene acceso al panel. Pídele a un pastor que lo agregue en tu ficha.');
        }
        session = auth.makeSession(config.sessionSecret, Date.now(), { role: p.access_level, pid: p.id });
      }
      res.setHeader('Set-Cookie', [
        `${auth.COOKIE}=${session}; ${cookieFlags}; Max-Age=${auth.MAX_AGE_MS / 1000}`,
        `${STATE_COOKIE}=; ${cookieFlags}; Max-Age=0`,
      ]);
      res.redirect(303, '/');
    })
  );

  return r;
}

module.exports = { googleRouter, validateIdToken, decodeJwtPayload };
