'use strict';
const crypto = require('crypto');

const COOKIE = 'sesion';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 horas

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + MAX_AGE_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function verifySession(cookieValue, secret, now = Date.now()) {
  if (!cookieValue || typeof cookieValue !== 'string') return false;
  const [payload, sig] = cookieValue.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function passwordMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return expected.length > 0 && crypto.timingSafeEqual(a, b);
}

/** Limitador simple de intentos de inicio de sesión por IP (en memoria). */
function createLoginLimiter({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || h.reset < now) return false;
      return h.count >= max;
    },
    fail(ip, now = Date.now()) {
      const h = hits.get(ip);
      if (!h || h.reset < now) hits.set(ip, { count: 1, reset: now + windowMs });
      else h.count++;
    },
    clear(ip) {
      hits.delete(ip);
    },
  };
}

module.exports = { COOKIE, MAX_AGE_MS, makeSession, verifySession, parseCookies, passwordMatches, createLoginLimiter };
