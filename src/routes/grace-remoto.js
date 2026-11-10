'use strict';
const express = require('express');
const auth = require('../auth');
const agent = require('../agent');
const pastoral = require('../agent-pastoral');
const { gracePage, DEFAULT_AVATAR } = require('../views/grace-remoto');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_TEXT = 1000;
const HOURLY_LIMIT = 60; // mensajes por hora y por persona (cada uno es una consulta al modelo)
const MAX_AVATAR = 400 * 1024;
const MIMES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

/**
 * Control remoto de Grace: una pantalla de chat (estilo WhatsApp) dentro del CRM para consultar la información de la iglesia.
 * Usa el modo pastoral de Grace (herramientas de solo lectura), así que es SOLO para administración: la clave de emergencia o
 * un acceso de Google con nivel admin. Un coordinador recibe 403. La conversación se guarda en remote_chat por persona.
 */
function graceRemotoRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();

  r.use('/grace', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = auth.readSession(auth.parseCookies(req.headers.cookie)[auth.COOKIE], config.sessionSecret);
    if (!s) return req.method === 'GET' ? res.redirect(303, '/entrar') : res.sendStatus(401);
    if (s.role && s.role !== 'admin') return res.status(403).send('Solo administración puede usar el control remoto de Grace.');
    if (req.method !== 'GET') {
      // solo desde esta misma página (contra envíos desde otros sitios)
      const origin = req.get('origin');
      let host = '';
      try {
        host = origin ? new URL(origin).host : req.get('host');
      } catch {
        /* origen ilegible */
      }
      if (host !== req.get('host')) return res.sendStatus(403);
    }
    req.graceUser = s.pid ? `p:${s.pid}` : 'admin';
    req.gracePid = s.pid || null;
    next();
  });

  r.get('/grace', (req, res) => res.send(gracePage({ config })));

  r.get(
    '/grace/historial',
    ah(async (req, res) => {
      const { rows } = await db.query(
        `SELECT direction, body, created_at FROM (SELECT * FROM remote_chat WHERE user_key = $1 ORDER BY id DESC LIMIT 60) t ORDER BY created_at, direction`,
        [req.graceUser]
      );
      res.json({ mensajes: rows.map((m) => ({ de: m.direction === 'in' ? 'yo' : 'grace', texto: m.body, cuando: m.created_at })), listo: Boolean(config.agent.apiKey) });
    })
  );

  r.post(
    '/grace/mensaje',
    ah(async (req, res) => {
      const texto = String((req.body && req.body.texto) || '').trim().slice(0, MAX_TEXT);
      if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
      if (!config.agent.apiKey) return res.status(503).json({ error: 'Falta la clave del modelo en Configuración → Asistente.' });
      const { rows: cnt } = await db.query(
        `SELECT count(*)::int AS c FROM remote_chat WHERE user_key = $1 AND direction = 'in' AND created_at > now() - interval '1 hour'`,
        [req.graceUser]
      );
      if (cnt[0].c >= HOURLY_LIMIT) return res.status(429).json({ error: 'Llegaste al límite de mensajes de esta hora. Intenta un poco más tarde.' });

      const history = (
        await db.query(`SELECT direction, body FROM remote_chat WHERE user_key = $1 AND created_at > now() - interval '12 hours' ORDER BY id DESC LIMIT 10`, [req.graceUser])
      ).rows.reverse();
      await db.query(`INSERT INTO remote_chat (user_key, direction, body) VALUES ($1, 'in', $2)`, [req.graceUser, texto]);

      const now = new Date();
      let person = null;
      if (req.gracePid) person = (await db.query('SELECT id, full_name, role FROM people WHERE id = $1', [req.gracePid])).rows[0] || null;
      let respuesta;
      let escalar = false;
      try {
        const base = await agent.buildContext(db, config, person || { id: -1, full_name: 'Pastor', role: 'administración del CRM' }, now, null);
        const context = await pastoral.pastoralContext(db, `${base}\nCanal: control remoto del CRM (pantalla de chat), con sesión de administración.`);
        const g = await agent.generatePastoral(ctx, { context, history, message: texto, now }, ctx.fetchImpl);
        if (g.blocked) respuesta = 'Esa respuesta traía un dato que no puedo mostrar por aquí (un enlace o un teléfono). Pregúntamelo de otra forma.';
        else {
          respuesta = g.out.reply;
          escalar = Boolean(g.out.escalate);
        }
      } catch (err) {
        console.error('[grace remoto] error:', err.message);
        return res.status(502).json({ error: 'Grace no pudo responder ahora. Intenta de nuevo en un momento.' });
      }
      await db.query(`INSERT INTO remote_chat (user_key, direction, body) VALUES ($1, 'out', $2)`, [req.graceUser, respuesta]);
      res.json({ respuesta, escalar });
    })
  );

  r.post(
    '/grace/limpiar',
    ah(async (req, res) => {
      await db.query('DELETE FROM remote_chat WHERE user_key = $1', [req.graceUser]);
      res.json({ ok: true });
    })
  );

  r.get(
    '/grace/avatar',
    ah(async (req, res) => {
      const row = (await db.query('SELECT mime, data FROM remote_avatar WHERE id = 1')).rows[0];
      res.setHeader('Cache-Control', 'private, no-cache');
      if (!row) return res.type('image/svg+xml').send(DEFAULT_AVATAR);
      res.type(row.mime).send(Buffer.from(row.data));
    })
  );

  r.post(
    '/grace/avatar',
    ah(async (req, res) => {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.imagen) || ''));
      if (!m) return res.status(400).json({ error: 'La imagen debe ser PNG, JPG o WebP.' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > MAX_AVATAR) return res.status(400).json({ error: 'La imagen es muy pesada (máximo 400 KB).' });
      const magic = MIMES[m[1]];
      if (!magic.every((b, i) => buf[i] === b)) return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
      await db.query(
        `INSERT INTO remote_avatar (id, mime, data, updated_at) VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`,
        [m[1], buf]
      );
      res.json({ ok: true });
    })
  );

  r.post(
    '/grace/avatar/borrar',
    ah(async (req, res) => {
      await db.query('DELETE FROM remote_avatar WHERE id = 1');
      res.json({ ok: true });
    })
  );

  return r;
}

module.exports = { graceRemotoRouter, HOURLY_LIMIT };
