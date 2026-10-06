'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const { formatShort } = require('../time');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Casos que el asistente escaló y registro de lo que se habló (solo con sesión). */
function conversationsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const tz = config.timezone;

  r.get(
    '/conversaciones',
    ah(async (req, res) => {
      const open = (
        await db.query(
          `SELECT m.id, m.phone, m.body, m.reason, m.created_at, p.full_name
             FROM agent_messages m LEFT JOIN people p ON p.id = m.person_id
            WHERE m.escalated AND NOT m.resolved ORDER BY m.created_at DESC LIMIT 100`
        )
      ).rows;
      const recent = (
        await db.query(
          `SELECT m.direction, m.body, m.created_at, m.phone, p.full_name
             FROM agent_messages m LEFT JOIN people p ON p.id = m.person_id
            ORDER BY m.id DESC LIMIT 60`
        )
      ).rows;
      const on = config.agent.enabled && config.agent.apiKey;

      const openRows = open
        .map(
          (o) => `<tr>
            <td>${esc(o.full_name || 'Desconocido')}<div class="muted">${esc(displayPhone(o.phone))}</div><div class="muted">${esc(formatShort(o.created_at, tz))}</div></td>
            <td>${esc(o.body)}</td><td>${esc(o.reason || '')}</td>
            <td><form class="inline" method="post" action="/conversaciones/${o.id}/atendido"><button class="small sec">Ya lo atendí</button></form></td></tr>`
        )
        .join('');
      const recentRows = recent
        .map(
          (m) => `<tr><td class="muted">${esc(formatShort(m.created_at, tz))}</td>
            <td>${esc(m.full_name || displayPhone(m.phone))}</td>
            <td>${m.direction === 'in' ? 'Escribió' : 'Asistente'}</td><td>${esc(m.body)}</td></tr>`
        )
        .join('');

      const body = `<h1>Conversaciones del asistente</h1>
        <p class="sub">El asistente ${on ? '<span class="badge b-ok">está activo</span>' : '<span class="badge b-bad">está apagado</span>'}
          y solo atiende temas de la congregación y los grupos de cuidado. Lo demás llega aquí para que lo atienda un líder o pastor.</p>
        <h2>Para atender (${open.length})</h2>
        <div class="table-scroll"><table><tr><th>Persona</th><th>Mensaje</th><th>Motivo</th><th></th></tr>${
          openRows || '<tr><td colspan="4" class="muted">Nada pendiente.</td></tr>'
        }</table></div>
        <h2>Últimos mensajes</h2>
        <div class="table-scroll"><table><tr><th>Cuándo</th><th>Persona</th><th></th><th>Texto</th></tr>${
          recentRows || '<tr><td colspan="4" class="muted">Sin mensajes todavía.</td></tr>'
        }</table></div>`;
      res.send(layout({ title: 'Conversaciones', active: '/conversaciones', body, config, query: req.query }));
    })
  );

  r.post(
    '/conversaciones/:id(\\d+)/atendido',
    ah(async (req, res) => {
      await db.query('UPDATE agent_messages SET resolved = TRUE WHERE id = $1', [+req.params.id]);
      res.redirect(303, '/conversaciones?ok=' + encodeURIComponent('Marcado como atendido.'));
    })
  );

  return r;
}

module.exports = { conversationsRouter };
