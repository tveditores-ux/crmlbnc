'use strict';
const express = require('express');
const auth = require('../auth');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const settings = require('../settings');
const prayer = require('../prayer');
const { CONGREGATIONS } = require('../care-groups');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Buzón de oración (/oracion): las peticiones que llegan por Grace o se escriben aquí, y su envío por WhatsApp al líder del
 * grupo de cuidado o al pastor de la congregación. Son datos pastorales: SOLO administración (clave de emergencia o Google
 * admin; coordinador 403) y los envíos deben venir de esta misma página. Nada se envía sin que alguien lo pida.
 */
function oracionRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const go = (res, flash, path = '/oracion') => res.redirect(303, `${path}?${new URLSearchParams(flash).toString()}`);

  r.use('/oracion', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = auth.readSession(auth.parseCookies(req.headers.cookie)[auth.COOKIE], config.sessionSecret);
    if (!s) return req.method === 'GET' ? res.redirect(303, '/entrar') : res.sendStatus(401);
    if (s.role && s.role !== 'admin') return res.status(403).send('Solo administración puede usar el buzón de oración.');
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      let host = '';
      try {
        host = origin ? new URL(origin).host : req.get('host');
      } catch {
        /* origen ilegible */
      }
      if (host !== req.get('host')) return res.sendStatus(403);
    }
    next();
  });

  const groups = async () => (await db.query('SELECT id, name, leader_name, congregation FROM care_groups WHERE active ORDER BY name')).rows;
  // si se eligió grupo y no congregación, vale la del grupo
  const withGroupCongregation = (v, gs) => {
    if (v.care_group_id && !v.congregation) {
      const g = gs.find((x) => x.id === v.care_group_id);
      if (g && CONGREGATIONS.includes(g.congregation)) v.congregation = g.congregation;
    }
    return v;
  };
  const sentFlash = (results) => {
    const ok = results.filter((x) => x.ok).map((x) => x.name);
    const bad = results.filter((x) => !x.ok).map((x) => `${x.name || (x.to === 'lider' ? 'líder' : 'pastor')}: ${x.detail}`);
    return { ...(ok.length ? { ok: `Enviada a ${ok.join(' y ')}.` } : {}), ...(bad.length ? { err: `No se pudo enviar a ${bad.join('; ')}.` } : {}) };
  };

  r.get(
    '/oracion',
    ah(async (req, res) => {
      const estado = ['nueva', 'enviada', 'archivada', 'todas'].includes(req.query.estado) ? req.query.estado : 'abiertas';
      const where = { abiertas: "r.status <> 'archivada'", todas: 'TRUE' }[estado] || 'r.status = $1';
      const params = ['nueva', 'enviada', 'archivada'].includes(estado) ? [estado] : [];
      const rows = (
        await db.query(
          `SELECT r.*, g.name AS group_name, g.leader_name, to_char(r.created_at AT TIME ZONE $${params.length + 1}, 'DD/MM/YYYY HH24:MI') AS cuando
             FROM prayer_requests r LEFT JOIN care_groups g ON g.id = r.care_group_id
            WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`,
          [...params, config.timezone]
        )
      ).rows;
      const counts = Object.fromEntries((await db.query('SELECT status, count(*)::int AS n FROM prayer_requests GROUP BY 1')).rows.map((x) => [x.status, x.n]));
      const sends = rows.length
        ? (await db.query(`SELECT request_id, to_kind, to_name, result, detail, to_char(created_at AT TIME ZONE $2, 'DD/MM HH24:MI') AS cuando FROM prayer_sends WHERE request_id = ANY($1::int[]) ORDER BY id`, [rows.map((x) => x.id), config.timezone])).rows
        : [];
      const pastors = Object.fromEntries((await db.query('SELECT congregation, name, phone FROM congregation_pastors')).rows.map((p) => [p.congregation, p]));
      const gs = await groups();

      const groupSelect = (cur) =>
        `<select name="care_group_id"><option value="">Sin grupo</option>${gs
          .map((g) => `<option value="${g.id}" ${g.id === cur ? 'selected' : ''}>${esc(g.name)}${g.leader_name ? ` · ${esc(g.leader_name)}` : ''}</option>`)
          .join('')}</select>`;
      const congSelect = (cur) =>
        `<select name="congregation"><option value="">Sin congregación</option>${CONGREGATIONS.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
      const badge = { nueva: 'b-warn', enviada: 'b-ok', archivada: 'b-muted' };

      const cards = rows
        .map((q) => {
          const pastor = pastors[q.congregation];
          const hist = sends
            .filter((s) => s.request_id === q.id)
            .map((s) => `<li>${esc(s.cuando)} · ${s.to_kind === 'lider' ? 'Líder' : 'Pastor'} ${esc(s.to_name)}: ${s.result === 'enviado' ? `<span class="badge b-ok">${esc(s.detail || 'enviado')}</span>` : `<span class="badge b-bad">${esc(s.detail)}</span>`}</li>`)
            .join('');
          return `<form method="post" action="/oracion/${q.id}/enviar" class="card">
            <p style="margin:0 0 6px"><span class="badge ${badge[q.status]}">${prayer.STATUSES[q.status]}</span>
              <strong>${prayer.KINDS[q.kind]}</strong>${q.requester_name ? ` de ${esc(q.requester_name)}` : ''}
              <span class="muted">· ${esc(q.cuando)} · ${q.source === 'whatsapp' ? 'llegó por Grace (WhatsApp)' : 'escrita en el panel'}</span></p>
            <p style="white-space:pre-wrap;margin:0 0 10px">${esc(q.body)}</p>
            <div class="row"><div><label>Grupo de cuidado</label>${groupSelect(q.care_group_id)}</div><div><label>Congregación</label>${congSelect(q.congregation)}</div></div>
            <div class="actions">
              <label class="check" style="margin:0"><input type="checkbox" name="to" value="lider" ${q.care_group_id ? 'checked' : ''}> Al líder del grupo${q.leader_name ? ` (${esc(q.leader_name)})` : ''}</label>
              <label class="check" style="margin:0"><input type="checkbox" name="to" value="pastor"> Al pastor de la congregación${pastor && pastor.name ? ` (${esc(pastor.name)})` : ''}</label>
              <button class="small">Enviar por WhatsApp</button>
              <button class="small sec" formaction="/oracion/${q.id}/guardar">Solo guardar cambios</button>
              ${q.status === 'archivada' ? `<button class="small sec" formaction="/oracion/${q.id}/reabrir">Reabrir</button>` : `<button class="small sec" formaction="/oracion/${q.id}/archivar">Archivar</button>`}
            </div>
            ${hist ? `<ul class="muted" style="font-size:13px;margin:8px 0 0">${hist}</ul>` : ''}
          </form>`;
        })
        .join('');

      const pills = [['abiertas', 'Abiertas', (counts.nueva || 0) + (counts.enviada || 0)], ['nueva', 'Nuevas', counts.nueva || 0], ['enviada', 'Enviadas', counts.enviada || 0], ['archivada', 'Archivadas', counts.archivada || 0], ['todas', 'Todas', Object.values(counts).reduce((a, b) => a + b, 0)]]
        .map(([k, l, n]) => `<a class="btn ${estado === k ? '' : 'sec'} small" href="/oracion${k === 'abiertas' ? '' : `?estado=${k}`}">${l} <strong>${n}</strong></a>`)
        .join(' ');

      const pastorRows = CONGREGATIONS.map((c, i) => {
        const p = pastors[c] || {};
        return `<tr><td>${esc(c)}</td><td><input type="text" name="name_${i}" value="${esc(p.name || '')}" maxlength="${prayer.MAX.name}" placeholder="Nombre"></td>
          <td><input type="tel" name="phone_${i}" value="${esc(p.phone || '')}" placeholder="0412-0000000"></td></tr>`;
      }).join('');
      const tpl = config.agent.prayerTemplate || '';

      const body = `<h1>Buzón de oración</h1>
        <p class="sub">Peticiones de oración e información para el liderazgo. Las que Grace recibe por WhatsApp llegan aquí solas; también puedes escribir una. Desde cada una la envías por WhatsApp al líder de su grupo de cuidado o al pastor de su congregación. Nada se envía sin que lo pidas.</p>
        <form method="post" action="/oracion" class="card">
          <h3 style="margin-top:0">Nueva petición o información</h3>
          <div class="row">
            <div><label>Tipo</label><select name="kind">${Object.entries(prayer.KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
            <div><label>Quién la pide (opcional)</label><input type="text" name="requester_name" maxlength="${prayer.MAX.name}"></div></div>
          <label>Petición o información</label><textarea name="body" maxlength="${prayer.MAX.body}" required style="min-height:90px"></textarea>
          <div class="row"><div><label>Grupo de cuidado</label>${groupSelect(null)}</div><div><label>Congregación (si eliges grupo, se toma la del grupo)</label>${congSelect('')}</div></div>
          <div class="actions">
            <label class="check" style="margin:0"><input type="checkbox" name="to" value="lider"> Enviar ya al líder del grupo</label>
            <label class="check" style="margin:0"><input type="checkbox" name="to" value="pastor"> Enviar ya al pastor de la congregación</label>
            <button>Guardar</button></div></form>
        <div class="actions" style="margin:18px 0 6px">${pills}</div>
        ${cards || '<p class="muted">No hay peticiones aquí.</p>'}
        <details class="card" style="margin-top:28px"><summary><strong>Pastores por congregación</strong> <span class="muted">(${Object.keys(pastors).length} de ${CONGREGATIONS.length})</span></summary>
          <form method="post" action="/oracion/pastores">
            <div class="table-scroll"><table><tr><th>Congregación</th><th>Pastor</th><th>WhatsApp</th></tr>${pastorRows}</table></div>
            <button class="small">Guardar pastores</button></form></details>
        <details class="card"><summary><strong>Plantilla de WhatsApp</strong> <span class="muted">${tpl ? `(${esc(tpl)})` : '(sin plantilla)'}</span></summary>
          <p class="muted">WhatsApp solo deja escribir texto libre a quien escribió al número en las últimas 24 horas. Para que llegue siempre, registra en WeCall/Meta una plantilla de categoría Utilidad con <strong>una sola variable</strong>, por ejemplo: «Hola, te escribimos del buzón de oración de la iglesia. {{1}}. Gracias por cuidar y orar por tu gente.» y escribe aquí su nombre cuando esté aprobada.</p>
          <form method="post" action="/oracion/plantilla" class="toolbar"><div><label>Nombre de la plantilla aprobada</label><input type="text" name="template" value="${esc(tpl)}" placeholder="ej.: buzon_oracion" spellcheck="false"></div><button class="small sec">Guardar</button></form></details>`;
      res.send(layout({ title: 'Buzón de oración', active: '/oracion', body, config, query: req.query }));
    })
  );

  r.post(
    '/oracion',
    ah(async (req, res) => {
      const gs = await groups();
      const p = prayer.parseRequest(req.body || {}, new Set(gs.map((g) => g.id)));
      if (p.errors) return go(res, { err: p.errors.join(' ') });
      const id = await prayer.create(db, withGroupCongregation(p.value, gs), 'panel');
      const to = list(req.body.to);
      if (!to.length) return go(res, { ok: 'Petición guardada en el buzón.' });
      go(res, sentFlash(await prayer.send(ctx, id, to)));
    })
  );

  // guarda grupo y congregación de una petición (para corregir a quién va antes de enviar)
  const update = async (req) => {
    const id = Number(req.params.id);
    const cur = (await db.query('SELECT * FROM prayer_requests WHERE id = $1', [id])).rows[0];
    if (!cur) return { error: 'Esa petición no existe.' };
    const gs = await groups();
    const p = prayer.parseRequest({ ...cur, care_group_id: req.body.care_group_id, congregation: req.body.congregation }, new Set(gs.map((g) => g.id)));
    if (p.errors) return { error: p.errors.join(' ') };
    const v = withGroupCongregation(p.value, gs);
    await db.query('UPDATE prayer_requests SET care_group_id = $2, congregation = $3, updated_at = now() WHERE id = $1', [id, v.care_group_id, v.congregation]);
    return { id };
  };

  r.post(
    '/oracion/:id(\\d{1,9})/enviar',
    ah(async (req, res) => {
      const u = await update(req);
      if (u.error) return go(res, { err: u.error });
      const to = list(req.body.to);
      if (!to.length) return go(res, { err: 'Marca a quién enviarla: al líder del grupo, al pastor o a los dos.' });
      go(res, sentFlash(await prayer.send(ctx, u.id, to)));
    })
  );

  r.post(
    '/oracion/:id(\\d{1,9})/guardar',
    ah(async (req, res) => {
      const u = await update(req);
      go(res, u.error ? { err: u.error } : { ok: 'Cambios guardados.' });
    })
  );

  for (const [action, status, msg] of [['archivar', 'archivada', 'Petición archivada.'], ['reabrir', 'nueva', 'Petición reabierta.']]) {
    r.post(
      `/oracion/:id(\\d{1,9})/${action}`,
      ah(async (req, res) => {
        await db.query('UPDATE prayer_requests SET status = $2, updated_at = now() WHERE id = $1', [Number(req.params.id), status]);
        go(res, { ok: msg });
      })
    );
  }

  r.post(
    '/oracion/pastores',
    ah(async (req, res) => {
      const s = await prayer.savePastors(db, req.body || {}, config.defaultCountryCode);
      go(res, s.errors ? { err: s.errors.join(' ') } : { ok: `Pastores guardados (${s.saved}).` });
    })
  );

  r.post(
    '/oracion/plantilla',
    ah(async (req, res) => {
      const tpl = String((req.body && req.body.template) || '').trim();
      if (tpl && !/^[a-z0-9_]{1,60}$/.test(tpl)) return go(res, { err: 'El nombre de la plantilla solo lleva minúsculas, números y guion bajo (como en Meta).' });
      if (tpl) await settings.setValue(db, config.sessionSecret, 'prayerTemplate', tpl);
      else await settings.removeValue(db, 'prayerTemplate');
      await settings.apply(ctx);
      go(res, { ok: tpl ? `Plantilla guardada: ${tpl}.` : 'Plantilla quitada.' });
    })
  );

  return r;
}

module.exports = { oracionRouter };
