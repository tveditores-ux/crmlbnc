'use strict';
const express = require('express');
const { layout, STATUS_BADGE, NOTIF_BADGE } = require('../views/layout');
const { esc } = require('../util');
const { displayPhone } = require('../phone');
const { formatEventDate, formatShort, localInputToDate, dateToLocalInput } = require('../time');
const { csvToRecords, toCsv } = require('../csv');
const repo = require('../repo');
const reminders = require('../reminders');
const msgs = require('../messages');
const { whatsappReady, emailReady } = require('../config');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function go(res, path, flash) {
  const qs = flash ? `?${new URLSearchParams(flash).toString()}` : '';
  res.redirect(303, path + qs);
}

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'Correo', ambos: 'Ambos' };

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((x) => parseInt(x, 10)).filter(Number.isFinite);
}

function adminRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  const tz = config.timezone;
  const page = (req, res, title, active, body) =>
    res.send(layout({ title, active, body, config, query: req.query }));

  /* ------------------------------ Inicio ------------------------------ */
  r.get(
    '/',
    ah(async (req, res) => {
      const [events, counts, failures, lastRun] = await Promise.all([
        db.query(
          `SELECT e.id, e.title, e.starts_at, e.location,
                  count(ep.id) FILTER (WHERE ep.status='confirmado') AS si,
                  count(ep.id) FILTER (WHERE ep.status='pendiente') AS pend,
                  count(ep.id) FILTER (WHERE ep.status='no_puede') AS no,
                  count(ep.id) AS total
             FROM events e LEFT JOIN event_participants ep ON ep.event_id = e.id
            WHERE e.cancelled = FALSE AND e.starts_at > now() AND e.starts_at < now() + interval '45 days'
            GROUP BY e.id ORDER BY e.starts_at LIMIT 12`
        ),
        db.query(
          `SELECT (SELECT count(*) FROM people WHERE active) AS people,
                  (SELECT count(*) FROM people WHERE active AND opt_in) AS optin,
                  (SELECT count(*) FROM ministries) AS ministries,
                  (SELECT count(*) FROM notifications WHERE created_at > now() - interval '7 days'
                     AND status IN ('enviado','simulado')) AS sent7`
        ),
        db.query(
          `SELECT n.created_at, n.channel, n.error, p.full_name, e.title
             FROM notifications n
             JOIN event_participants ep ON ep.id = n.participant_id
             JOIN people p ON p.id = ep.person_id
             JOIN events e ON e.id = ep.event_id
            WHERE n.status = 'fallido' AND n.updated_at > now() - interval '7 days'
            ORDER BY n.updated_at DESC LIMIT 8`
        ),
        db.query(`SELECT value, updated_at FROM system_state WHERE key='last_run'`),
      ]);
      const c = counts.rows[0];
      const lr = lastRun.rows[0];
      const evRows = events.rows
        .map(
          (e) => `<tr><td><a href="/eventos/${e.id}">${esc(e.title)}</a><div class="muted">${esc(
            formatEventDate(e.starts_at, tz)
          )}</div></td>
          <td><span class="badge b-ok">${e.si}</span> <span class="badge b-warn">${e.pend}</span> <span class="badge b-bad">${e.no}</span>
          <div class="muted" style="font-size:12px">${e.total} participantes</div></td></tr>`
        )
        .join('');
      const failRows = failures.rows
        .map(
          (f) => `<tr><td>${esc(formatShort(f.created_at, tz))}</td><td>${esc(f.full_name)}<div class="muted">${esc(
            f.title
          )}</div></td><td>${esc(f.channel)}</td><td class="mono">${esc(f.error || '')}</td></tr>`
        )
        .join('');
      page(
        req,
        res,
        'Inicio',
        '/',
        `<h1>Inicio</h1><p class="sub">Recordatorios automáticos 1 mes, 1 semana y 1 día antes de cada evento.</p>
        <div class="grid">
          <div class="card"><div class="stat">${c.people}</div><div class="stat-label">personas activas</div></div>
          <div class="card"><div class="stat">${c.optin}</div><div class="stat-label">aceptan recibir mensajes</div></div>
          <div class="card"><div class="stat">${c.ministries}</div><div class="stat-label">ministerios</div></div>
          <div class="card"><div class="stat">${c.sent7}</div><div class="stat-label">mensajes en 7 días</div></div>
        </div>
        <h2>Próximos eventos</h2>
        ${
          evRows
            ? `<div class="table-scroll"><table><tr><th>Evento</th><th>Confirmados · Pendientes · No</th></tr>${evRows}</table></div>`
            : `<div class="card muted">No hay eventos en los próximos 45 días. <a href="/eventos/nuevo">Crear uno</a></div>`
        }
        ${
          failRows
            ? `<h2>Envíos fallidos (7 días)</h2><div class="table-scroll"><table><tr><th>Cuándo</th><th>Persona</th><th>Canal</th><th>Error</th></tr>${failRows}</table></div>`
            : ''
        }
        <p class="muted" style="margin-top:20px;font-size:13px">Última revisión automática: ${
          lr ? esc(formatShort(lr.updated_at, tz)) : 'todavía no'
        }</p>`
      );
    })
  );

  /* ------------------------------ Personas ------------------------------ */
  async function allMinistries() {
    return (await db.query('SELECT id, name FROM ministries ORDER BY name')).rows;
  }

  r.get(
    '/personas',
    ah(async (req, res) => {
      const q = String(req.query.q || '').trim();
      const m = parseInt(req.query.m, 10) || null;
      const ministries = await allMinistries();
      const { rows } = await db.query(
        `SELECT p.*, coalesce(array_agg(mi.name ORDER BY mi.name) FILTER (WHERE mi.id IS NOT NULL), '{}') AS mins
           FROM people p
           LEFT JOIN person_ministries pm ON pm.person_id = p.id
           LEFT JOIN ministries mi ON mi.id = pm.ministry_id
          WHERE ($1 = '' OR p.full_name ILIKE '%' || $1 || '%' OR p.phone LIKE '%' || $1 || '%' OR p.email ILIKE '%' || $1 || '%')
            AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM person_ministries x WHERE x.person_id = p.id AND x.ministry_id = $2))
          GROUP BY p.id ORDER BY p.active DESC, p.full_name`,
        [q, m]
      );
      const list = rows
        .map(
          (p) => `<tr style="${p.active ? '' : 'opacity:.55'}">
        <td><a href="/personas/${p.id}">${esc(p.full_name)}</a>${p.role ? `<div class="muted">${esc(p.role)}</div>` : ''}</td>
        <td>${esc(displayPhone(p.phone))}<div class="muted">${esc(p.email || '')}</div></td>
        <td>${p.mins.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</td>
        <td>${CHANNEL_LABEL[p.preferred_channel]}</td>
        <td>${p.opt_in ? '<span class="badge b-ok">Sí</span>' : '<span class="badge b-bad">No</span>'}</td></tr>`
        )
        .join('');
      page(
        req,
        res,
        'Personas',
        '/personas',
        `<h1>Personas</h1><p class="sub">${rows.length} registradas. Solo reciben mensajes las activas que aceptaron.</p>
        <div class="actions"><a class="btn" href="/personas/nueva">Agregar persona</a>
          <a class="btn sec" href="/personas/importar">Importar desde hoja (CSV)</a>
          <a class="btn sec" href="/personas/exportar.csv">Descargar lista</a></div>
        <form class="toolbar" method="get">
          <div><label>Buscar</label><input type="search" name="q" value="${esc(q)}" placeholder="Nombre, teléfono o correo"></div>
          <div><label>Ministerio</label><select name="m"><option value="">Todos</option>${ministries
            .map((x) => `<option value="${x.id}" ${x.id === m ? 'selected' : ''}>${esc(x.name)}</option>`)
            .join('')}</select></div>
          <button class="sec">Filtrar</button></form>
        <div class="table-scroll"><table><tr><th>Nombre</th><th>Contacto</th><th>Ministerios</th><th>Canal</th><th>Acepta</th></tr>${
          list || '<tr><td colspan="5" class="muted">Sin resultados.</td></tr>'
        }</table></div>`
      );
    })
  );

  function personForm(p, ministries, selected, action, errors = []) {
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
    <form method="post" action="${action}" class="card">
      <div class="row">
        <div><label>Nombre completo</label><input type="text" name="full_name" required value="${esc(p.full_name || '')}"></div>
        <div><label>Rol (opcional)</label><input type="text" name="role" value="${esc(p.role || '')}" placeholder="Coordinador, diácono…"></div>
      </div>
      <div class="row">
        <div><label>WhatsApp</label><input type="tel" name="phone" value="${esc(p.phone_display !== undefined ? p.phone_display : p.phone ? displayPhone(p.phone) : '')}" placeholder="0414-1234567"></div>
        <div><label>Correo</label><input type="email" name="email" value="${esc(p.email || '')}"></div>
        <div><label>Canal preferido</label><select name="preferred_channel">${['whatsapp', 'email', 'ambos']
          .map((c) => `<option value="${c}" ${p.preferred_channel === c ? 'selected' : ''}>${CHANNEL_LABEL[c]}</option>`)
          .join('')}</select></div>
      </div>
      <label>Ministerios</label>
      <div class="checks">${
        ministries
          .map(
            (m) =>
              `<label class="check"><input type="checkbox" name="ministries" value="${m.id}" ${
                selected.includes(m.id) ? 'checked' : ''
              }>${esc(m.name)}</label>`
          )
          .join('') || '<span class="muted">Aún no hay ministerios. Créalos en la pestaña Ministerios.</span>'
      }</div>
      <label class="check" style="margin-top:14px"><input type="checkbox" name="opt_in" value="1" ${
        p.opt_in ? 'checked' : ''
      }> Aceptó recibir recordatorios por WhatsApp o correo</label>
      <label class="check"><input type="checkbox" name="active" value="1" ${p.active === false ? '' : 'checked'}> Activo</label>
      <label>Notas</label><textarea name="notes">${esc(p.notes || '')}</textarea>
      <div class="actions"><button>Guardar</button><a class="btn sec" href="/personas">Cancelar</a></div>
    </form>`;
  }

  function personFromBody(b) {
    return {
      full_name: b.full_name,
      phone: b.phone,
      email: b.email,
      role: b.role,
      preferred_channel: b.preferred_channel,
      opt_in: b.opt_in === '1',
      active: b.active === '1',
      notes: b.notes,
    };
  }

  async function handlePersonSave(req, res, id) {
    const { value, errors } = repo.validatePerson(personFromBody(req.body), config.defaultCountryCode);
    const minIds = asArray(req.body.ministries);
    if (!errors.length) {
      const dup = await repo.findExisting(db, value, id);
      if (dup) errors.push(`Ya existe otra persona con ese teléfono o correo (ver #${dup}).`);
    }
    if (errors.length) {
      const ministries = await allMinistries();
      return page(
        req,
        res,
        'Persona',
        '/personas',
        `<h1>${id ? 'Editar persona' : 'Nueva persona'}</h1>${personForm(
          { ...value, phone_display: req.body.phone || '', email: req.body.email },
          ministries,
          minIds,
          id ? `/personas/${id}` : '/personas',
          errors
        )}`
      );
    }
    const pid = await repo.savePerson(db, id, value);
    await repo.setPersonMinistries(db, pid, minIds);
    // Si la persona entra a un ministerio, se suma a los próximos eventos de ese ministerio.
    const { rows } = await db.query(
      `SELECT DISTINCT em.event_id FROM event_ministries em JOIN events e ON e.id = em.event_id
        WHERE e.starts_at > now() AND NOT e.cancelled AND em.ministry_id = ANY($1::int[])`,
      [minIds]
    );
    if (value.active) for (const ev of rows) await repo.addParticipant(db, ev.event_id, pid);
    go(res, '/personas', { ok: `Guardado: ${value.full_name}` });
  }

  r.get(
    '/personas/nueva',
    ah(async (req, res) => {
      const ministries = await allMinistries();
      page(
        req,
        res,
        'Nueva persona',
        '/personas',
        `<h1>Nueva persona</h1>${personForm({ preferred_channel: 'whatsapp' }, ministries, [], '/personas')}`
      );
    })
  );
  r.post('/personas', ah((req, res) => handlePersonSave(req, res, null)));

  r.get(
    '/personas/:id(\\d+)',
    ah(async (req, res) => {
      const id = +req.params.id;
      const { rows } = await db.query('SELECT * FROM people WHERE id=$1', [id]);
      if (!rows[0]) return go(res, '/personas', { err: 'No existe esa persona.' });
      const ministries = await allMinistries();
      const sel = (await db.query('SELECT ministry_id FROM person_ministries WHERE person_id=$1', [id])).rows.map(
        (x) => x.ministry_id
      );
      page(
        req,
        res,
        rows[0].full_name,
        '/personas',
        `<h1>${esc(rows[0].full_name)}</h1>${personForm(rows[0], ministries, sel, `/personas/${id}`)}
        <form method="post" action="/personas/${id}/eliminar" onsubmit="return confirm('¿Eliminar a esta persona y su historial? Si solo dejó de servir, mejor desmarca Activo.')">
          <button class="danger small">Eliminar persona</button></form>`
      );
    })
  );
  r.post('/personas/:id(\\d+)', ah((req, res) => handlePersonSave(req, res, +req.params.id)));
  r.post(
    '/personas/:id(\\d+)/eliminar',
    ah(async (req, res) => {
      await db.query('DELETE FROM people WHERE id=$1', [+req.params.id]);
      go(res, '/personas', { ok: 'Persona eliminada.' });
    })
  );

  const TEMPLATE_HEADERS = ['nombre', 'telefono', 'correo', 'ministerios', 'rol', 'acepta_mensajes', 'canal'];
  r.get('/personas/plantilla.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-personas.csv"');
    res.send(
      toCsv([
        TEMPLATE_HEADERS,
        ['María Pérez', '0414-1234567', 'maria@ejemplo.com', 'Diáconos; Alabanza', 'Coordinadora', 'si', 'whatsapp'],
        ['José Rodríguez', '0424-7654321', '', 'Medios', '', 'si', 'whatsapp'],
      ])
    );
  });

  r.get(
    '/personas/exportar.csv',
    ah(async (req, res) => {
      const { rows } = await db.query(
        `SELECT p.*, coalesce(string_agg(mi.name, '; ' ORDER BY mi.name), '') AS mins
           FROM people p LEFT JOIN person_ministries pm ON pm.person_id = p.id
           LEFT JOIN ministries mi ON mi.id = pm.ministry_id
          GROUP BY p.id ORDER BY p.full_name`
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="personas.csv"');
      res.send(
        toCsv([
          [...TEMPLATE_HEADERS, 'activo'],
          ...rows.map((p) => [
            p.full_name,
            p.phone ? `+${p.phone}` : '',
            p.email || '',
            p.mins,
            p.role,
            p.opt_in ? 'si' : 'no',
            p.preferred_channel,
            p.active ? 'si' : 'no',
          ]),
        ])
      );
    })
  );

  function importPage(csvText, reportHtml) {
    return `<h1>Importar personas</h1>
    <p class="sub">Columnas: <span class="mono">nombre, telefono, correo, ministerios, rol, acepta_mensajes, canal</span>.
    Varios ministerios se separan con punto y coma. Si alguien ya existe (mismo teléfono o correo) se actualiza.</p>
    <div class="actions"><a class="btn sec small" href="/personas/plantilla.csv">Descargar plantilla</a></div>
    <form method="post" class="card" id="imp">
      <label>Archivo CSV (desde Excel o Google Sheets: Archivo → Descargar → CSV)</label>
      <input type="file" accept=".csv,text/csv" id="file">
      <label>O pega el contenido aquí</label>
      <textarea name="csv" id="csv" style="min-height:180px" class="mono">${esc(csvText || '')}</textarea>
      <div class="actions"><button name="accion" value="revisar" class="sec">Revisar sin guardar</button>
      <button name="accion" value="importar">Importar</button></div>
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

  r.get('/personas/importar', (req, res) => page(req, res, 'Importar', '/personas', importPage('', '')));
  r.post(
    '/personas/importar',
    ah(async (req, res) => {
      const text = String(req.body.csv || '');
      const { records, unknownHeaders } = csvToRecords(text);
      const missing = ['nombre'].filter((h) => !records.length || !(h in records[0]));
      let html;
      if (!records.length || missing.length) {
        html = `<div class="flash err">No encontré filas válidas. Revisa que la primera fila tenga los encabezados (al menos "nombre" y "telefono" o "correo").</div>`;
      } else {
        const dryRun = req.body.accion !== 'importar';
        const report = await repo.importPeople(db, records, config.defaultCountryCode, { dryRun });
        const errs = report.errors
          .map((e) => `<tr><td>${e.line}</td><td>${esc(e.name || '')}</td><td>${e.errors.map(esc).join('<br>')}</td></tr>`)
          .join('');
        const unk = unknownHeaders.length
          ? `<p class="muted">Columnas ignoradas: ${unknownHeaders.map(esc).join(', ')}</p>`
          : '';
        if (report.errors.length) {
          html = `<div class="flash err">Hay ${report.errors.length} fila(s) con problemas. No se guardó nada; corrígelas y vuelve a intentar.</div>${unk}
          <div class="table-scroll"><table><tr><th>Línea</th><th>Nombre</th><th>Problema</th></tr>${errs}</table></div>`;
        } else if (dryRun) {
          html = `<div class="flash ok">Todo correcto: ${report.created} nuevas y ${report.updated} por actualizar. Pulsa "Importar" para guardar.</div>${unk}`;
        } else {
          const mc = report.ministriesCreated.length
            ? ` Ministerios nuevos: ${report.ministriesCreated.map(esc).join(', ')}.`
            : '';
          return go(res, '/personas', {
            ok: `Importación lista: ${report.created} nuevas, ${report.updated} actualizadas.${mc}`,
          });
        }
      }
      page(req, res, 'Importar', '/personas', importPage(text, html));
    })
  );

  /* ------------------------------ Ministerios ------------------------------ */
  r.get(
    '/ministerios',
    ah(async (req, res) => {
      const { rows } = await db.query(
        `SELECT m.id, m.name, c.full_name AS coord, count(pm.person_id) AS members
           FROM ministries m
           LEFT JOIN people c ON c.id = m.coordinator_id
           LEFT JOIN person_ministries pm ON pm.ministry_id = m.id
          GROUP BY m.id, c.full_name ORDER BY m.name`
      );
      page(
        req,
        res,
        'Ministerios',
        '/ministerios',
        `<h1>Ministerios</h1><p class="sub">Al crear un evento eliges los ministerios y todos sus miembros quedan convocados.</p>
        <form method="post" action="/ministerios" class="card toolbar">
          <div><label>Nuevo ministerio</label><input type="text" name="name" required placeholder="Ej.: Diáconos"></div>
          <button>Crear</button></form>
        <div class="table-scroll"><table><tr><th>Ministerio</th><th>Coordinador</th><th>Miembros</th></tr>${
          rows
            .map(
              (m) =>
                `<tr><td><a href="/ministerios/${m.id}">${esc(m.name)}</a></td><td>${esc(m.coord || '—')}</td><td><a href="/personas?m=${m.id}">${m.members}</a></td></tr>`
            )
            .join('') || '<tr><td colspan="3" class="muted">Aún no hay ministerios.</td></tr>'
        }</table></div>`
      );
    })
  );

  r.post(
    '/ministerios',
    ah(async (req, res) => {
      const name = String(req.body.name || '').trim();
      if (!name) return go(res, '/ministerios', { err: 'Escribe un nombre.' });
      await repo.ensureMinistry(db, name);
      go(res, '/ministerios', { ok: `Ministerio listo: ${name}` });
    })
  );

  r.get(
    '/ministerios/:id(\\d+)',
    ah(async (req, res) => {
      const id = +req.params.id;
      const m = (await db.query('SELECT * FROM ministries WHERE id=$1', [id])).rows[0];
      if (!m) return go(res, '/ministerios', { err: 'No existe ese ministerio.' });
      const members = (
        await db.query(
          `SELECT p.id, p.full_name FROM people p JOIN person_ministries pm ON pm.person_id=p.id
            WHERE pm.ministry_id=$1 ORDER BY p.full_name`,
          [id]
        )
      ).rows;
      page(
        req,
        res,
        m.name,
        '/ministerios',
        `<h1>${esc(m.name)}</h1>
        <form method="post" action="/ministerios/${id}" class="card">
          <div class="row"><div><label>Nombre</label><input type="text" name="name" value="${esc(m.name)}" required></div>
          <div><label>Coordinador</label><select name="coordinator_id"><option value="">—</option>${members
            .map(
              (p) => `<option value="${p.id}" ${p.id === m.coordinator_id ? 'selected' : ''}>${esc(p.full_name)}</option>`
            )
            .join('')}</select></div></div>
          <div class="actions"><button>Guardar</button></div></form>
        <h2>Miembros (${members.length})</h2>
        <div class="card">${
          members.map((p) => `<a class="chip" href="/personas/${p.id}">${esc(p.full_name)}</a>`).join(' ') ||
          '<span class="muted">Sin miembros. Asígnalos desde la ficha de cada persona o con la importación.</span>'
        }</div>
        <form method="post" action="/ministerios/${id}/eliminar" onsubmit="return confirm('¿Eliminar el ministerio? Las personas no se borran.')">
          <button class="danger small">Eliminar ministerio</button></form>`
      );
    })
  );

  r.post(
    '/ministerios/:id(\\d+)',
    ah(async (req, res) => {
      const id = +req.params.id;
      const name = String(req.body.name || '').trim();
      const coord = parseInt(req.body.coordinator_id, 10) || null;
      try {
        await db.query('UPDATE ministries SET name=$2, coordinator_id=$3 WHERE id=$1', [id, name, coord]);
      } catch (e) {
        if (e.code === '23505') return go(res, `/ministerios/${id}`, { err: 'Ya existe otro ministerio con ese nombre.' });
        throw e;
      }
      go(res, '/ministerios', { ok: 'Ministerio actualizado.' });
    })
  );

  r.post(
    '/ministerios/:id(\\d+)/eliminar',
    ah(async (req, res) => {
      await db.query('DELETE FROM ministries WHERE id=$1', [+req.params.id]);
      go(res, '/ministerios', { ok: 'Ministerio eliminado.' });
    })
  );

  /* ------------------------------ Eventos ------------------------------ */
  r.get(
    '/eventos',
    ah(async (req, res) => {
      const past = req.query.pasados === '1';
      const { rows } = await db.query(
        `SELECT e.*, coalesce(string_agg(DISTINCT m.name, ', '), '') AS mins,
                count(DISTINCT ep.id) AS total,
                count(DISTINCT ep.id) FILTER (WHERE ep.status='confirmado') AS si
           FROM events e
           LEFT JOIN event_ministries em ON em.event_id = e.id
           LEFT JOIN ministries m ON m.id = em.ministry_id
           LEFT JOIN event_participants ep ON ep.event_id = e.id
          WHERE ${past ? 'e.starts_at <= now()' : 'e.starts_at > now()'}
          GROUP BY e.id ORDER BY e.starts_at ${past ? 'DESC' : 'ASC'} LIMIT 200`
      );
      page(
        req,
        res,
        'Eventos',
        '/eventos',
        `<h1>Eventos</h1><p class="sub">${past ? 'Eventos pasados.' : 'Próximos eventos y convocatorias.'}</p>
        <div class="actions"><a class="btn" href="/eventos/nuevo">Nuevo evento</a>
          <a class="btn sec" href="/eventos${past ? '' : '?pasados=1'}">${past ? 'Ver próximos' : 'Ver pasados'}</a></div>
        <div class="table-scroll"><table><tr><th>Fecha</th><th>Evento</th><th>Ministerios</th><th>Confirmados</th></tr>${
          rows
            .map(
              (e) => `<tr style="${e.cancelled ? 'opacity:.55' : ''}"><td>${esc(formatShort(e.starts_at, tz))}</td>
              <td><a href="/eventos/${e.id}">${esc(e.title)}</a>${
                e.cancelled ? ' <span class="badge b-bad">Cancelado</span>' : ''
              }<div class="muted">${esc(e.location)}</div></td>
              <td>${esc(e.mins || '—')}</td><td>${e.si} / ${e.total}</td></tr>`
            )
            .join('') || '<tr><td colspan="4" class="muted">No hay eventos.</td></tr>'
        }</table></div>`
      );
    })
  );

  function eventForm(e, ministries, selected, action, errors = []) {
    return `${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
    <form method="post" action="${action}" class="card">
      <div class="row">
        <div><label>Nombre del evento</label><input type="text" name="title" required value="${esc(e.title || '')}" placeholder="Reunión de diáconos"></div>
        <div><label>Fecha y hora</label><input type="datetime-local" name="starts_at" required value="${esc(
          e.starts_at ? dateToLocalInput(e.starts_at, tz) : ''
        )}"></div>
        <div><label>Lugar</label><input type="text" name="location" value="${esc(e.location || '')}" placeholder="Templo principal"></div>
      </div>
      <label>Descripción (opcional, uso interno)</label><textarea name="description">${esc(e.description || '')}</textarea>
      <label>Ministerios convocados</label>
      <div class="checks">${
        ministries
          .map(
            (m) =>
              `<label class="check"><input type="checkbox" name="ministries" value="${m.id}" ${
                selected.includes(m.id) ? 'checked' : ''
              }>${esc(m.name)}</label>`
          )
          .join('') || '<span class="muted">No hay ministerios todavía.</span>'
      }</div>
      <p class="muted" style="font-size:13px">Todos los miembros activos de esos ministerios quedan convocados. También puedes agregar personas sueltas después.</p>
      <div class="actions"><button>Guardar</button><a class="btn sec" href="/eventos">Cancelar</a></div>
    </form>`;
  }

  function eventFromBody(b) {
    const errors = [];
    const title = String(b.title || '').trim();
    if (!title) errors.push('Falta el nombre del evento.');
    const starts_at = localInputToDate(b.starts_at, tz);
    if (!starts_at) errors.push('Falta la fecha y hora.');
    return {
      errors,
      value: { title, starts_at, location: String(b.location || '').trim(), description: String(b.description || '').trim() },
    };
  }

  r.get(
    '/eventos/nuevo',
    ah(async (req, res) => {
      page(req, res, 'Nuevo evento', '/eventos', `<h1>Nuevo evento</h1>${eventForm({}, await allMinistries(), [], '/eventos')}`);
    })
  );

  r.post(
    '/eventos',
    ah(async (req, res) => {
      const { value, errors } = eventFromBody(req.body);
      const minIds = asArray(req.body.ministries);
      if (errors.length)
        return page(req, res, 'Nuevo evento', '/eventos', `<h1>Nuevo evento</h1>${eventForm(value, await allMinistries(), minIds, '/eventos', errors)}`);
      const { eventId, added } = await repo.saveEvent(db, null, value, minIds);
      go(res, `/eventos/${eventId}`, { ok: `Evento creado con ${added} participantes.` });
    })
  );

  r.get(
    '/eventos/:id(\\d+)/editar',
    ah(async (req, res) => {
      const id = +req.params.id;
      const e = (await db.query('SELECT * FROM events WHERE id=$1', [id])).rows[0];
      if (!e) return go(res, '/eventos', { err: 'No existe ese evento.' });
      const sel = (await db.query('SELECT ministry_id FROM event_ministries WHERE event_id=$1', [id])).rows.map((x) => x.ministry_id);
      page(req, res, 'Editar evento', '/eventos', `<h1>Editar evento</h1>${eventForm(e, await allMinistries(), sel, `/eventos/${id}`)}`);
    })
  );

  r.post(
    '/eventos/:id(\\d+)',
    ah(async (req, res) => {
      const id = +req.params.id;
      const { value, errors } = eventFromBody(req.body);
      const minIds = asArray(req.body.ministries);
      if (errors.length)
        return page(req, res, 'Editar evento', '/eventos', `<h1>Editar evento</h1>${eventForm(value, await allMinistries(), minIds, `/eventos/${id}`, errors)}`);
      const { added } = await repo.saveEvent(db, id, value, minIds);
      go(res, `/eventos/${id}`, { ok: `Evento actualizado${added ? `; ${added} participantes nuevos` : ''}.` });
    })
  );

  r.get(
    '/eventos/:id(\\d+)',
    ah(async (req, res) => {
      const id = +req.params.id;
      const e = (await db.query('SELECT * FROM events WHERE id=$1', [id])).rows[0];
      if (!e) return go(res, '/eventos', { err: 'No existe ese evento.' });
      const mins = (
        await db.query(
          'SELECT m.name FROM event_ministries em JOIN ministries m ON m.id=em.ministry_id WHERE em.event_id=$1 ORDER BY m.name',
          [id]
        )
      ).rows.map((x) => x.name);
      const parts = (
        await db.query(
          `SELECT ep.*, p.full_name, p.phone, p.email, p.opt_in, p.active,
                  (SELECT string_agg(n.kind || ':' || n.channel || ':' || n.status, ',' ORDER BY n.created_at)
                     FROM notifications n WHERE n.participant_id = ep.id) AS sent
             FROM event_participants ep JOIN people p ON p.id = ep.person_id
            WHERE ep.event_id = $1 ORDER BY ep.status, p.full_name`,
          [id]
        )
      ).rows;
      const others = (
        await db.query(
          `SELECT id, full_name FROM people WHERE active AND id NOT IN (SELECT person_id FROM event_participants WHERE event_id=$1) ORDER BY full_name`,
          [id]
        )
      ).rows;
      const tally = { pendiente: 0, confirmado: 0, no_puede: 0 };
      parts.forEach((p) => tally[p.status]++);
      const kindShort = { '1m': '1 mes', '1w': '1 sem', '1d': '1 día', manual: 'manual' };
      const rows = parts
        .map((p) => {
          const sent = (p.sent || '')
            .split(',')
            .filter(Boolean)
            .map((s) => {
              const [k, ch, st] = s.split(':');
              const cls = st === 'fallido' ? 'b-bad' : st === 'simulado' ? 'b-muted' : 'b-ok';
              return `<span class="badge ${cls}" title="${esc(ch)} · ${esc(st)}">${kindShort[k] || k}${ch === 'email' ? ' ✉' : ''}</span>`;
            })
            .join(' ');
          const warn = !p.opt_in
            ? '<div class="badge b-bad">No aceptó mensajes</div>'
            : !p.active
            ? '<div class="badge b-muted">Inactivo</div>'
            : '';
          return `<tr><td><a href="/personas/${p.person_id}">${esc(p.full_name)}</a>${warn}
            <div class="muted" style="font-size:12px">${esc(displayPhone(p.phone) || p.email || '')}</div></td>
            <td>${STATUS_BADGE[p.status]}${
              p.responded_at ? `<div class="muted" style="font-size:12px">${esc(formatShort(p.responded_at, tz))} · ${esc(p.response_channel || '')}</div>` : ''
            }</td>
            <td>${sent || '<span class="muted">—</span>'}</td>
            <td><form class="inline" method="post" action="/eventos/${id}/participantes/${p.id}/estado">
              <select name="status" onchange="this.form.submit()" style="width:auto;padding:4px">${['pendiente', 'confirmado', 'no_puede']
                .map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`)
                .join('')}</select></form>
              <form class="inline" method="post" action="/eventos/${id}/participantes/${p.id}/quitar"><button class="small sec" title="Quitar">✕</button></form></td></tr>`;
        })
        .join('');
      page(
        req,
        res,
        e.title,
        '/eventos',
        `<h1>${esc(e.title)} ${e.cancelled ? '<span class="badge b-bad">Cancelado</span>' : ''}</h1>
        <p class="sub">${esc(formatEventDate(e.starts_at, tz))}${e.location ? ` · ${esc(e.location)}` : ''}${
          mins.length ? `<br>Ministerios: ${mins.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}` : ''
        }</p>
        <div class="grid">
          <div class="card"><div class="stat" style="color:var(--ok)">${tally.confirmado}</div><div class="stat-label">confirmados</div></div>
          <div class="card"><div class="stat" style="color:var(--warn)">${tally.pendiente}</div><div class="stat-label">pendientes</div></div>
          <div class="card"><div class="stat" style="color:var(--bad)">${tally.no_puede}</div><div class="stat-label">no pueden</div></div>
        </div>
        <div class="actions">
          <a class="btn sec" href="/eventos/${id}/editar">Editar</a>
          <form class="inline" method="post" action="/eventos/${id}/sincronizar"><button class="sec">Actualizar miembros de ministerios</button></form>
          <form class="inline" method="post" action="/eventos/${id}/enviar" onsubmit="return confirm('¿Enviar ahora un recordatorio a todos los pendientes?')"><button>Enviar recordatorio ahora a pendientes</button></form>
          ${
            e.cancelled
              ? `<form class="inline" method="post" action="/eventos/${id}/reactivar"><button class="sec">Reactivar</button></form>`
              : `<form class="inline" method="post" action="/eventos/${id}/cancelar" onsubmit="return confirm('¿Cancelar el evento? No se enviarán más recordatorios.')"><button class="danger">Cancelar evento</button></form>`
          }
        </div>
        <p class="muted" style="font-size:13px">Automático: 1 mes, 1 semana y 1 día antes, entre las ${config.sendWindowStart}:00 y las ${config.sendWindowEnd}:00. Quien ya confirmó solo recibe el de 1 día.</p>
        <h2>Participantes (${parts.length})</h2>
        <form method="post" action="/eventos/${id}/participantes" class="toolbar">
          <div><select name="person_id" required><option value="">Agregar a una persona…</option>${others
            .map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`)
            .join('')}</select></div><button class="sec">Agregar</button></form>
        <div class="table-scroll"><table><tr><th>Persona</th><th>Respuesta</th><th>Enviados</th><th></th></tr>${
          rows || '<tr><td colspan="4" class="muted">Sin participantes.</td></tr>'
        }</table></div>`
      );
    })
  );

  r.post(
    '/eventos/:id(\\d+)/participantes',
    ah(async (req, res) => {
      const id = +req.params.id;
      const pid = parseInt(req.body.person_id, 10);
      if (pid) await repo.addParticipant(db, id, pid);
      go(res, `/eventos/${id}`, { ok: 'Participante agregado.' });
    })
  );

  r.post(
    '/eventos/:id(\\d+)/participantes/:pid(\\d+)/estado',
    ah(async (req, res) => {
      const id = +req.params.id;
      const status = req.body.status;
      if (['pendiente', 'confirmado', 'no_puede'].includes(status)) {
        await db.query(
          `UPDATE event_participants SET status=$3, responded_at = CASE WHEN $3='pendiente' THEN NULL ELSE now() END,
                  response_channel = CASE WHEN $3='pendiente' THEN NULL ELSE 'panel' END
            WHERE id=$1 AND event_id=$2`,
          [+req.params.pid, id, status]
        );
      }
      go(res, `/eventos/${id}`);
    })
  );

  r.post(
    '/eventos/:id(\\d+)/participantes/:pid(\\d+)/quitar',
    ah(async (req, res) => {
      const id = +req.params.id;
      await db.query('DELETE FROM event_participants WHERE id=$1 AND event_id=$2', [+req.params.pid, id]);
      go(res, `/eventos/${id}`, { ok: 'Participante quitado.' });
    })
  );

  r.post(
    '/eventos/:id(\\d+)/sincronizar',
    ah(async (req, res) => {
      const id = +req.params.id;
      const added = await repo.syncEventMinistryMembers(db, id);
      go(res, `/eventos/${id}`, { ok: added ? `${added} participantes nuevos.` : 'No había miembros nuevos.' });
    })
  );

  r.post(
    '/eventos/:id(\\d+)/enviar',
    ah(async (req, res) => {
      const id = +req.params.id;
      const e = (await db.query('SELECT cancelled, starts_at FROM events WHERE id=$1', [id])).rows[0];
      if (!e || e.cancelled) return go(res, `/eventos/${id}`, { err: 'El evento está cancelado.' });
      if (new Date(e.starts_at) <= new Date()) return go(res, `/eventos/${id}`, { err: 'El evento ya pasó.' });
      const s = await reminders.sendManual(ctx, id, { onlyPending: true });
      const parts = [`Enviados: ${s.sent}`];
      if (s.failed) parts.push(`fallidos: ${s.failed} (${s.errors.slice(0, 2).join(' | ')})`);
      if (s.noChannel) parts.push(`sin canal disponible: ${s.noChannel}`);
      go(res, `/eventos/${id}`, s.failed ? { err: parts.join(' · ') } : { ok: parts.join(' · ') });
    })
  );

  r.post(
    '/eventos/:id(\\d+)/cancelar',
    ah(async (req, res) => {
      await db.query('UPDATE events SET cancelled=TRUE, updated_at=now() WHERE id=$1', [+req.params.id]);
      go(res, `/eventos/${req.params.id}`, { ok: 'Evento cancelado.' });
    })
  );
  r.post(
    '/eventos/:id(\\d+)/reactivar',
    ah(async (req, res) => {
      await db.query('UPDATE events SET cancelled=FALSE, updated_at=now() WHERE id=$1', [+req.params.id]);
      go(res, `/eventos/${req.params.id}`, { ok: 'Evento reactivado.' });
    })
  );

  /* ------------------------------ Mensajes ------------------------------ */
  r.get(
    '/mensajes',
    ah(async (req, res) => {
      const [out, inc] = await Promise.all([
        db.query(
          `SELECT n.*, p.full_name, e.title, e.id AS event_id
             FROM notifications n
             JOIN event_participants ep ON ep.id = n.participant_id
             JOIN people p ON p.id = ep.person_id
             JOIN events e ON e.id = ep.event_id
            ORDER BY n.created_at DESC LIMIT 150`
        ),
        db.query(
          `SELECT i.*, p.full_name FROM inbound_messages i LEFT JOIN people p ON p.phone = i.from_phone
            ORDER BY i.received_at DESC LIMIT 100`
        ),
      ]);
      const delivery = { sent: 'enviado a Meta', delivered: 'entregado', read: 'leído', failed: 'falló' };
      page(
        req,
        res,
        'Mensajes',
        '/mensajes',
        `<h1>Mensajes</h1><p class="sub">Historial de envíos y respuestas recibidas por WhatsApp.</p>
        <h2>Enviados</h2>
        <div class="table-scroll"><table><tr><th>Cuándo</th><th>Persona</th><th>Evento</th><th>Tipo</th><th>Estado</th></tr>${
          out.rows
            .map(
              (n) => `<tr><td>${esc(formatShort(n.created_at, tz))}</td><td>${esc(n.full_name)}</td>
              <td><a href="/eventos/${n.event_id}">${esc(n.title)}</a></td>
              <td>${esc(reminders.KIND_LABEL[n.kind] || n.kind)}<div class="muted">${n.channel === 'email' ? 'Correo' : 'WhatsApp'}</div></td>
              <td>${NOTIF_BADGE[n.status] || esc(n.status)}${
                n.delivery_status ? `<div class="muted" style="font-size:12px">${esc(delivery[n.delivery_status] || n.delivery_status)}</div>` : ''
              }${n.error ? `<div class="mono" style="color:var(--bad)">${esc(n.error)}</div>` : ''}</td></tr>`
            )
            .join('') || '<tr><td colspan="5" class="muted">Todavía no se ha enviado nada.</td></tr>'
        }</table></div>
        <h2>Recibidos</h2>
        <div class="table-scroll"><table><tr><th>Cuándo</th><th>De</th><th>Mensaje</th><th>Interpretado</th></tr>${
          inc.rows
            .map(
              (i) => `<tr><td>${esc(formatShort(i.received_at, tz))}</td><td>${esc(i.full_name || displayPhone(i.from_phone))}</td>
              <td>${esc(i.body)}</td><td>${
                i.handled_as === 'confirmado' || i.handled_as === 'no_puede'
                  ? STATUS_BADGE[i.handled_as]
                  : '<span class="badge b-muted">Sin interpretar</span>'
              }</td></tr>`
            )
            .join('') || '<tr><td colspan="4" class="muted">Sin mensajes recibidos.</td></tr>'
        }</table></div>`
      );
    })
  );

  /* ------------------------------ Pruebas ------------------------------ */
  r.get(
    '/pruebas',
    ah(async (req, res) => {
      const ok = (b) => (b ? '<span class="badge b-ok">Listo</span>' : '<span class="badge b-bad">Falta</span>');
      const wa = whatsappReady(config);
      const em = emailReady(config);
      const lr = (await db.query(`SELECT value, updated_at FROM system_state WHERE key='last_run'`)).rows[0];
      const webhookUrl = `${config.publicUrl}/webhooks/whatsapp`;
      page(
        req,
        res,
        'Pruebas',
        '/pruebas',
        `<h1>Pruebas y configuración</h1><p class="sub">Revisa que cada pieza esté conectada antes de activar los envíos reales.</p>
        <div class="card"><div class="table-scroll"><table>
          <tr><td>Modo</td><td>${config.dryRun ? '<span class="badge b-warn">Prueba (DRY_RUN=true)</span>' : '<span class="badge b-ok">Envíos reales</span>'}</td></tr>
          <tr><td>WhatsApp Cloud API</td><td>${ok(wa)} <span class="muted">plantilla: ${esc(config.whatsapp.templateName)} (${esc(config.whatsapp.templateLang)})</span></td></tr>
          <tr><td>Webhook de WhatsApp</td><td>${ok(config.whatsapp.verifyToken)} <span class="mono">${esc(webhookUrl)}</span></td></tr>
          <tr><td>Firma del webhook (App Secret)</td><td>${ok(config.whatsapp.appSecret)}</td></tr>
          <tr><td>Correo</td><td>${ok(em)} <span class="muted">${esc(config.email.provider)}${config.email.from ? ` · ${esc(config.email.from)}` : ''}</span></td></tr>
          <tr><td>Programador</td><td>${config.schedulerEnabled ? `cada ${config.schedulerIntervalMinutes} min` : 'apagado'} · última pasada: ${
            lr ? `${esc(formatShort(lr.updated_at, tz))} <span class="mono">${esc(lr.value)}</span>` : 'todavía no'
          }</td></tr>
          <tr><td>Zona horaria</td><td>${esc(tz)} · horario de envío ${config.sendWindowStart}:00–${config.sendWindowEnd}:00</td></tr>
        </table></div></div>

        <h2>1. Mensaje de prueba por WhatsApp</h2>
        <form method="post" action="/pruebas/whatsapp" class="card">
          <div class="row"><div><label>Número</label><input type="tel" name="phone" required placeholder="0414-1234567"></div>
          <div><label>Qué enviar</label><select name="kind">
            <option value="recordatorio">Plantilla de recordatorio (requiere aprobación de Meta)</option>
            <option value="hello_world">hello_world (plantilla de ejemplo de Meta)</option></select></div></div>
          <div class="actions"><button>Enviar prueba</button></div></form>

        <h2>2. Correo de prueba</h2>
        <form method="post" action="/pruebas/correo" class="card toolbar">
          <div><label>Correo</label><input type="email" name="email" required></div><button>Enviar prueba</button></form>

        <h2>3. Ejecutar el programador ahora</h2>
        <form method="post" action="/pruebas/programador" class="card"><p class="muted" style="margin-top:0">Revisa todos los eventos y envía los recordatorios que correspondan en este momento (respeta el horario de envío).</p>
          <button class="sec">Ejecutar ahora</button></form>

        <h2>Plantilla para registrar en Meta</h2>
        <div class="card">
          <p style="margin-top:0">Nombre: <span class="mono">${esc(config.whatsapp.templateName)}</span> · Categoría: <strong>Utilidad</strong> · Idioma: <strong>Español</strong></p>
          <label>Cuerpo</label><pre>${esc(msgs.TEMPLATE_BODY)}</pre>
          <label>Ejemplos de variables</label><pre>{{1}} María
{{2}} Reunión de diáconos
{{3}} mañana
{{4}} sábado 10 de octubre, 4:00 p. m.
{{5}} Templo principal</pre>
          <label>Botones (respuesta rápida)</label><pre>${msgs.TEMPLATE_BUTTONS.join('\n')}</pre>
        </div>`
      );
    })
  );

  r.post(
    '/pruebas/whatsapp',
    ah(async (req, res) => {
      const { normalizePhone } = require('../phone');
      const to = normalizePhone(req.body.phone, config.defaultCountryCode);
      if (!to) return go(res, '/pruebas', { err: 'Número no válido.' });
      if (!ctx.channels.whatsapp.available) return go(res, '/pruebas', { err: 'WhatsApp no está configurado.' });
      try {
        let r1;
        if (req.body.kind === 'hello_world') {
          r1 = await ctx.channels.whatsapp.sendTemplate(to, { name: 'hello_world', lang: 'en_US' });
        } else {
          const data = {
            name: 'Prueba',
            title: 'Evento de prueba',
            when: 'mañana',
            date: formatEventDate(new Date(Date.now() + 86400000), tz),
            location: config.churchName,
          };
          r1 = await ctx.channels.whatsapp.sendTemplate(to, msgs.whatsappTemplateArgs(data, 'prueba0000', config));
        }
        go(res, '/pruebas', {
          ok: r1.simulated ? 'Simulado (DRY_RUN activo): no salió nada.' : `Enviado. ID de Meta: ${r1.id}`,
        });
      } catch (e) {
        go(res, '/pruebas', { err: e.message });
      }
    })
  );

  r.post(
    '/pruebas/correo',
    ah(async (req, res) => {
      if (!ctx.channels.email.available) return go(res, '/pruebas', { err: 'El correo no está configurado.' });
      const data = {
        name: 'Prueba',
        title: 'Evento de prueba',
        when: 'mañana',
        date: formatEventDate(new Date(Date.now() + 86400000), tz),
        location: config.churchName,
        link: `${config.publicUrl}/c/prueba`,
      };
      try {
        const r1 = await ctx.channels.email.send({ to: String(req.body.email || '').trim(), ...msgs.reminderEmail(data, config) });
        go(res, '/pruebas', { ok: r1.simulated ? 'Simulado (DRY_RUN activo): no salió nada.' : 'Correo enviado.' });
      } catch (e) {
        go(res, '/pruebas', { err: e.message });
      }
    })
  );

  r.post(
    '/pruebas/programador',
    ah(async (req, res) => {
      const s = await reminders.runReminders({ ...ctx, now: new Date() });
      if (s.outsideWindow) return go(res, '/pruebas', { err: 'Fuera del horario de envío; no se envió nada.' });
      go(res, '/pruebas', { ok: `Revisados: ${s.checked} · enviados: ${s.sent} · fallidos: ${s.failed} · ya enviados antes: ${s.skipped}` });
    })
  );

  return r;
}

module.exports = { adminRouter };
