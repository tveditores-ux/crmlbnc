'use strict';
const express = require('express');
const chat = require('../chat-lideres');
const webpush = require('../web-push');
const agent = require('../agent');
const prayer = require('../prayer');
const { iconPng } = require('../chat-icon');
const { chatPage, invalidPage, manifest, serviceWorkerJs } = require('../views/chat-lideres');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_TEXT = 1000;
const HOURLY_LIMIT = 30; // mensajes por hora y por persona en la sala

const firstName = (name) => String(name || '').split(' ')[0];

/**
 * La app del chat de líderes (/chat/<token>): el token es personal y hace de sesión.
 * La sala es una sola; Grace participa cuando le preguntan (botón o «Grace…» al inicio),
 * con el límite diario por persona que fije el panel, y responde con el contexto de quien
 * pregunta (su grupo, sus ministerios, sus eventos) — nunca con datos de otras personas.
 */
function chatLideresRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();

  const resolve = async (req, res, next) => {
    const found = await chat.byToken(db, req.params.token);
    if (!found) {
      if (req.method === 'GET' && !/\.(json|js|png|webmanifest)$/.test(req.path)) return res.status(404).send(invalidPage());
      return res.status(404).json({ error: 'Enlace no válido.' });
    }
    req.chatPerson = found.person;
    req.chatToken = found.token;
    next();
  };

  r.get('/chat/:token', resolve, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.send(chatPage({ config, person: req.chatPerson, token: req.chatToken }));
  });

  r.get('/chat/:token/manifest.webmanifest', resolve, (req, res) => {
    res.type('application/manifest+json').send(manifest({ config, token: req.chatToken }));
  });

  r.get('/chat/:token/sw.js', resolve, (req, res) => {
    res.type('application/javascript').send(serviceWorkerJs());
  });

  r.get('/chat/:token/icono-192.png', resolve, (req, res) => res.type('image/png').send(iconPng(192)));
  r.get('/chat/:token/icono-512.png', resolve, (req, res) => res.type('image/png').send(iconPng(512)));

  r.get(
    '/chat/:token/vapid',
    resolve,
    ah(async (req, res) => {
      const keys = await webpush.ensureVapid(db);
      res.json({ publicKey: keys.publicKey });
    })
  );

  const limiteInfo = async (personId) => {
    const limite = await chat.getGraceLimit(db);
    const usadas = await chat.graceAskedToday(db, personId, config.timezone);
    return { limite, usadas, restantes: Math.max(0, limite - usadas) };
  };

  r.get(
    '/chat/:token/mensajes',
    resolve,
    ah(async (req, res) => {
      const desde = Math.max(0, parseInt(req.query.desde, 10) || 0);
      const mensajes = desde === 0 ? await chat.recentMessages(db, 60) : await chat.listMessages(db, { sinceId: desde, limit: 100 });
      const miembros = await chat.members(db);
      res.json({ mensajes, miembros: miembros.length, yo_id: req.chatPerson.id, limite: await limiteInfo(req.chatPerson.id) });
    })
  );

  r.post(
    '/chat/:token/leido',
    resolve,
    ah(async (req, res) => {
      const hasta = Math.max(0, parseInt((req.body && req.body.hasta) || 0, 10) || 0);
      if (hasta > 0) await chat.markRead(db, req.chatPerson.id, hasta);
      res.json({ ok: true });
    })
  );

  r.post(
    '/chat/:token/push',
    resolve,
    ah(async (req, res) => {
      const sub = req.body && req.body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return res.status(400).json({ error: 'Suscripción no válida.' });
      }
      await chat.saveSubscription(db, req.chatPerson.id, sub);
      res.json({ ok: true });
    })
  );

  r.post(
    '/chat/:token/mensaje',
    resolve,
    ah(async (req, res) => {
      const person = req.chatPerson;
      const texto = String((req.body && req.body.texto) || '').trim().slice(0, MAX_TEXT);
      if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
      if ((await chat.countLastHour(db, person.id)) >= HOURLY_LIMIT) {
        return res.status(429).json({ error: 'Vas muy rápido: espera un poco antes de seguir escribiendo.' });
      }

      // Crisis: no se publica en la sala ni cuenta para el límite; la persona recibe la
      // respuesta de crisis solo para ella, en privado (la ve en su pantalla, no queda en la sala).
      if (agent.isCrisis(texto)) {
        return res.json({ crisis: agent.CRISIS_REPLY, mensajes: [], limite: await limiteInfo(person.id) });
      }

      const quiereGrace = Boolean(req.body && req.body.para_grace) || /^\s*@?grace\b/i.test(texto);
      const pregunta = texto.replace(/^\s*@?grace[,:\s]*/i, '').trim() || texto;
      const nuevos = [];
      const propio = await chat.postMessage(db, { personId: person.id, authorName: person.full_name, kind: 'persona', body: texto });
      nuevos.push({ id: propio.id, person_id: person.id, author_name: person.full_name, kind: 'persona', pregunta_de: null, body: texto, created_at: propio.created_at });
      await chat.markRead(db, person.id, propio.id);

      let aviso = '';
      let respondioGrace = false;
      if (quiereGrace) {
        const info = await limiteInfo(person.id);
        if (!config.agent.apiKey) aviso = 'Grace todavía no puede responder: falta la clave del modelo en el panel.';
        else if (info.restantes <= 0) aviso = `Ya usaste tus ${info.limite} preguntas a Grace de hoy. Mañana se renuevan.`;
        else {
          try {
            const base = await agent.buildContext(db, config, person, new Date(), person.phone);
            const recientes = await chat.recentMessages(db, 12);
            const transcripcion = recientes
              .map((m) => (m.kind === 'grace' ? `Grace: ${m.body}` : `${firstName(m.author_name)}: ${m.body}`))
              .join('\n');
            const context = `${base}\nCanal: chat de líderes de la iglesia (una sala donde los líderes conversan entre ellos). Responde solo a la pregunta de ${firstName(person.full_name)}.\nConversación reciente de la sala:\n${transcripcion}`;
            const g = await agent.generate(config, { context, history: [], message: pregunta }, ctx.fetchImpl);
            let respuesta;
            let escalar = false;
            if (g.blocked) {
              respuesta = agent.FALLBACK_REPLY;
              escalar = true;
            } else {
              respuesta = g.out.reply;
              escalar = Boolean(g.out.escalate);
            }
            const gm = await chat.postMessage(db, { authorName: 'Grace', kind: 'grace', preguntaDe: person.id, body: respuesta });
            nuevos.push({ id: gm.id, person_id: null, author_name: 'Grace', kind: 'grace', pregunta_de: person.id, body: respuesta, created_at: gm.created_at });
            respondioGrace = true;
            if (escalar) {
              await prayer.fromAgent(db, { person, text: pregunta, reason: (g.out && g.out.reason) || 'Grace escaló desde el chat de líderes' }).catch(() => {});
            }
          } catch (err) {
            console.error('[chat líderes] Grace no pudo responder:', err.message);
            aviso = 'Grace no pudo responder ahora. Inténtalo en un momento.';
          }
        }
      }

      // Avisos de la app: a los demás por el mensaje nuevo; a quien preguntó, cuando Grace le responde.
      const extracto = texto.length > 90 ? `${texto.slice(0, 90)}…` : texto;
      chat
        .notifyRoom(ctx, {
          exceptPersonId: person.id,
          title: 'Chat de líderes',
          bodyText: `${firstName(person.full_name)}: ${extracto}`,
        })
        .catch(() => {});
      if (respondioGrace) {
        chat
          .notifyRoom(ctx, {
            urgentFor: person.id,
            title: 'Grace respondió tu pregunta',
            bodyText: 'Abre el chat de líderes para ver su respuesta.',
          })
          .catch(() => {});
      }

      res.json({ mensajes: nuevos, aviso, limite: await limiteInfo(person.id) });
    })
  );

  return r;
}

module.exports = { chatLideresRouter, HOURLY_LIMIT };
