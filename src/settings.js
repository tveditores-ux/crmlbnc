'use strict';
const crypto = require('crypto');
const { createChannels } = require('./channels');

/**
 * Configuración desde el panel (claves de WeCall) para no tener que entrar a Railway.
 *  - Lo guardado en el panel manda; si no hay nada guardado, vale la variable de Railway (WECALL_*, WHATSAPP_PROVIDER).
 *  - Las claves se guardan CIFRADAS en la base (AES-256-GCM, llave derivada de SESSION_SECRET) y nunca se vuelven a mostrar:
 *    la pantalla solo dice de dónde sale cada una (panel, Railway o falta).
 *  - Al guardar, el cambio se aplica al instante (config y canal de WhatsApp), sin reiniciar.
 *  - NO maneja DRY_RUN ni ningún otro interruptor de seguridad: eso se sigue cambiando en Railway.
 */
const FIELDS = {
  whatsappProvider: { env: 'WHATSAPP_PROVIDER', label: 'Proveedor de WhatsApp', secret: false },
  wecallBaseUrl: { env: 'WECALL_BASE_URL', label: 'Dirección de la API de WeCall', secret: false },
  wecallApiKey: { env: 'WECALL_API_KEY', label: 'API key de WeCall', secret: true },
  wecallWebhookSecret: { env: 'WECALL_WEBHOOK_SECRET', label: 'Webhook secret de WeCall', secret: true },
};
const PROVIDERS = ['meta', 'wecall'];
const MAX_SECRET = 300;

/* ---------------------------- cifrado ---------------------------- */
const keyFor = (sessionSecret) => crypto.createHash('sha256').update(`lbnc-settings-v1|${sessionSecret}`).digest();

function encrypt(text, sessionSecret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(sessionSecret), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `enc1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}
/** Devuelve el texto, o null si no se puede descifrar (otra SESSION_SECRET, dato alterado). */
function decrypt(stored, sessionSecret) {
  try {
    if (!String(stored).startsWith('enc1:')) return null;
    const raw = Buffer.from(String(stored).slice(5), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(sessionSecret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/* ---------------------------- validación ---------------------------- */
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.internal|.*\.local|0\.0\.0\.0|\[?::1?\]?|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*)$/i;

/** La dirección de la API: https y de un servidor público (no se permite apuntar a la red interna). Devuelve { value } o { error }. */
function parseBaseUrl(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!s) return { value: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: 'La dirección de la API no es válida (ejemplo: https://wecall.ejemplo.com).' };
  }
  if (u.protocol !== 'https:') return { error: 'La dirección de la API debe empezar con https://' };
  if (PRIVATE_HOST.test(u.hostname)) return { error: 'Esa dirección apunta a una red interna; usa la dirección pública de WeCall.' };
  if (u.username || u.password) return { error: 'La dirección no debe llevar usuario ni clave.' };
  return { value: `${u.origin}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}` };
}

function parseSecret(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return { value: '' };
  if (/\s/.test(s)) return { error: `${label}: no debe tener espacios ni saltos de línea (revisa que pegaste solo la clave).` };
  if (s.length > MAX_SECRET) return { error: `${label}: es demasiado larga.` };
  return { value: s };
}

/* ---------------------------- almacenamiento ---------------------------- */
async function loadStored(db, sessionSecret) {
  const { rows } = await db.query('SELECT key, value, secret FROM app_settings');
  const out = {};
  for (const r of rows) {
    if (!FIELDS[r.key]) continue;
    const value = r.secret ? decrypt(r.value, sessionSecret) : r.value;
    out[r.key] = { value, unreadable: value === null };
  }
  return out;
}
async function setValue(db, sessionSecret, key, value) {
  const f = FIELDS[key];
  if (!f) throw new Error('clave desconocida');
  const stored = f.secret ? encrypt(value, sessionSecret) : value;
  await db.query(
    `INSERT INTO app_settings (key, value, secret, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret = EXCLUDED.secret, updated_at = now()`,
    [key, stored, f.secret]
  );
}
const removeValue = (db, key) => db.query('DELETE FROM app_settings WHERE key = $1', [key]);

/* ---------------------------- aplicar a la app ---------------------------- */
/**
 * Calcula la configuración efectiva (lo guardado en el panel sobre lo de Railway) y la aplica a ctx.config y ctx.channels.
 * Siempre parte de lo que dijeron las variables de Railway al arrancar, así borrar algo del panel devuelve a Railway.
 */
async function apply(ctx) {
  const { db, config } = ctx;
  if (!config._env) {
    config._env = { whatsappProvider: config.whatsappProvider, wecall: { ...config.wecall } };
  }
  const stored = await loadStored(db, config.sessionSecret);
  const pick = (key, envValue) => (stored[key] && !stored[key].unreadable && stored[key].value ? stored[key].value : envValue);
  const provider = pick('whatsappProvider', config._env.whatsappProvider);
  config.whatsappProvider = PROVIDERS.includes(provider) ? provider : 'meta';
  config.wecall.baseUrl = pick('wecallBaseUrl', config._env.wecall.baseUrl);
  config.wecall.apiKey = pick('wecallApiKey', config._env.wecall.apiKey);
  config.wecall.webhookSecret = pick('wecallWebhookSecret', config._env.wecall.webhookSecret);
  // el canal se reconstruye con la configuración nueva; quien lo usa lo lee de ctx.channels en cada envío
  const fresh = createChannels(config, { fetchImpl: ctx.fetchImpl });
  ctx.channels.whatsapp = fresh.whatsapp;
  ctx.channels.dryRun = fresh.dryRun;
  return stored;
}

/** De dónde sale cada campo: 'panel' | 'railway' | 'falta' | 'ilegible' (guardada con otra SESSION_SECRET). */
function sourceOf(key, stored, config) {
  if (stored[key] && stored[key].unreadable) return 'ilegible';
  if (stored[key] && stored[key].value) return 'panel';
  const env = config._env || { whatsappProvider: config.whatsappProvider, wecall: config.wecall };
  const v = key === 'whatsappProvider' ? env.whatsappProvider : { wecallBaseUrl: env.wecall.baseUrl, wecallApiKey: env.wecall.apiKey, wecallWebhookSecret: env.wecall.webhookSecret }[key];
  return v ? 'railway' : 'falta';
}

/* ---------------------------- probar la conexión ---------------------------- */
/**
 * Prueba la API key con una consulta de solo lectura (la ficha de un contacto que no existe): 401/403 = clave mala,
 * 404 o 200 = la clave sirve. No envía ningún mensaje.
 */
async function testWeCall(wecall, fetchImpl = globalThis.fetch) {
  if (!wecall.baseUrl || !wecall.apiKey) return { ok: false, text: 'Faltan la dirección de la API o la API key.' };
  try {
    const res = await fetchImpl(`${wecall.baseUrl}/api/v1/contactos/584000000000/contexto/`, {
      headers: { Authorization: `Bearer ${wecall.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, text: 'WeCall rechazó la API key (¿está bien copiada?).' };
    if (res.status === 404 || res.ok) return { ok: true, text: 'Conexión correcta: WeCall aceptó la API key.' };
    return { ok: false, text: `WeCall respondió ${res.status}; revisa la dirección de la API.` };
  } catch (err) {
    return { ok: false, text: `No se pudo llegar a WeCall (${err && err.name === 'TimeoutError' ? 'tardó demasiado' : 'revisa la dirección'}).` };
  }
}

module.exports = { FIELDS, PROVIDERS, encrypt, decrypt, parseBaseUrl, parseSecret, loadStored, setValue, removeValue, apply, sourceOf, testWeCall };
