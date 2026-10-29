'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const { createRateLimiter } = require('../attendance-store');
const { parseReport, upsertReport, parseLeaderProfile, parsePhoto, savePhoto, STAGES: cgStages, CONGREGATIONS: cgCongregations, DAYS: cgDays } = require('../care-groups');
const fmt = require('../care-formats');
const views = require('../views/care-formats');
const { leaderFields, PHOTO_SCRIPT } = require('../views/care-leader-form');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CSS = `<style>
.remote{max-width:520px;margin:0 auto}
.remote h1{font-size:22px;margin:4px 0 2px}
.remote label{font-weight:600;margin-top:14px;display:block}
.remote input,.remote textarea{font-size:20px;padding:12px;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;background:#fff}
.remote textarea{font-size:16px;min-height:80px}
.remote .pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.remote .pair>div{min-width:0}
.remote .triple{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.5fr) minmax(0,1fr);gap:8px}
.remote .triple>div{min-width:0}
.remote input[type=date]{min-width:0;max-width:100%;font-size:18px;-webkit-appearance:none;appearance:none;min-height:54px}
.remote .pair label{font-size:13px}
.remote .check{display:flex;gap:10px;align-items:center;font-weight:600;margin-top:18px}
.remote .check input{width:26px;height:26px;flex:none}
.remote .go{width:100%;font-size:20px;padding:16px;margin-top:20px}
.remote h2{font-size:15px;margin:22px 0 0;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.remote .ok{background:var(--ok-bg);color:var(--ok);border-radius:12px;padding:18px;margin-top:14px;font-size:17px}
.tabs{display:flex;gap:6px;overflow-x:auto;margin:0 0 14px;padding-bottom:4px}
.tabs a{white-space:nowrap;padding:8px 12px;border-radius:999px;border:1px solid var(--line);background:#fff;text-decoration:none;color:inherit;font-size:14px}
.tabs a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.remote .card input,.remote .card textarea{font-size:16px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.remote .chip2{margin:0;font-weight:600}
.chip2 input{position:absolute;opacity:0;width:0;height:0}
.chip2 span{display:inline-block;min-width:44px;text-align:center;padding:10px 8px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:15px}
.chip2 input:checked+span{background:var(--accent);color:#fff;border-color:var(--accent)}
.chip2 input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.photo-box img{display:block;width:100%;max-width:260px;aspect-ratio:1/1;object-fit:cover;border-radius:16px;border:1px solid var(--line);margin:0 0 10px}
.photo-box .quick{display:flex;gap:8px;flex-wrap:wrap}
.remote .photo-btn{display:inline-block;margin:0;font-weight:600;font-size:16px;padding:12px 14px;text-align:center;cursor:pointer;flex:1 1 140px}
.hp{position:absolute;left:-9999px;height:0;overflow:hidden}
</style>`;

/** Formulario del teléfono para que el líder de un grupo de cuidado reporte su reunión. Protegido por enlace secreto. */
function careRemoteRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const limiter = createRateLimiter({ max: 30 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });

  const shell = (title, body, status = 200) => ({ status, html: layout({ title, config, bare: true, body: `${CSS}<div class="remote">${body}</div>` }) });
  const send = (res, o) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(o.status).send(o.html);
  };

  async function findGroup(token) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
    const { rows } = await db.query('SELECT * FROM care_groups WHERE token = $1', [token]);
    return rows[0] && rows[0].active && rows[0].link_active ? rows[0] : null;
  }

  const invalid = () =>
    shell('Enlace no válido', '<div class="card"><h1>Enlace no válido</h1><p class="muted">Este enlace ya no está activo. Pídele uno nuevo a quien administra el panel.</p></div>', 404);

  const TABS = [['/datos', 'Datos del grupo'], ['', 'Reporte'], ['/planificador', 'Planificador'], ['/gente', 'Ruta de crecimiento'], ['/foda', 'F.O.D.A.'], ['/trimestral', 'Trimestral']];
  const tabKey = { '/datos': 'datos', '': 'reporte', '/planificador': 'planificador', '/gente': 'gente', '/foda': 'foda', '/trimestral': 'trimestral' };
  const tabs = (token, on) =>
    `<div class="tabs">${TABS.map(([p, l]) => `<a href="/g/${esc(token)}${p}" class="${tabKey[p] === on ? 'on' : ''}">${l}</a>`).join('')}</div>`;
  const tooMany = () => shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429);
  const flashErr = (errors) => (errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : '');
  const honey = '<div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>';
  const monthLink = (token, m, delta) => {
    const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1 + delta, 1));
    return `/g/${esc(token)}/planificador?mes=${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  function planForm(g, token, v, errors = []) {
    const month = v.month || monthNow();
    const wk = (i) => (v.weeks && v.weeks[i]) || {};
    const block = (i) => `<div class="card"><strong>Semana ${i + 1}</strong>
      <label for="snack_${i + 1}">Refrigerio</label><input id="snack_${i + 1}" type="text" name="snack_${i + 1}" value="${esc(wk(i).snack || '')}">
      <label for="dynamics_${i + 1}">Dinámicas</label><textarea id="dynamics_${i + 1}" name="dynamics_${i + 1}">${esc(wk(i).dynamics || '')}</textarea>
      <label for="key_element_${i + 1}">Elemento clave</label><textarea id="key_element_${i + 1}" name="key_element_${i + 1}">${esc(wk(i).key_element || '')}</textarea>
      <label for="support_${i + 1}">Apoyo</label><textarea id="support_${i + 1}" name="support_${i + 1}">${esc(wk(i).support || '')}</textarea></div>`;
    return `${tabs(token, 'planificador')}<h1>Planificador mensual</h1>
      <p class="sub" style="margin:0">${esc(g.name)} · <strong>${esc(views.monthName(month))}</strong></p>
      <div class="tabs" style="margin-top:10px"><a href="${monthLink(token, month, -1)}">← Mes anterior</a><a href="${monthLink(token, month, 1)}">Mes siguiente →</a></div>
      ${flashErr(errors)}
      <form method="post" autocomplete="off">${honey}<input type="hidden" name="month" value="${esc(month)}">
        <label for="stage">Etapa</label><select id="stage" name="stage" style="font-size:18px;padding:12px;width:100%;border-radius:10px;border:1px solid var(--line)"><option value="">Sin definir</option>${cgStages.map((s) => `<option ${v.stage === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        ${[0, 1, 2, 3].map(block).join('')}
        <button class="go">Guardar plan</button></form>`;
  }

  function peopleForm(g, token, people, errors = []) {
    const rows = [...people, ...Array.from({ length: Math.max(5, 10 - people.length) }, () => ({ name: '', milestones: [], other: '' }))].slice(0, fmt.MAX_PEOPLE);
    return `${tabs(token, 'gente')}<h1>Ruta de crecimiento</h1>
      <p class="sub" style="margin:0">${esc(g.name)} · marca los hitos que cada persona ya completó (${fmt.MILESTONES.join(', ')}).</p>
      ${flashErr(errors)}
      <form method="post" autocomplete="off">${honey}
        ${rows.map((p, i) => `<div class="card person"><label for="n_${i}" style="margin-top:0">Nombre</label><input id="n_${i}" type="text" name="n_${i}" maxlength="120" value="${esc(p.name)}">
          <div class="chips">${fmt.MILESTONES.map((m) => `<label class="chip2"><input type="checkbox" name="m_${i}" value="${m}" ${p.milestones.includes(m) ? 'checked' : ''}><span>${m}</span></label>`).join('')}</div>
          <label for="o_${i}">Otros</label><input id="o_${i}" type="text" name="o_${i}" maxlength="160" value="${esc(p.other)}"></div>`).join('')}
        <p class="muted" style="font-size:13px">Para quitar a alguien, borra su nombre. Hay espacios en blanco para agregar más; al guardar salen otros.</p>
        <button class="go">Guardar ruta de crecimiento</button></form>`;
  }

  function fodaForm(g, token, v, errors = []) {
    const quarter = v.quarter || quarterNow();
    const area = (k, l) => `<label for="${k}">${l}</label><textarea id="${k}" name="${k}">${esc(v[k] || '')}</textarea>`;
    const picker = views.quarterOptions(quarterNow()).map((q) => `<a href="/g/${esc(token)}/foda?q=${q}" class="${q === quarter ? 'on' : ''}">${esc(q.replace('-', ' '))}</a>`).join('');
    return `${tabs(token, 'foda')}<h1>F.O.D.A.</h1>
      <p class="sub" style="margin:0">${esc(g.name)} · ${esc(fmt.quarterLabel(quarter))}</p><div class="tabs" style="margin-top:10px">${picker}</div>
      ${flashErr(errors)}
      <form method="post" autocomplete="off">${honey}<input type="hidden" name="quarter" value="${esc(quarter)}">
        ${area('strengths', 'Fortalezas')}${area('opportunities', 'Oportunidades')}${area('weaknesses', 'Debilidades')}${area('threats', 'Amenazas')}
        <button class="go">Guardar F.O.D.A.</button></form>`;
  }

  function datosForm(g, token, v, errors = []) {
    return `${tabs(token, 'datos')}<h1>Datos del grupo</h1>
      <p class="sub" style="margin:0"><strong>${esc(g.name)}</strong></p>
      <p class="muted" style="font-size:14px">Revisa que todo esté bien y corrige lo que haga falta. Al guardar, la información llega directo a la iglesia.${g.profile_updated_at ? ' <strong>Ya confirmaste estos datos antes; puedes actualizarlos cuando cambien.</strong>' : ''}</p>
      ${flashErr(errors)}
      <form method="post" autocomplete="off">${honey}
        ${leaderFields(v, { today: today(), photoSrc: v.has_photo ? `/g/${token}/foto?v=${v.photo_v || ''}` : '', stages: cgStages, days: cgDays, congregations: cgCongregations })}
        <button class="go">Guardar datos</button>
      </form>
      ${PHOTO_SCRIPT}`;
  }

  function form(g, v = {}, errors = []) {
    const num = (key, label) =>
      `<div><label for="${key}">${label}</label><input id="${key}" type="number" min="0" step="1" inputmode="numeric" name="${key}" value="${esc(v[key] ?? '')}"></div>`;
    const area = (key, label, hint = '') =>
      `<label for="${key}">${label}</label><textarea id="${key}" name="${key}" placeholder="${esc(hint)}">${esc(v[key] || '')}</textarea>`;
    return `${tabs(g.token, 'reporte')}<h1>Reporte del grupo</h1>
      <p class="sub" style="margin:0"><strong>${esc(g.name)}</strong>${g.leader_name ? ` · ${esc(g.leader_name)}` : ''}</p>
      ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" autocomplete="off">
        <div class="hp" aria-hidden="true"><label>No llenar<input type="text" name="web" tabindex="-1"></label></div>
        <label for="meeting_date">Fecha de la reunión</label>
        <input id="meeting_date" type="date" name="meeting_date" required value="${esc(v.meeting_date || today())}">
        <h2>Resumen</h2>
        <div class="pair">${num('members_count', 'Miembros')}${num('guests_count', 'Invitados')}</div>
        <div class="pair">${num('attendance', 'Total de asistentes')}
          <div><label for="offering">Ofrenda</label><input id="offering" type="text" inputmode="decimal" name="offering" value="${esc(v.offering ?? '')}" placeholder="0.00"></div></div>
        <h2>La reunión</h2>
        ${area('snack', 'Tiempo de refrigerio')}
        ${area('dynamics', 'Dinámicas')}
        ${area('testimonies', 'Testimonios (resumen)')}
        ${area('songs', 'Canciones')}
        ${area('key_element', 'Elemento clave')}
        <h2>Cierre</h2>
        ${area('followup', 'Seguimiento', 'Personas que necesitan una llamada o una visita')}
        ${area('notes', 'Notas')}
        <label class="check"><input type="checkbox" name="advisor_visit" value="1" ${v.advisor_visit ? 'checked' : ''}> Nos visitó el líder asesor</label>
        <button class="go">Enviar reporte</button>
      </form>
      <script>document.querySelectorAll('input[type=number]').forEach(function(i){ i.addEventListener('focus', function(){ i.select(); }); });</script>`;
  }

  r.get(
    '/g/:token',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      send(res, shell('Reporte del grupo', form(g)));
    })
  );

  r.post(
    '/g/:token',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>')); // trampa para robots
      if (!limiter.take(`${req.ip}|${req.params.token}`)) {
        return send(res, shell('Demasiados envíos', '<div class="card"><h1>Demasiados envíos</h1><p class="muted">Espera un rato antes de enviar otro.</p></div>', 429));
      }
      const { value, errors } = parseReport(req.body, today());
      if (errors.length) return send(res, shell('Reporte del grupo', form(g, req.body, errors), 400));
      const out = await upsertReport(db, g.id, value, 'telefono');
      await db.query('UPDATE care_groups SET uses = uses + 1, last_used_at = now() WHERE id = $1', [g.id]);
      send(
        res,
        shell(
          'Reporte enviado',
          `<h1>¡Gracias!</h1>
          <div class="ok"><strong>${out.created ? 'Reporte recibido' : 'Reporte corregido'}</strong><br>
            ${esc(g.name)} · ${esc(value.meeting_date)}<br>
            Asistentes: ${value.attendance ?? '—'}${value.guests_count ? ` · Invitados: ${value.guests_count}` : ''}</div>
          <p class="muted">Si te equivocaste, vuelve a enviar la misma fecha y se corrige.</p>
          <a class="btn go" style="display:block;text-align:center;box-sizing:border-box" href="/g/${esc(req.params.token)}">Enviar otro reporte</a>`
        )
      );
    })
  );

  /* ---------------- Resto del libro: planificador, ruta, F.O.D.A., trimestral ---------------- */
  const link = (token, path = '') => `/g/${esc(token)}${path}`;
  const monthNow = () => today().slice(0, 7);
  const quarterNow = () => fmt.quarterOf(today());
  const saved = (token, path, msg) => shell('Guardado', `<h1>¡Listo!</h1><div class="ok">${esc(msg)}</div><a class="btn go" style="display:block;text-align:center;box-sizing:border-box" href="${link(token, path)}">Volver</a>`);

  r.get(
    '/g/:token/datos',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      const photo = (await db.query('SELECT extract(epoch from updated_at)::bigint AS v FROM care_group_photos WHERE group_id = $1', [g.id])).rows[0];
      send(res, shell('Datos del grupo', datosForm(g, req.params.token, { ...g, leader_phone_input: displayPhone(g.leader_phone), has_photo: !!photo, photo_v: photo ? photo.v : '' })));
    })
  );
  // la foto actual, para que el líder la vea; solo con su enlace
  r.get(
    '/g/:token/foto',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      const p = (await db.query('SELECT data FROM care_group_photos WHERE group_id = $1', [g.id])).rows[0];
      if (!p) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(p.data));
    })
  );
  r.post(
    '/g/:token/datos',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>'));
      if (!limiter.take(`${req.ip}|${req.params.token}`)) return send(res, tooMany());
      const { value, errors } = parseLeaderProfile({ ...req.body, name: g.name }, config.defaultCountryCode, today());
      const photo = parsePhoto(req.body.photo_data);
      if (photo.error) errors.push(photo.error);
      else if (!photo.buffer && !(await db.query('SELECT 1 FROM care_group_photos WHERE group_id = $1', [g.id])).rows.length) errors.push('Falta la foto del líder.');
      if (errors.length) {
        const keep = photo.error ? {} : { photo_data: req.body.photo_data };
        return send(res, shell('Datos del grupo', datosForm(g, req.params.token, { ...req.body, ...keep, leader_phone_input: req.body.leader_phone }, errors), 400));
      }
      await db.query(
        `UPDATE care_groups SET leader_name=$2, leader_phone=$3, leader_email=$4, congregation=COALESCE(NULLIF($5, ''), congregation), address=$6, place=$7, meeting_day=$8, meeting_time=$9, stage=$10,
           leader_birth_date=$11, leader_cedula=$12, leader_address=$13, profile_updated_at=now(), uses = uses + 1, last_used_at = now() WHERE id=$1`,
        [g.id, value.leader_name, value.leader_phone, value.leader_email, value.congregation, value.address, value.place, value.meeting_day, value.meeting_time, value.stage, value.leader_birth_date, value.leader_cedula, value.leader_address]
      );
      if (photo.buffer) await savePhoto(db, g.id, photo.buffer);
      send(res, saved(req.params.token, '/datos', 'Datos del grupo guardados. ¡Gracias!'));
    })
  );

  r.get(
    '/g/:token/planificador',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      const month = fmt.validMonth(req.query.mes) ? req.query.mes : monthNow();
      const plan = await fmt.getPlan(db, g.id, month);
      send(res, shell('Planificador', planForm(g, req.params.token, { month, stage: plan && plan.stage, weeks: plan ? plan.weeks : [] })));
    })
  );
  r.post(
    '/g/:token/planificador',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>'));
      if (!limiter.take(`${req.ip}|${req.params.token}`)) return send(res, tooMany());
      const { value, errors } = fmt.parsePlan(req.body);
      if (errors.length) return send(res, shell('Planificador', planForm(g, req.params.token, value, errors), 400));
      await fmt.upsertPlan(db, g.id, value);
      send(res, saved(req.params.token, `/planificador?mes=${value.month}`, 'Plan del mes guardado.'));
    })
  );

  r.get(
    '/g/:token/gente',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      send(res, shell('Ruta de crecimiento', peopleForm(g, req.params.token, await fmt.listPeople(db, g.id))));
    })
  );
  r.post(
    '/g/:token/gente',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>'));
      if (!limiter.take(`${req.ip}|${req.params.token}`)) return send(res, tooMany());
      const out = await fmt.savePeople(db, g.id, fmt.parsePeople(req.body));
      if (out.error) return send(res, shell('Ruta de crecimiento', peopleForm(g, req.params.token, await fmt.listPeople(db, g.id), [out.error]), 400));
      send(res, saved(req.params.token, '/gente', `Ruta de crecimiento guardada (${out.saved} personas).`));
    })
  );

  r.get(
    '/g/:token/foda',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      const quarter = fmt.validQuarter(req.query.q) ? req.query.q : quarterNow();
      send(res, shell('F.O.D.A.', fodaForm(g, req.params.token, { quarter, ...((await fmt.getFoda(db, g.id, quarter)) || {}) })));
    })
  );
  r.post(
    '/g/:token/foda',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      if (req.body.web) return send(res, shell('Gracias', '<div class="ok">Gracias.</div>'));
      if (!limiter.take(`${req.ip}|${req.params.token}`)) return send(res, tooMany());
      const { value, errors } = fmt.parseFoda(req.body);
      if (errors.length) return send(res, shell('F.O.D.A.', fodaForm(g, req.params.token, value, errors), 400));
      await fmt.upsertFoda(db, g.id, value);
      send(res, saved(req.params.token, `/foda?q=${value.quarter}`, 'F.O.D.A. guardado.'));
    })
  );

  r.get(
    '/g/:token/trimestral',
    ah(async (req, res) => {
      const g = await findGroup(req.params.token);
      if (!g) return send(res, invalid());
      const quarter = fmt.validQuarter(req.query.q) ? req.query.q : quarterNow();
      const t = await fmt.quarterly(db, g.id, quarter);
      const picker = views.quarterOptions(quarterNow()).map((q) => `<a href="${link(req.params.token, `/trimestral?q=${q}`)}" class="${q === quarter ? 'on' : ''}">${esc(q.replace('-', ' '))}</a>`).join('');
      send(res, shell('Reporte trimestral', `${tabs(req.params.token, 'trimestral')}<h1>Reporte trimestral</h1>
        <p class="sub" style="margin:0">${esc(g.name)} · ${esc(fmt.quarterLabel(quarter))}</p><div class="tabs" style="margin-top:10px">${picker}</div>${views.quarterlyView(t)}`));
    })
  );

  return r;
}

module.exports = { careRemoteRouter, CSS };
