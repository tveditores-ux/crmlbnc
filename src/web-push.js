'use strict';
const crypto = require('node:crypto');

/**
 * Web Push sin dependencias (RFC 8291 + RFC 8188 «aes128gcm» + VAPID RFC 8292), para avisar desde la
 * propia app del chat de líderes cuando alguien escribe: no usa WhatsApp ni plantillas de Meta.
 * Las claves VAPID se generan una vez y quedan en care_settings (la pública va al navegador; la
 * privada nunca sale del servidor). El cifrado se verifica en las pruebas con la vuelta completa
 * (cifrar aquí y descifrar como lo haría el navegador).
 */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

/** Genera el par VAPID (P-256). publicKey = punto sin comprimir (0x04‖x‖y) en base64url; privateKey = d. */
function generateVapidKeys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = pair.publicKey.export({ format: 'jwk' });
  const priv = pair.privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([0x04]), fromB64u(pub.x), fromB64u(pub.y)]);
  return { publicKey: b64u(point), privateKey: priv.d };
}

const VAPID_PUBLIC = 'chat_vapid_public';
const VAPID_PRIVATE = 'chat_vapid_private';

/** Lee las claves VAPID de care_settings; si no hay, genera y guarda el par. */
async function ensureVapid(db) {
  const { rows } = await db.query('SELECT key, value FROM care_settings WHERE key IN ($1, $2)', [VAPID_PUBLIC, VAPID_PRIVATE]);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (map[VAPID_PUBLIC] && map[VAPID_PRIVATE]) return { publicKey: map[VAPID_PUBLIC], privateKey: map[VAPID_PRIVATE] };
  const keys = generateVapidKeys();
  await db.query("INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [VAPID_PUBLIC, keys.publicKey]);
  await db.query("INSERT INTO care_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [VAPID_PRIVATE, keys.privateKey]);
  const again = await db.query('SELECT key, value FROM care_settings WHERE key IN ($1, $2)', [VAPID_PUBLIC, VAPID_PRIVATE]);
  const m2 = Object.fromEntries(again.rows.map((r) => [r.key, r.value]));
  return { publicKey: m2[VAPID_PUBLIC], privateKey: m2[VAPID_PRIVATE] };
}

function privateKeyObject(publicKeyB64u, privateKeyB64u) {
  const point = fromB64u(publicKeyB64u);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(point.subarray(1, 33)),
    y: b64u(point.subarray(33, 65)),
    d: privateKeyB64u,
  };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/** JWT de VAPID (ES256) para el servicio de push del navegador. */
function vapidJwt(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKeyObject(keys.publicKey, keys.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

// HKDF (RFC 5869) con extract/expand explícitos: Web Push los encadena de una forma particular.
const hkdfExtract = (salt, ikm) => crypto.createHmac('sha256', salt).update(ikm).digest();
const hkdfExpand = (prk, info, len) =>
  crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest()
    .subarray(0, len);

/**
 * Cifra el cuerpo para una suscripción (aes128gcm, RFC 8188 + RFC 8291).
 * subscription = { endpoint, keys: { p256dh, auth } } como la entrega el navegador.
 */
function encryptPayload(payload, subscription) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  const salt = crypto.randomBytes(16);

  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey(null, 'uncompressed');
  const ecdhSecret = as.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hkdfExpand(hkdfExtract(authSecret, ecdhSecret), keyInfo, 32);

  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(String(payload), 'utf8'), Buffer.from([0x02])]); // 0x02 = último registro
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, encrypted]);
}

/**
 * Envía un push. Devuelve el estado HTTP; 404/410 significan que la suscripción ya no existe.
 * fetchImpl inyectable para las pruebas.
 */
async function sendPush(fetchImpl, subscription, payload, keys, subject) {
  const body = encryptPayload(payload, subscription);
  const jwt = vapidJwt(subscription.endpoint, keys, subject);
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
    },
    body,
  });
  return res.status;
}

module.exports = { generateVapidKeys, ensureVapid, vapidJwt, encryptPayload, sendPush, VAPID_PUBLIC, VAPID_PRIVATE, fromB64u, b64u };
