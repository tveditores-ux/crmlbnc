'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const members = require('../members');
const pm = require('../people-merge');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ID = '(\\d{1,9})';

/** Unir duplicados: lista de candidatos, búsqueda desde la ficha, confirmación y fusión. */
function duplicatesRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.use('/personas', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // datos personales
    next();
  });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/personas', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const day = (d) => (d ? new Date(d).toLocaleDateString('es-VE', { timeZone: config.timezone }) : '—');

  /* ------------------------- Lista de posibles duplicados ------------------------- */
  r.get(
    '/personas/duplicados',
    ah(async (req, res) => {
      const groups = await pm.duplicateGroups(db);
      const blocks = groups
        .map((g) => {
          const oldest = g[0];
          const rows = g
            .map(
              (p, i) => `<tr style="${p.active ? '' : 'opacity:.55'}">
              <td><a href="/personas/${p.id}">${esc(p.full_name)}</a>${i === 0 ? ' <span class="badge b-ok" title="Se conserva la ficha más antigua">Más antigua</span>' : ''}</td>
              <td>${esc(displayPhone(p.phone) || '—')}<div class="muted" style="font-size:12px">${esc(p.email || '')}</div></td>
              <td>${esc(day(p.created_at))}</td>
              <td>${esc(members.tipoLabel(p.membership))}${p.in_official_group ? '<div class="muted" style="font-size:12px">Grupo oficial</div>' : ''}</td>
              <td class="muted" style="font-size:13px">${p.ministries} ministerios · ${p.events} eventos${p.in_consolidation ? ' · consolidación' : ''}</td>
              <td>${i === 0 ? '' : `<a class="btn small" href="/personas/${oldest.id}/unir/${p.id}">Unir con la más antigua</a>`}</td></tr>`
            )
            .join('');
          return `<div class="table-scroll" style="margin-bottom:18px"><table><tr><th>Nombre</th><th>Contacto</th><th>Creada</th><th>Tipo</th><th>Tiene</th><th></th></tr>${rows}</table></div>`;
        })
        .join('');
      page(
        req,
        res,
        'Unir duplicados',
        `<h1>Posibles duplicados</h1>
        <p class="sub">Personas con el mismo nombre (sin importar tildes, mayúsculas ni emojis). Antes de unir, revisa que sean la misma persona: dos personas distintas pueden llamarse igual.</p>
        <div class="actions"><a class="btn sec" href="/personas">Volver a Personas</a></div>
        <h2>${groups.length} ${groups.length === 1 ? 'grupo' : 'grupos'}</h2>
        ${blocks || '<div class="card muted">No hay personas con el mismo nombre. No hay nada que unir.</div>'}`
      );
    })
  );

  /* ------------------------- Elegir con quién unir (desde la ficha) ------------------------- */
  r.get(
    `/personas/:id${ID}/unir`,
    ah(async (req, res) => {
      const id = +req.params.id;
      const me = await pm.summaryOf(db, id);
      if (!me) return go(res, '/personas', { err: 'No existe esa persona.' });
      const q = String(req.query.q || '').trim().slice(0, 80);
      const suggestions = await pm.duplicatesOf(db, id);
      let found = [];
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        const digits = q.replace(/\D/g, '').replace(/^0+/, '');
        const params = [id, like];
        let cond = 'full_name ILIKE $2';
        if (digits.length >= 3) {
          params.push(`%${digits}%`);
          cond += ' OR phone LIKE $3';
        }
        found = (await db.query(`SELECT id, full_name, phone, email, created_at FROM people WHERE id <> $1 AND (${cond}) ORDER BY lower(full_name) LIMIT 30`, params)).rows;
      }
      const row = (p) => `<tr><td>${esc(p.full_name)}</td><td>${esc(displayPhone(p.phone) || '—')}<div class="muted" style="font-size:12px">${esc(p.email || '')}</div></td><td>${esc(day(p.created_at))}</td>
        <td><a class="btn small" href="/personas/${id}/unir/${p.id}">Elegir</a></td></tr>`;
      const table = (rows, empty) =>
        `<div class="table-scroll"><table><tr><th>Nombre</th><th>Contacto</th><th>Creada</th><th></th></tr>${rows.map(row).join('') || `<tr><td colspan="4" class="muted">${esc(empty)}</td></tr>`}</table></div>`;
      page(
        req,
        res,
        'Unir con otra persona',
        `<h1>Unir con otra persona</h1>
        <p class="sub">Vas a unir a <strong>${esc(me.full_name)}</strong> (${esc(displayPhone(me.phone) || 'sin teléfono')}) con otra ficha que es la misma persona. Se conserva la ficha más antigua y la otra se elimina.</p>
        ${suggestions.length ? `<h2>Con el mismo nombre</h2>${table(suggestions, '')}` : ''}
        <h2>Buscar otra ficha</h2>
        <form class="toolbar" method="get" action="/personas/${id}/unir">
          <div><label>Nombre o teléfono</label><input type="search" name="q" value="${esc(q)}" placeholder="Nombre o teléfono" autofocus></div>
          <button class="sec">Buscar</button></form>
        ${q ? table(found, 'No encontré a nadie con eso.') : ''}
        <div class="actions"><a class="btn sec" href="/personas/${id}">Cancelar</a></div>`
      );
    })
  );

  /* ------------------------- Confirmar ------------------------- */
  async function loadPair(a, b) {
    const [pa, pb] = await Promise.all([pm.summaryOf(db, a), pm.summaryOf(db, b)]);
    if (!pa || !pb || a === b) return null;
    const [keep, other] = pm.pickKeep(pa, pb);
    return { keep, other };
  }

  r.get(
    `/personas/:id${ID}/unir/:otherId${ID}`,
    ah(async (req, res) => {
      const a = +req.params.id;
      const b = +req.params.otherId;
      const pair = await loadPair(a, b);
      if (!pair) return go(res, '/personas', { err: 'Elige dos personas distintas que existan.' });
      const { keep, other } = pair;
      const yn = (v) => (v ? 'Sí' : 'No');
      const line = (label, f) => `<tr><th style="text-transform:none;letter-spacing:0">${esc(label)}</th><td>${f(keep)}</td><td>${f(other)}</td></tr>`;
      const warnings = [];
      if (pm.nameKey(keep.full_name) !== pm.nameKey(other.full_name)) warnings.push('Los nombres no coinciden. Confirma que de verdad es la misma persona.');
      if (keep.phone && other.phone && keep.phone !== other.phone) warnings.push('Tienen teléfonos distintos. Se conserva el de la ficha más antigua; el otro queda anotado en las notas.');
      if (keep.consolidation && other.consolidation) warnings.push('Las dos están en consolidación: se unirán en una sola, con las etapas y llamadas de ambas.');
      if (other.access_level !== 'ninguno' && keep.access_level === 'ninguno') warnings.push(`La ficha que se elimina tenía acceso al panel (${esc(other.access_level)}): pasará a la ficha que se conserva.`);
      const inherit =
        other.opt_in && !keep.opt_in
          ? `<label class="check"><input type="checkbox" name="heredar" value="1"> La ficha que se elimina SÍ había aceptado recibir mensajes. Conservar también ese consentimiento
              <span class="muted">(déjalo sin marcar si no estás segura de que es la misma persona)</span></label>`
          : '';
      page(
        req,
        res,
        'Confirmar unión',
        `<h1>Confirmar unión</h1>
        <p class="sub">Se conserva la ficha más antigua: <strong>${esc(keep.full_name)}</strong> (#${keep.id}). Se elimina <strong>${esc(other.full_name)}</strong> (#${other.id}), después de pasar todo a la que se conserva. Esto no se puede deshacer.</p>
        ${warnings.map((w) => `<div class="flash err">${w}</div>`).join('')}
        <div class="table-scroll"><table>
          <tr><th></th><th>Se conserva (#${keep.id})</th><th>Se elimina (#${other.id})</th></tr>
          ${line('Nombre', (p) => esc(p.full_name))}
          ${line('Teléfono', (p) => esc(displayPhone(p.phone) || '—'))}
          ${line('Correo', (p) => esc(p.email || '—'))}
          ${line('Rol', (p) => esc(p.role || '—'))}
          ${line('Tipo', (p) => esc(members.tipoLabel(p.membership)))}
          ${line('En el grupo oficial', (p) => yn(p.in_official_group))}
          ${line('Aceptó recibir mensajes', (p) => yn(p.opt_in))}
          ${line('Ministerios', (p) => esc(p.ministries.join(', ') || '—'))}
          ${line('Eventos', (p) => p.events)}
          ${line('Conversaciones', (p) => p.conversations)}
          ${line('Consolidación', (p) => yn(p.consolidation))}
          ${line('Nueva Vida', (p) => p.nuevaVida)}
          ${line('Notas', (p) => esc((p.notes || '—').slice(0, 160)))}
          ${line('Creada', (p) => esc(day(p.created_at)))}
        </table></div>
        <p class="muted" style="font-size:13px">Se copian a la ficha que se conserva el teléfono, el correo, las notas y el rol que le falten, y se unen los ministerios, los eventos, las conversaciones, la consolidación y el tipo (miembro o amigo; si son distintos queda miembro). Si es la misma persona, el consentimiento de la ficha que se conserva no cambia.</p>
        <form method="post" action="/personas/${a}/unir/${b}" class="card" onsubmit="return confirm('Se eliminará la ficha #${other.id} y no se puede deshacer. ¿Unir?')">
          ${inherit}
          <div class="actions"><button>Unir en una sola ficha</button><a class="btn sec" href="/personas/${a}/unir">Elegir otra persona</a></div></form>`
      );
    })
  );

  r.post(
    `/personas/:id${ID}/unir/:otherId${ID}`,
    ah(async (req, res) => {
      const a = +req.params.id;
      const b = +req.params.otherId;
      try {
        const s = await pm.mergePeople(db, a, b, { inheritOptIn: req.body.heredar === '1' });
        const parts = [`Se unieron en «${s.keepName}» (#${s.keepId}); se eliminó la ficha #${s.removedId}`];
        if (s.ministries) parts.push(`${s.ministries} ministerios sumados`);
        if (s.events) parts.push(`${s.events} eventos`);
        if (s.conversations) parts.push(`${s.conversations} conversaciones`);
        if (s.consolidation !== 'ninguna') parts.push(`consolidación ${s.consolidation}`);
        const note = s.optInNotInherited ? ' La ficha eliminada había aceptado recibir mensajes: ese consentimiento no se heredó.' : '';
        go(res, `/personas/${s.keepId}`, { ok: `${parts.join(', ')}.${note}` });
      } catch (err) {
        if (err instanceof pm.MergeError) return go(res, `/personas/${a}/unir`, { err: err.message });
        throw err;
      }
    })
  );

  return r;
}

module.exports = { duplicatesRouter };
