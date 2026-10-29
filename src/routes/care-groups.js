'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const { toCsv } = require('../csv');
const charts = require('../views/charts');
const cg = require('../care-groups');
const fmt = require('../care-formats');
const intake = require('../care-intake');
const views = require('../views/care-formats');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STALE_DAYS = 8; // un grupo que se reúne cada semana y lleva más de esto sin reportar

function careGroupsRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const page = (req, res, title, body) => res.send(layout({ title, active: '/grupos', body, config, query: req.query }));
  const go = (res, path, flash) => res.redirect(303, flash ? `${path}?${new URLSearchParams(flash).toString()}` : path);
  const short = (iso) => {
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  };

  const select = (name, options, value, blank) =>
    `<select name="${name}">${blank ? `<option value="">${esc(blank)}</option>` : ''}${options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

  function groupForm(g, action, errors = []) {
    const t = (name, label, extra = '') => `<div><label>${label}</label><input type="text" name="${name}" value="${esc(g[name] || '')}" ${extra}></div>`;
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
      <form method="post" action="${action}" class="card">
        <div class="row">
          ${t('name', 'Nombre del grupo', 'required maxlength="120"')}${t('leader_name', 'Líder')}
          ${t('leader_phone', 'Teléfono del líder', 'inputmode="tel"')}${t('leader_email', 'Correo del líder', 'type="text"')}
          ${t('advisor_name', 'Líder asesor')}${t('belongs_to', 'Pertenece a')}
          ${t('congregation', 'Congregación')}${t('place', 'Lugar de reunión')}
          <div><label>Día</label>${select('meeting_day', cg.DAYS, g.meeting_day, 'Sin definir')}</div>
          <div><label>Hora</label><input type="time" name="meeting_time" value="${esc(g.meeting_time || '')}"></div>
          <div><label>Etapa</label>${select('stage', cg.STAGES, g.stage, 'Sin definir')}</div>
          ${t('address', 'Dirección')}
        </div>
        <button style="margin-top:14px">Guardar grupo</button>
      </form>`;
  }

  /* ------------------------------- Lista ------------------------------- */
  r.get(
    '/grupos',
    ah(async (req, res) => {
      const t = today();
      const groups = await cg.listGroups(db, t);
      const active = groups.filter((g) => g.active);
      const stale = active.filter((g) => {
        const d = cg.daysSince(g.last_report, t);
        return d === null || d > STALE_DAYS;
      });
      const weekly = (
        await db.query(
          `SELECT to_char(date_trunc('week', meeting_date), 'DD/MM') AS lbl, date_trunc('week', meeting_date) AS wk,
                  coalesce(sum(attendance), 0)::int AS att, coalesce(sum(guests_count), 0)::int AS guests
             FROM care_group_reports WHERE meeting_date > $1::date - 84
            GROUP BY wk ORDER BY wk`,
          [t]
        )
      ).rows;
      const totals = (
        await db.query(`SELECT count(*)::int AS n, coalesce(sum(attendance),0)::int AS att, coalesce(sum(guests_count),0)::int AS guests FROM care_group_reports WHERE meeting_date > $1::date - 30`, [t])
      ).rows[0];
      const everyone = (await db.query('SELECT p.milestones FROM care_group_people p JOIN care_groups g ON g.id = p.group_id WHERE g.active')).rows;
      const route = views.milestoneCounts(everyone);
      const birthdays = cg.upcomingBirthdays(groups, t, 45);
      const waiting = await intake.countPending(db);
      const rows = groups
        .map((g) => {
          const d = cg.daysSince(g.last_report, t);
          const badge = !g.active ? '<span class="badge b-muted">Inactivo</span>' : d === null ? '<span class="badge b-warn">Sin reportes</span>' : d > STALE_DAYS ? `<span class="badge b-warn">Hace ${d} días</span>` : `<span class="badge b-ok">Al día</span>`;
          return `<tr style="${g.active ? '' : 'opacity:.55'}">
            <td>${g.has_photo ? `<img src="/grupos/${g.id}/foto" alt="" width="36" height="36" style="float:left;margin:0 8px 0 0;border-radius:50%;object-fit:cover">` : ''}<a href="/grupos/${g.id}"><strong>${esc(g.name)}</strong></a><div class="muted">${esc([g.stage, g.congregation].filter(Boolean).join(' · '))}</div></td>
            <td>${esc(g.leader_name)}<div class="muted">${esc(displayPhone(g.leader_phone))}</div></td>
            <td>${esc([g.meeting_day, g.meeting_time].filter(Boolean).join(' '))}<div class="muted">${esc(g.place)}</div></td>
            <td>${badge}<div class="muted">${g.last_report ? esc(short(g.last_report)) : ''}</div></td>
            <td>${g.reports_30d}</td>
            <td>${g.profile_updated_at ? `<span class="badge b-ok">Confirmados</span><div class="muted">${esc(short(new Date(g.profile_updated_at).toLocaleDateString('en-CA', { timeZone: config.timezone })))}</div>` : '<span class="badge b-warn">Pendientes</span>'}</td></tr>`;
        })
        .join('');
      page(
        req,
        res,
        'Grupos de cuidado',
        `<h1>Grupos de cuidado</h1>
        <p class="sub">Cada grupo tiene un enlace para que su líder reporte la reunión desde el teléfono, sin contraseña.</p>
        ${waiting ? `<div class="flash ok"><a href="/grupos/respuestas">${waiting} respuesta${waiting === 1 ? '' : 's'} de líderes por revisar →</a></div>` : ''}
        <div class="grid">
          <div class="card"><div class="stat">${active.length}</div><div class="stat-label">grupos activos</div></div>
          <div class="card"><div class="stat">${totals.n}</div><div class="stat-label">reportes en 30 días</div></div>
          <div class="card"><div class="stat">${totals.att}</div><div class="stat-label">asistentes (30 días)</div></div>
          <div class="card"><div class="stat">${stale.length}</div><div class="stat-label">sin reportar hace más de ${STALE_DAYS} días</div></div>
        </div>
        <p class="toolbar"><a class="btn" href="/grupos/nuevo">Agregar grupo</a> <a class="btn sec" href="/grupos/solicitud">Pedir datos a los líderes</a> <a class="btn sec" href="/grupos/importar">Importar grupos (CSV)</a> <a class="btn sec" href="/grupos/reportes.csv">Descargar reportes</a></p>
        ${birthdays.length ? `<div class="card"><h3>Próximos cumpleaños de líderes (45 días)</h3><div class="table-scroll"><table>${birthdays
          .map((b) => `<tr><td>${b.inDays === 0 ? '<span class="badge b-ok">Hoy</span>' : `${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')}`}</td><td>${esc(b.who)}</td><td>${esc(b.group)}</td><td class="muted">cumple ${b.turns}</td></tr>`)
          .join('')}</table></div></div>` : ''}
        ${weekly.length ? `<div class="card"><h3>Asistencia semanal en todos los grupos</h3>${charts.lineChart(weekly.map((w) => w.lbl), [{ name: 'Asistentes', values: weekly.map((w) => w.att) }, { name: 'Invitados', values: weekly.map((w) => w.guests) }], { title: 'Asistencia semanal en los grupos de cuidado' })}</div>` : ''}
        ${everyone.length ? `<div class="card"><h3>Ruta de crecimiento: personas por hito (${everyone.length} en total)</h3>${charts.barChart(route, { title: 'Personas por hito de la ruta de crecimiento', color: '#6b5b95' })}</div>` : ''}
        <div class="table-scroll"><table><tr><th>Grupo</th><th>Líder</th><th>Reunión</th><th>Último reporte</th><th>Reportes (30 d)</th><th>Datos del grupo</th></tr>${
          rows || '<tr><td colspan="6" class="muted">Aún no hay grupos. Agrega el primero.</td></tr>'
        }</table></div>`
      );
    })
  );

  /* --------------------------- Importar grupos (CSV) --------------------------- */
  function importPage(csvText, reportHtml) {
    return `<h1>Importar grupos de cuidado</h1>
      <p class="sub">Columnas: <span class="mono">Grupo, Líder, Teléfono, Correo, Líder asesor, Pertenece a, Congregación, Dirección, Lugar, Día, Hora, Etapa</span>. Solo <span class="mono">Grupo</span> es obligatoria.
        El nombre del grupo es la clave: si ya existe, solo se completan los datos que traigas llenos y su enlace no cambia. Los grupos nuevos reciben su enlace para el líder.</p>
      <form method="post" class="card" id="imp">
        <label>Archivo CSV (desde Excel o Google Sheets: Archivo → Descargar → CSV)</label>
        <input type="file" accept=".csv,text/csv" id="file">
        <label>O pega el contenido aquí</label>
        <textarea name="csv" id="csv" style="min-height:180px" class="mono">${esc(csvText || '')}</textarea>
        <div class="actions"><button name="accion" value="revisar" class="sec">Revisar sin guardar</button>
        <button name="accion" value="importar">Importar</button><a class="btn sec" href="/grupos">Cancelar</a></div>
      </form>
      ${reportHtml || ''}
      <script>
        document.getElementById('file').addEventListener('change', function(e){
          var f = e.target.files[0]; if(!f) return;
          var rd = new FileReader();
          rd.onload = function(){ document.getElementById('csv').value = rd.result; };
          rd.readAsText(f, 'UTF-8');
        });
      </script>`;
  }
  r.get('/grupos/importar', (req, res) => page(req, res, 'Importar grupos', importPage('')));
  r.post(
    '/grupos/importar',
    ah(async (req, res) => {
      const text = String(req.body.csv || '');
      const dryRun = req.body.accion !== 'importar';
      const report = await cg.importGroups(db, text, config.defaultCountryCode, { dryRun });
      const unk = report.unknownHeaders.length ? `<p class="muted">Columnas ignoradas: ${report.unknownHeaders.map(esc).join(', ')}</p>` : '';
      let html;
      if (report.errors.length) {
        const rows = report.errors.slice(0, 80).map((e) => `<tr><td>${esc(e.line)}</td><td>${esc(e.name || '')}</td><td>${e.errors.map(esc).join('<br>')}</td></tr>`).join('');
        html = `<div class="flash err">Hay ${report.errors.length} fila(s) con problemas. No se guardó nada; corrígelas y vuelve a intentar.</div>${unk}
          <div class="table-scroll"><table><tr><th>Línea</th><th>Grupo</th><th>Problema</th></tr>${rows}</table></div>`;
      } else if (!report.created && !report.updated) {
        html = '<div class="flash err">No encontré filas para importar.</div>';
      } else if (dryRun) {
        html = `<div class="flash ok">Todo correcto: ${report.created} grupos nuevos y ${report.updated} por actualizar. Pulsa "Importar" para guardar.</div>${unk}`;
      } else {
        return go(res, '/grupos', { ok: `Importación lista: ${report.created} grupos nuevos, ${report.updated} actualizados.` });
      }
      page(req, res, 'Importar grupos', importPage(text, html));
    })
  );

  /* ----------------- Pedir los datos a los líderes: un enlace para todos ----------------- */
  const DEFAULT_ASK = 'Hola {nombre}, la paz del Señor. Estamos actualizando los datos de los grupos de cuidado de la iglesia. ¿Me ayudas llenando esta planilla desde tu teléfono? Elige tu grupo y envíala, son dos minutos: {enlace}';
  r.get(
    '/grupos/solicitud',
    ah(async (req, res) => {
      const settings = await intake.ensureToken(db);
      const commonUrl = `${config.publicUrl}/registro/${settings.token}`;
      const groups = (await cg.listGroups(db, today())).filter((g) => g.active);
      const pending = groups.filter((g) => !g.profile_updated_at).length;
      const waiting = await intake.countPending(db);
      const rows = groups
        .map(
          (g) => `<tr data-name="${esc(g.leader_name || g.name)}" data-phone="${esc(g.leader_phone)}">
            <td><strong>${esc(g.name)}</strong><div class="muted">${esc(g.leader_name)}</div></td>
            <td>${g.profile_updated_at ? '<span class="badge b-ok">Confirmados</span>' : '<span class="badge b-warn">Pendientes</span>'}</td>
            <td style="white-space:nowrap">${g.leader_phone ? '<a class="btn small wa" target="_blank" rel="noopener" href="#">WhatsApp</a>' : '<span class="muted">Sin teléfono</span>'}</td></tr>`
        )
        .join('');
      page(
        req,
        res,
        'Pedir datos a los líderes',
        `<p><a href="/grupos">← Grupos de cuidado</a></p><h1>Pedir los datos a los líderes</h1>
        <p class="sub">Un solo enlace para todos: cada líder lo abre, elige su grupo, llena su planilla (con nacimiento y foto) y la envía. Si su teléfono coincide con el que ya tenemos, sus datos se guardan solos; si no, quedan en <a href="/grupos/respuestas">Respuestas</a> para que tú los apruebes.</p>
        ${waiting ? `<div class="flash ok"><a href="/grupos/respuestas">${waiting} respuesta${waiting === 1 ? '' : 's'} por revisar →</a></div>` : ''}
        <div class="card"><h3>Enlace para todos los líderes</h3>
          <input type="text" id="common" readonly value="${esc(commonUrl)}" onclick="this.select()" style="font-size:13px" ${settings.active ? '' : 'disabled'}>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec" id="copyCommon">Copiar enlace</button>
            <form class="inline" method="post" action="/grupos/enlace-comun/${settings.active ? 'desactivar' : 'activar'}"><button class="small ${settings.active ? 'danger' : 'sec'}">${settings.active ? 'Apagar enlace' : 'Encender enlace'}</button></form>
            <form class="inline" method="post" action="/grupos/enlace-comun/nuevo"><button class="small sec">Generar enlace nuevo</button></form></p>
          <p class="muted" style="font-size:13px;margin:0">Quien tenga el enlace puede enviar datos: compártelo solo con los líderes. Si se riega, genera uno nuevo y el anterior deja de funcionar.</p></div>
        <div class="card"><label>Mensaje (puedes cambiarlo; {nombre} y {enlace} se rellenan solos)</label>
          <textarea id="tpl" style="min-height:110px">${esc(DEFAULT_ASK)}</textarea>
          <p class="toolbar" style="margin:8px 0 0"><button type="button" class="small sec" id="copyMsg">Copiar mensaje</button>
            <span class="muted">${pending} de ${groups.length} grupos aún no confirman sus datos.</span></p></div>
        <div class="table-scroll"><table><tr><th>Grupo</th><th>Datos</th><th>Enviar a su líder</th></tr>${rows || '<tr><td colspan="3" class="muted">No hay grupos activos.</td></tr>'}</table></div>
        <script>
          var tpl = document.getElementById('tpl'), url = document.getElementById('common').value;
          function msg(name){ return tpl.value.split('{nombre}').join(name).split('{enlace}').join(url); }
          function refresh(){ document.querySelectorAll('tr[data-phone]').forEach(function(tr){
            var a = tr.querySelector('a.wa'); if (a) a.href = 'https://wa.me/' + tr.dataset.phone + '?text=' + encodeURIComponent(msg(tr.dataset.name)); }); }
          tpl.addEventListener('input', refresh); refresh();
          function copy(btn, text, field){ (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){ var o = btn.textContent; btn.textContent = '¡Copiado!'; setTimeout(function(){ btn.textContent = o; }, 1500); }, function(){ field.select(); btn.textContent = 'Selecciona y copia'; }); }
          document.getElementById('copyCommon').addEventListener('click', function(){ copy(this, url, document.getElementById('common')); });
          document.getElementById('copyMsg').addEventListener('click', function(){ copy(this, msg('líder'), tpl); });
        </script>`
      );
    })
  );

  r.post(
    '/grupos/enlace-comun/:accion(activar|desactivar|nuevo)',
    ah(async (req, res) => {
      if (req.params.accion === 'nuevo') {
        await intake.regenerateToken(db);
        return go(res, '/grupos/solicitud', { ok: 'Enlace nuevo generado. El anterior ya no funciona; vuelve a enviarlo.' });
      }
      await intake.setActive(db, req.params.accion === 'activar');
      go(res, '/grupos/solicitud', { ok: req.params.accion === 'activar' ? 'Enlace encendido.' : 'Enlace apagado.' });
    })
  );

  /* ---------------------- Respuestas del enlace común ---------------------- */
  const showVal = (f, v) => (f.endsWith('birth_date') && v ? short(v) : f === 'leader_phone' ? displayPhone(v) : v);
  r.get(
    '/grupos/respuestas',
    ah(async (req, res) => {
      const pending = await intake.listPending(db);
      const cards = pending
        .map((s) => {
          const changes = intake.FIELDS.filter((f) => s[f] !== '' && s[f] !== (s['cur_' + f] ?? ''))
            .map((f) => `<tr><td class="muted">${esc(intake.LABELS[f])}</td><td>${s['cur_' + f] ? esc(showVal(f, s['cur_' + f])) : '<span class="muted">—</span>'}</td><td><strong>${esc(showVal(f, s[f]))}</strong></td></tr>`)
            .join('');
          return `<div class="card">
            <h3 style="margin-top:0">${s.group_id ? esc(s.group_name) : `${esc(s.new_group_name)} <span class="badge b-warn">Grupo nuevo</span>`}</h3>
            <p class="muted" style="font-size:13px">Recibida ${esc(short(new Date(s.created_at).toLocaleDateString('en-CA', { timeZone: config.timezone })))} · el teléfono no coincide con el registrado, por eso espera tu aprobación.</p>
            ${s.has_photo ? `<img src="/grupos/respuestas/${s.id}/foto" alt="Foto enviada" width="96" height="96" style="border-radius:16px;object-fit:cover;float:right;margin:0 0 8px 12px">` : ''}
            <div class="table-scroll"><table><tr><th></th><th>Ahora</th><th>Envió</th></tr>${changes || '<tr><td colspan="3" class="muted">No trae cambios.</td></tr>'}</table></div>
            <p class="toolbar" style="margin:10px 0 0"><form class="inline" method="post" action="/grupos/respuestas/${s.id}/aplicar"><button class="small">Aprobar y guardar</button></form>
              <form class="inline" method="post" action="/grupos/respuestas/${s.id}/descartar"><button class="small danger">Descartar</button></form></p></div>`;
        })
        .join('');
      page(
        req,
        res,
        'Respuestas de los líderes',
        `<p><a href="/grupos/solicitud">← Pedir datos a los líderes</a></p><h1>Respuestas por revisar</h1>
        <p class="sub">Los envíos cuyo teléfono coincide con el del líder se guardan solos y no pasan por aquí.</p>
        ${cards || '<p class="muted">No hay respuestas pendientes.</p>'}`
      );
    })
  );
  r.get(
    '/grupos/respuestas/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const p = (await db.query("SELECT photo FROM care_group_submissions WHERE id = $1 AND status = 'pendiente'", [+req.params.id])).rows[0];
      if (!p || !p.photo) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(p.photo));
    })
  );
  r.post(
    '/grupos/respuestas/:id(\\d{1,9})/:accion(aplicar|descartar)',
    ah(async (req, res) => {
      const id = +req.params.id;
      if (req.params.accion === 'descartar') {
        const ok = await intake.discard(db, id);
        return go(res, '/grupos/respuestas', ok ? { ok: 'Respuesta descartada.' } : { err: 'Esa respuesta ya fue atendida.' });
      }
      const out = await intake.apply(db, id);
      if (out.error) return go(res, '/grupos/respuestas', { err: out.error });
      go(res, `/grupos/${out.groupId}`, { ok: 'Datos guardados en el grupo.' });
    })
  );

  r.get('/grupos/nuevo', (req, res) => page(req, res, 'Nuevo grupo', `<h1>Nuevo grupo de cuidado</h1>${groupForm({}, '/grupos')}`));
  r.post(
    '/grupos',
    ah(async (req, res) => {
      const { value, errors } = cg.parseGroup(req.body, config.defaultCountryCode);
      if (errors.length) return page(req, res, 'Nuevo grupo', `<h1>Nuevo grupo de cuidado</h1>${groupForm(req.body, '/grupos', errors)}`);
      const ins = await db.query(
        `INSERT INTO care_groups (name, leader_name, leader_phone, leader_email, advisor_name, belongs_to, congregation, address, place, meeting_day, meeting_time, stage, token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [value.name, value.leader_name, value.leader_phone, value.leader_email, value.advisor_name, value.belongs_to, value.congregation, value.address, value.place, value.meeting_day, value.meeting_time, value.stage, cg.newToken()]
      );
      go(res, `/grupos/${ins.rows[0].id}`, { ok: 'Grupo creado. Copia su enlace y envíaselo al líder.' });
    })
  );

  r.get(
    '/grupos/reportes.csv',
    ah(async (req, res) => {
      const { rows } = await db.query(
        `SELECT r.*, g.name FROM care_group_reports r JOIN care_groups g ON g.id = r.group_id ORDER BY r.meeting_date DESC, g.name`
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="reportes-grupos-de-cuidado.csv"');
      res.send(
        toCsv([
          ['Grupo', 'Fecha', 'Miembros', 'Invitados', 'Asistentes', 'Ofrenda', 'Refrigerio', 'Dinámicas', 'Testimonios', 'Canciones', 'Elemento clave', 'Seguimiento', 'Notas', 'Visita del asesor'],
          ...rows.map((x) => [x.name, String(x.meeting_date).slice(0, 10), x.members_count, x.guests_count, x.attendance, x.offering, x.snack, x.dynamics, x.testimonies, x.songs, x.key_element, x.followup, x.notes, x.advisor_visit ? 'sí' : 'no']),
        ])
      );
    })
  );

  /* ------------------------------ Un grupo ------------------------------ */
  async function loadGroup(id) {
    return (await db.query('SELECT * FROM care_groups WHERE id = $1', [id])).rows[0];
  }

  // foto del líder: solo con sesión del panel (este router va después del guardia de sesión)
  r.get(
    '/grupos/:id(\\d{1,9})/foto',
    ah(async (req, res) => {
      const p = (await db.query('SELECT data FROM care_group_photos WHERE group_id = $1', [+req.params.id])).rows[0];
      if (!p) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(p.data));
    })
  );

  r.get(
    '/grupos/:id(\\d{1,9})',
    ah(async (req, res) => {
      const g = await loadGroup(+req.params.id);
      if (!g) return go(res, '/grupos', { err: 'Ese grupo no existe.' });
      const reports = (
        await db.query(`SELECT *, meeting_date::text AS d FROM care_group_reports WHERE group_id = $1 ORDER BY meeting_date DESC LIMIT 60`, [g.id])
      ).rows;
      const url = `${config.publicUrl}/g/${g.token}`;
      const hasPhoto = (await db.query('SELECT 1 FROM care_group_photos WHERE group_id = $1', [g.id])).rows.length > 0;
      const people = await fmt.listPeople(db, g.id);
      const month = today().slice(0, 7);
      const plan = await fmt.getPlan(db, g.id, month);
      const quarter = fmt.quarterOf(today());
      const foda = await fmt.getFoda(db, g.id, quarter);
      const tri = await fmt.quarterly(db, g.id, quarter);
      const chronological = [...reports].reverse().slice(-16);
      const history = reports
        .map(
          (x) => `<tr><td>${esc(short(x.d))}${x.advisor_visit ? '<div class="muted">Visita del asesor</div>' : ''}</td>
            <td>${x.attendance ?? '—'}<div class="muted">${x.members_count ?? '—'} miembros · ${x.guests_count ?? '—'} invitados</div></td>
            <td>${x.offering === null ? '—' : esc(Number(x.offering).toLocaleString('es-VE', { minimumFractionDigits: 2 }))}</td>
            <td>${[['Elemento clave', x.key_element], ['Testimonios', x.testimonies], ['Seguimiento', x.followup], ['Notas', x.notes]]
              .filter(([, v]) => v)
              .map(([l, v]) => `<div><span class="muted">${l}:</span> ${esc(v)}</div>`)
              .join('')}</td></tr>`
        )
        .join('');
      page(
        req,
        res,
        g.name,
        `<p><a href="/grupos">← Grupos de cuidado</a></p>
        <h1>${esc(g.name)} ${g.active ? '' : '<span class="badge b-muted">Inactivo</span>'}</h1>
        <p class="sub">${esc([g.stage, g.leader_name && `Líder: ${g.leader_name}`, g.advisor_name && `Asesor: ${g.advisor_name}`, [g.meeting_day, g.meeting_time].filter(Boolean).join(' '), g.place].filter(Boolean).join(' · '))}</p>
        ${hasPhoto || g.leader_birth_date || g.co_leader_birth_date || g.co_leader_name ? `<div class="card" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          ${hasPhoto ? `<img src="/grupos/${g.id}/foto" alt="Foto del líder" width="96" height="96" style="border-radius:16px;object-fit:cover">` : ''}
          <div><h3 style="margin:0 0 4px">Datos del líder</h3>
            <div>${esc(g.leader_name)}${g.leader_birth_date ? ` <span class="muted">· nació el ${esc(short(g.leader_birth_date))}</span>` : ''}</div>
            ${g.co_leader_name || g.co_leader_birth_date ? `<div>${esc(g.co_leader_name || 'Pareja o co-líder')}${g.co_leader_birth_date ? ` <span class="muted">· nació el ${esc(short(g.co_leader_birth_date))}</span>` : ''}</div>` : ''}</div></div>` : ''}
        <div class="card"><h3>Enlace del líder</h3>
          <p class="muted" style="font-size:13px">Quien tenga este enlace puede enviar reportes de este grupo. Compártelo solo con el líder; si se pierde, genera uno nuevo y el anterior deja de funcionar.</p>
          <input type="text" readonly value="${esc(url)}" onclick="this.select()" style="font-size:13px" ${g.link_active ? '' : 'disabled'}>
          <p class="muted" style="font-size:13px">Datos del grupo: ${g.profile_updated_at ? `confirmados por el líder el ${esc(short(new Date(g.profile_updated_at).toLocaleDateString('en-CA', { timeZone: config.timezone })))}` : 'el líder aún no los ha confirmado'}. Para pedírselos, usa <a href="/grupos/solicitud">Pedir datos a los líderes</a>.</p>
          <p class="toolbar" style="margin-top:8px"><button type="button" class="small sec" data-copy="${esc(url)}">Copiar</button>
            <form class="inline" method="post" action="/grupos/${g.id}/enlace/${g.link_active ? 'desactivar' : 'activar'}"><button class="small ${g.link_active ? 'danger' : 'sec'}">${g.link_active ? 'Desactivar enlace' : 'Activar enlace'}</button></form>
            <form class="inline" method="post" action="/grupos/${g.id}/enlace/nuevo"><button class="small sec">Generar enlace nuevo</button></form>
            <span class="muted">${g.uses} envíos${g.last_used_at ? '' : ' · sin uso'}</span></p></div>
        ${chronological.length > 1 ? `<div class="card"><h3>Asistencia por reunión</h3>${charts.lineChart(chronological.map((x) => short(x.d).slice(0, 5)), [{ name: 'Asistentes', values: chronological.map((x) => x.attendance) }, { name: 'Invitados', values: chronological.map((x) => x.guests_count) }], { title: `Asistencia de ${g.name}` })}</div>` : ''}
        <h2>Reportes</h2>
        <div class="table-scroll"><table><tr><th>Fecha</th><th>Asistentes</th><th>Ofrenda</th><th>Detalle</th></tr>${history || '<tr><td colspan="4" class="muted">Este grupo todavía no ha reportado.</td></tr>'}</table></div>
        <h2>Ruta de crecimiento</h2>${views.milestoneMatrix(people)}
        <h2>Plan de ${esc(views.monthName(month))}</h2>${views.planView(plan)}
        <h2>F.O.D.A. · ${esc(fmt.quarterLabel(quarter))}</h2>${views.fodaView(foda)}
        <h2>Reporte trimestral</h2><p class="muted">${tri.reports} reportes en el ${esc(fmt.quarterLabel(quarter))}: ofrendas ${esc(views.money(tri.offeringTotal))}, asistencia promedio ${tri.attendanceAvg ?? '—'}, visitantes promedio ${tri.guestsAvg ?? '—'}. <a href="/grupos/${g.id}/trimestral">Ver el reporte completo</a></p>
        <p class="muted" style="font-size:13px">El plan, la ruta de crecimiento y el F.O.D.A. los llena el líder desde su enlace. Tú también puedes abrirlo: <a href="/g/${esc(g.token)}" target="_blank" rel="noopener">abrir como líder</a>.</p>
        <h2>Datos del grupo</h2>${groupForm(g, `/grupos/${g.id}/editar`)}
        <form method="post" action="/grupos/${g.id}/${g.active ? 'desactivar' : 'activar'}" style="margin-top:10px"><button class="small ${g.active ? 'danger' : 'sec'}">${g.active ? 'Desactivar grupo' : 'Reactivar grupo'}</button>
          <span class="muted">Un grupo inactivo conserva su historial y deja de aparecer como pendiente.</span></form>
        <script>document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copy');(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='¡Copiado!';},function(){b.closest('.card').querySelector('input').select();b.textContent='Selecciona y copia';});});});</script>`
      );
    })
  );

  r.get(
    '/grupos/:id(\\d{1,9})/trimestral',
    ah(async (req, res) => {
      const g = await loadGroup(+req.params.id);
      if (!g) return go(res, '/grupos', { err: 'Ese grupo no existe.' });
      const quarter = fmt.validQuarter(req.query.q) ? req.query.q : fmt.quarterOf(today());
      const t = await fmt.quarterly(db, g.id, quarter);
      const picker = views.quarterOptions(fmt.quarterOf(today())).map((q) => `<a class="btn ${q === quarter ? '' : 'sec'}" href="/grupos/${g.id}/trimestral?q=${q}">${esc(q.replace('-', ' '))}</a>`).join(' ');
      page(req, res, 'Reporte trimestral', `<p><a href="/grupos/${g.id}">← ${esc(g.name)}</a></p><h1>Reporte trimestral</h1>
        <p class="sub">${esc(g.name)} · ${esc(fmt.quarterLabel(quarter))}</p>
        <p class="toolbar">${picker} <button type="button" class="sec" onclick="window.print()">Imprimir</button></p>${views.quarterlyView(t)}
        <h2>F.O.D.A.</h2>${views.fodaView(await fmt.getFoda(db, g.id, quarter))}`);
    })
  );

  r.post(
    '/grupos/:id(\\d{1,9})/editar',
    ah(async (req, res) => {
      const g = await loadGroup(+req.params.id);
      if (!g) return go(res, '/grupos', { err: 'Ese grupo no existe.' });
      const { value, errors } = cg.parseGroup(req.body, config.defaultCountryCode);
      if (errors.length) return page(req, res, g.name, `<p><a href="/grupos/${g.id}">← Volver</a></p><h1>${esc(g.name)}</h1>${groupForm(req.body, `/grupos/${g.id}/editar`, errors)}`);
      await db.query(
        `UPDATE care_groups SET name=$2, leader_name=$3, leader_phone=$4, leader_email=$5, advisor_name=$6, belongs_to=$7, congregation=$8, address=$9, place=$10, meeting_day=$11, meeting_time=$12, stage=$13 WHERE id=$1`,
        [g.id, value.name, value.leader_name, value.leader_phone, value.leader_email, value.advisor_name, value.belongs_to, value.congregation, value.address, value.place, value.meeting_day, value.meeting_time, value.stage]
      );
      go(res, `/grupos/${g.id}`, { ok: 'Datos guardados.' });
    })
  );

  r.post(
    '/grupos/:id(\\d{1,9})/:accion(activar|desactivar)',
    ah(async (req, res) => {
      await db.query('UPDATE care_groups SET active = $2 WHERE id = $1', [+req.params.id, req.params.accion === 'activar']);
      go(res, `/grupos/${+req.params.id}`, { ok: req.params.accion === 'activar' ? 'Grupo reactivado.' : 'Grupo desactivado.' });
    })
  );

  r.post(
    '/grupos/:id(\\d{1,9})/enlace/:accion(activar|desactivar|nuevo)',
    ah(async (req, res) => {
      const id = +req.params.id;
      if (req.params.accion === 'nuevo') {
        await db.query('UPDATE care_groups SET token = $2, link_active = TRUE WHERE id = $1', [id, cg.newToken()]);
        return go(res, `/grupos/${id}`, { ok: 'Enlace nuevo generado. El anterior ya no funciona.' });
      }
      await db.query('UPDATE care_groups SET link_active = $2 WHERE id = $1', [id, req.params.accion === 'activar']);
      go(res, `/grupos/${id}`, { ok: req.params.accion === 'activar' ? 'Enlace activado.' : 'Enlace desactivado.' });
    })
  );

  return r;
}

module.exports = { careGroupsRouter };
