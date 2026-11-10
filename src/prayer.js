'use strict';
/**
 * Buzón de oración: peticiones de oración (o información) que llegan por Grace o se escriben en el panel, y su envío por
 * WhatsApp al líder del grupo de cuidado o al pastor de la congregación. Lo decide siempre quien administra, una por una:
 * nada se envía solo.
 *
 * WhatsApp solo deja escribir texto libre si el destinatario escribió en las últimas 24 h; si la ventana está cerrada y hay
 * una plantilla aprobada (Buzón → Plantilla), se envía con ella (una sola variable). El teléfono nunca se guarda en el envío.
 */
const { normalizePhone } = require('./phone');
const { CONGREGATIONS } = require('./care-groups');
const wecall = require('./channels/wecall');

const MAX = { body: 2000, name: 120 };
const KINDS = { oracion: 'Petición de oración', informacion: 'Información' };
const STATUSES = { nueva: 'Nueva', enviada: 'Enviada', archivada: 'Archivada' };
const PRAYER_RE = /oraci[oó]n|\borar\b/i; // el motivo con que Grace escala ("Petición de oración: …")

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanBody = (s) => String(s ?? '').replace(/\r/g, '').trim().slice(0, MAX.body);

/** Valida lo que viene del formulario. Devuelve { value } o { errors }. */
function parseRequest(src, groupIds = null) {
  const errors = [];
  const v = {
    kind: KINDS[src.kind] ? src.kind : 'oracion',
    requester_name: clean(src.requester_name, MAX.name),
    body: cleanBody(src.body),
    care_group_id: /^\d+$/.test(String(src.care_group_id || '')) ? Number(src.care_group_id) : null,
    congregation: CONGREGATIONS.includes(src.congregation) ? src.congregation : '',
  };
  if (!v.body) errors.push('Escribe la petición o la información.');
  if (v.care_group_id && groupIds && !groupIds.has(v.care_group_id)) errors.push('Ese grupo de cuidado no existe.');
  return errors.length ? { errors } : { value: v };
}

async function create(db, v, source = 'panel') {
  const { rows } = await db.query(
    `INSERT INTO prayer_requests (kind, requester_name, body, care_group_id, congregation, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [v.kind, v.requester_name, v.body, v.care_group_id, v.congregation, source]
  );
  return rows[0].id;
}

/**
 * Cuando Grace pasa una petición de oración al equipo pastoral, queda también en el buzón, con el grupo y la congregación
 * de la persona si se conocen. Nunca falla hacia afuera (no debe dejar sin respuesta a quien escribió).
 */
async function fromAgent(db, { person, text, reason }) {
  if (!PRAYER_RE.test(String(reason || ''))) return null;
  try {
    const p = person && person.id ? (await db.query('SELECT full_name, congregation, care_group_name FROM people WHERE id = $1', [person.id])).rows[0] || {} : {};
    let groupId = null;
    if (p.care_group_name) {
      // el grupo que la persona dijo en "Mis datos", si coincide con un grupo activo
      const g = await db.query('SELECT id FROM care_groups WHERE active AND lower(name) = lower($1) LIMIT 1', [String(p.care_group_name).trim()]);
      if (g.rows[0]) groupId = g.rows[0].id;
    }
    return await create(
      db,
      { kind: 'oracion', requester_name: clean(p.full_name || (person && person.full_name), MAX.name), body: cleanBody(text), care_group_id: groupId, congregation: CONGREGATIONS.includes(p.congregation) ? p.congregation : '' },
      'whatsapp'
    );
  } catch (err) {
    console.error('[buzón de oración] no se pudo guardar la petición:', err.message);
    return null;
  }
}

/** A quién se le puede enviar esta petición: el líder de su grupo y el pastor de su congregación (si tienen teléfono). */
async function recipients(db, req, countryCode = '58') {
  const out = {};
  if (req.care_group_id) {
    const g = (await db.query('SELECT name, leader_name, leader_phone, congregation FROM care_groups WHERE id = $1', [req.care_group_id])).rows[0];
    if (g) out.lider = { name: g.leader_name || `Líder de ${g.name}`, group: g.name, phone: normalizePhone(g.leader_phone, countryCode) || '' };
  }
  const cong = req.congregation;
  if (cong) {
    const p = (await db.query('SELECT name, phone FROM congregation_pastors WHERE congregation = $1', [cong])).rows[0];
    if (p && (p.name || p.phone)) out.pastor = { name: p.name || `Pastor de ${cong}`, congregation: cong, phone: normalizePhone(p.phone, countryCode) || '' };
  }
  return out;
}

/** El texto que recibe el líder o el pastor. */
function messageText(req, to) {
  const head = req.kind === 'informacion' ? '📌 *Información*' : '🙏 *Petición de oración*';
  const who = req.requester_name ? ` de ${req.requester_name}` : '';
  const where = [req.group_name && `Grupo: ${req.group_name}`, req.congregation && `Congregación: ${req.congregation}`].filter(Boolean).join(' · ');
  const greet = to && to.name ? `Hola, ${to.name.split(' ')[0]}. ` : '';
  return `${head}${who}\n\n${greet}${req.body}${where ? `\n\n${where}` : ''}\n\nEnviada desde el buzón de oración de la iglesia.`;
}
/** Para la plantilla: una sola línea (las variables de WhatsApp no aceptan saltos de línea). */
const oneLine = (req) => `${KINDS[req.kind]}${req.requester_name ? ` de ${req.requester_name}` : ''}: ${req.body}`.replace(/\s+/g, ' ').slice(0, 900);

/**
 * Envía la petición a los destinatarios elegidos ('lider', 'pastor'). Devuelve [{ to, name, ok, detail }].
 * Cada envío queda en prayer_sends (sin teléfono) y la petición pasa a "enviada" si al menos uno llegó.
 */
async function send(ctx, requestId, targets) {
  const { db, config, channels } = ctx;
  const req = (
    await db.query(`SELECT r.*, g.name AS group_name FROM prayer_requests r LEFT JOIN care_groups g ON g.id = r.care_group_id WHERE r.id = $1`, [requestId])
  ).rows[0];
  if (!req) return [];
  const rc = await recipients(db, req, config.defaultCountryCode);
  const tpl = (config.agent && config.agent.prayerTemplate) || '';
  const note = config.whatsappProvider === 'wecall' && !channels.dryRun ? (r) => wecall.recordDelivery(db, { evento: 'buzon_oracion', ...r }) : async () => {};
  const results = [];
  for (const kind of [...new Set(targets)].filter((k) => k === 'lider' || k === 'pastor')) {
    const to = rc[kind];
    let ok = false;
    let detail = '';
    if (!to) detail = kind === 'lider' ? 'la petición no tiene grupo de cuidado' : 'esa congregación no tiene pastor registrado';
    else if (!to.phone) detail = `${to.name} no tiene un teléfono válido`;
    else if (!channels.whatsapp || !channels.whatsapp.available) detail = 'WhatsApp no está disponible';
    else {
      try {
        await channels.whatsapp.sendText(to.phone, messageText(req, to));
        ok = true;
        detail = channels.dryRun ? 'simulado (modo de prueba)' : 'enviado';
      } catch (e) {
        const closed = /ventana de 24 h|24 ?h|131047|re-engagement/i.test(e.message);
        if (closed && tpl) {
          try {
            await channels.whatsapp.sendTemplate(to.phone, { name: tpl, lang: config.whatsapp && config.whatsapp.templateLang, bodyParams: [oneLine(req)] });
            ok = true;
            detail = `con la plantilla ${tpl}`;
          } catch (e2) {
            detail = `plantilla: ${e2.message}`;
          }
        } else detail = closed ? 'la ventana de 24 h está cerrada y no hay plantilla configurada' : e.message;
        detail = String(detail).replace(/\d{7,}/g, '…').slice(0, 300);
      }
    }
    await db.query('INSERT INTO prayer_sends (request_id, to_kind, to_name, result, detail) VALUES ($1,$2,$3,$4,$5)', [requestId, kind, (to && to.name) || '', ok ? 'enviado' : 'fallido', detail]);
    if (to && to.phone) await note({ result: ok ? 'enviado' : 'envio_fallido', detail });
    results.push({ to: kind, name: (to && to.name) || '', ok, detail });
  }
  if (results.some((r) => r.ok)) await db.query(`UPDATE prayer_requests SET status = 'enviada', updated_at = now() WHERE id = $1 AND status = 'nueva'`, [requestId]);
  return results;
}

/** Guarda los pastores por congregación. Devuelve { errors } o { saved }. */
async function savePastors(db, src, countryCode = '58') {
  const errors = [];
  const rows = [];
  for (const [i, cong] of CONGREGATIONS.entries()) {
    const name = clean(src[`name_${i}`], MAX.name);
    const raw = clean(src[`phone_${i}`], 30);
    const phone = raw ? normalizePhone(raw, countryCode) : '';
    if (raw && !phone) errors.push(`El teléfono del pastor de ${cong} no parece válido.`);
    rows.push([cong, name, phone || '']);
  }
  if (errors.length) return { errors };
  for (const [cong, name, phone] of rows) {
    if (!name && !phone) await db.query('DELETE FROM congregation_pastors WHERE congregation = $1', [cong]);
    else
      await db.query(
        `INSERT INTO congregation_pastors (congregation, name, phone, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (congregation) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = now()`,
        [cong, name, phone]
      );
  }
  return { saved: rows.filter((r) => r[1] || r[2]).length };
}

module.exports = { parseRequest, create, fromAgent, recipients, messageText, oneLine, send, savePastors, KINDS, STATUSES, MAX, PRAYER_RE };
