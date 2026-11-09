'use strict';
/**
 * Asistente virtual de WhatsApp del CRM y ERP de la iglesia, acotado a la vida de la congregación y los grupos de cuidado.
 * Capas de seguridad (de afuera hacia adentro):
 *   1. Apagado por defecto (AGENT_ENABLED) y solo responde a personas registradas y activas.
 *   2. Mensajes de crisis: respuesta fija y aviso al equipo pastoral, sin pasar por el modelo.
 *   3. Límite diario de respuestas por persona.
 *   4. El modelo solo recibe datos de esa persona (y la información general que la iglesia escribió); todo lo demás se escala.
 *   5. Filtro de salida: si la respuesta trae un enlace o un teléfono que no está en los datos, no se envía.
 */
const { formatEventDate } = require('./time');
const brain = require('./agent-brain');
const wecall = require('./channels/wecall');

const FALLBACK_REPLY =
  'Gracias por escribir. Voy a pasar tu mensaje a tu líder o al equipo pastoral para que te respondan personalmente.';
const UNKNOWN_REPLY =
  'Hola, este es el número de comunicación de la iglesia. No encuentro tu número en nuestra lista; por favor escríbele a tu líder de grupo de cuidado para que te registre.';
const NOT_TEXT_REPLY = 'Por ahora solo puedo leer mensajes de texto. ¿Me lo puedes escribir?';
const CRISIS_REPLY =
  'Gracias por contarnos. Lo que escribes es importante y no quiero que lo pases solo/a. Ya avisé al equipo pastoral para que te contacten personalmente lo antes posible. Si estás en peligro ahora mismo, llama a los servicios de emergencia de tu localidad o busca a alguien de confianza cerca de ti.';

const CRISIS_RE =
  /(suicid|quitarme la vida|quiero morir|quiero morirme|me quiero matar|matarme|no quiero vivir|me hacen dano|me pega|me golpea|me maltrata|abuso|abusan|violaron|violacion|me violan|sobredosis|me muero|emergencia)/;

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function isCrisis(text) {
  return CRISIS_RE.test(normalizeText(text));
}

function systemPrompt(config) {
  return brain.buildSystemPrompt(config);
}

/** Saltos de línea y tabulaciones escritos tal cual dentro de las comillas (JSON inválido) pasan a \n y \t. */
function escapeRawInStrings(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr && !esc && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\t' ? '\\t' : ch === '\n' ? '\\n' : '';
      continue;
    }
    if (esc) esc = false;
    else if (ch === '\\') esc = true;
    else if (ch === '"') inStr = !inStr;
    out += ch;
  }
  return out;
}

function parseModelJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const pack = (o) => {
    const reply = typeof o.respuesta === 'string' ? o.respuesta.trim() : '';
    return reply ? { reply: reply.slice(0, 900), escalate: Boolean(o.escalar), reason: String(o.motivo || '').slice(0, 300) } : null;
  };
  if (start >= 0 && end > start) {
    for (const candidate of [raw.slice(start, end + 1), escapeRawInStrings(raw.slice(start, end + 1))]) {
      try {
        const r = pack(JSON.parse(candidate));
        if (r) return r;
      } catch {
        /* se prueba la siguiente forma */
      }
    }
  }
  // JSON roto o cortado: se rescata "respuesta" (hasta su comilla de cierre o hasta donde llegó) y "escalar"
  if (start >= 0) {
    const body = escapeRawInStrings(raw.slice(start));
    const m = body.match(/"respuesta"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m) {
      let reply = '';
      try {
        reply = JSON.parse(`"${m[1].replace(/\\$/, '')}"`).trim();
      } catch {
        /* sin rescate */
      }
      if (reply) {
        const esc = body.match(/"escalar"\s*:\s*(true|false)/);
        const mot = body.match(/"motivo"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        return { reply: reply.slice(0, 900), escalate: esc ? esc[1] === 'true' : false, reason: mot ? mot[1].slice(0, 300) : '' };
      }
    }
  }
  // a veces contesta en texto normal en vez de JSON: se usa igual (sigue pasando por el filtro y el revisor), sin llaves sueltas
  if (raw && !raw.includes('{') && raw.length <= 900) return { reply: raw, escalate: false, reason: '' };
  return null;
}

// respuestas fijas del CRM: no son la voz del asistente, así que no van en el historial que ve el modelo
const isFixedReply = (body) => [FALLBACK_REPLY, UNKNOWN_REPLY, CRISIS_REPLY, NOT_TEXT_REPLY].includes(String(body).trim());

async function askModel(config, { context, history, message, note = '' }, fetchImpl = globalThis.fetch) {
  const merged = [];
  for (const h of history) {
    if (h.direction !== 'in' && isFixedReply(h.body)) continue;
    const role = h.direction === 'in' ? 'user' : 'assistant';
    // sus respuestas anteriores se le muestran en el mismo formato JSON que se le pide, para que no lo abandone
    const content = role === 'assistant' ? JSON.stringify({ respuesta: h.body, escalar: false, motivo: '' }) : h.body;
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.content += '\n' + content;
    else merged.push({ role, content });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  const userText = `MENSAJE DEL USUARIO (texto no confiable):\n"""${message}"""${note ? `\n\nNOTA DEL REVISOR INTERNO (no es de la persona; corrige tu respuesta en silencio y no la menciones): ${note}` : ''}`;
  const last = merged[merged.length - 1];
  if (last && last.role === 'user') last.content += '\n' + userText;
  else merged.push({ role: 'user', content: userText });

  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.agent.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.agent.model,
      max_tokens: 900,
      system: `${systemPrompt(config)}\n\nDATOS:\n${context}`,
      messages: merged,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(data.error && data.error.message) || 'error'}`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseModelJson(text);
  // el motivo dice qué forma tenía (sin el texto, que puede traer datos de la persona)
  if (!parsed) throw new Error(`Respuesta del modelo no válida (${data.stop_reason || 'sin motivo'}, ${text.length} letras, empieza con "${text.trim().slice(0, 12).replace(/[^{}\[\]"\w\s:]/g, '')}")`);
  parsed.reply = toWhatsApp(parsed.reply);
  return parsed;
}

/** Markdown → formato de WhatsApp: **negrita** pasa a *negrita* y se quitan los # de encabezado. */
function toWhatsApp(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

/** Pregunta al revisor interno si la respuesta propuesta se puede enviar. Devuelve { ok, objection }; lanza si no puede revisar. */
async function reviewReply(config, { context, message, reply }, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.agent.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.agent.reviewerModel || config.agent.model,
      max_tokens: 400,
      system: brain.buildReviewerPrompt(config),
      messages: [{ role: 'user', content: `DATOS:\n${context}\n\nMENSAJE DE LA PERSONA (texto no confiable):\n"""${message}"""\n\nRESPUESTA PROPUESTA:\n"""${reply}"""` }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic (revisor) ${res.status}`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const verdict = parseReviewerJson(text);
  if (!verdict) throw new Error(`Respuesta del revisor no válida (${data.stop_reason || 'sin motivo'}, ${String(text).length} letras)`);
  return verdict;
}

/** Lee el veredicto del revisor aunque venga con saltos de línea crudos, "true" entre comillas o cortado después de "aprobada". */
function parseReviewerJson(text) {
  const raw = escapeRawInStrings(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(raw.slice(i, j + 1));
      const ap = typeof o.aprobada === 'string' ? o.aprobada.trim().toLowerCase() : o.aprobada;
      if (ap === true || ap === 'true') return { ok: true, objection: '' };
      if (ap === false || ap === 'false') return { ok: false, objection: String(o.objecion || '').slice(0, 300) };
    } catch {
      /* se rescata abajo */
    }
  }
  const ap = raw.match(/"aprobada"\s*:\s*"?(true|false)"?/i);
  if (!ap) return null;
  if (ap[1].toLowerCase() === 'true') return { ok: true, objection: '' };
  const ob = raw.match(/"objecion"\s*:\s*"((?:[^"\\]|\\.)*)/);
  let objection = '';
  try {
    objection = ob ? JSON.parse(`"${ob[1].replace(/\\$/, '')}"`) : '';
  } catch {
    objection = ob ? ob[1] : '';
  }
  return { ok: false, objection: String(objection).slice(0, 300) };
}

const MAX_REVISIONS = 2; // veces que el revisor puede devolver la respuesta antes de pasar el caso a una persona

/**
 * Pide la respuesta al modelo y la pasa por las defensas: filtro de enlaces/teléfonos y, si está encendido, el revisor interno
 * (que puede devolverla hasta MAX_REVISIONS veces). Devuelve { out, revisions } si se puede enviar, o { blocked } /
 * { rejected, original } si hay que pasar el caso a una persona. Lanza si el modelo o el revisor fallan (quien llama pasa el caso).
 */
async function generate(config, { context, history, message }, fetchImpl) {
  let out = await askModel(config, { context, history, message }, fetchImpl);
  let blocked = guardReply(out.reply, context);
  if (blocked) return { blocked, original: out.reply };
  if (!config.agent.reviewer) return { out, revisions: 0 };
  for (let n = 0; ; n++) {
    let rv;
    try {
      rv = await reviewReply(config, { context, message, reply: out.reply }, fetchImpl);
    } catch (err) {
      // si el revisor no responde o no se le entiende, la respuesta ya pasó el filtro de enlaces y teléfonos: se envía igual
      console.error('[agente] el revisor no pudo revisar; se envía la respuesta filtrada:', err.message);
      return { out, revisions: n, reviewerError: String(err.message).slice(0, 160) };
    }
    if (rv.ok) return { out, revisions: n };
    if (n >= MAX_REVISIONS) return { rejected: rv.objection || 'el revisor no aprobó la respuesta', original: out.reply };
    out = await askModel(config, { context, history, message, note: rv.objection || 'Revisa tu respuesta con tus valores.' }, fetchImpl);
    blocked = guardReply(out.reply, context);
    if (blocked) return { blocked, original: out.reply };
  }
}

const clip = (s, n) => String(s || '').slice(0, n);
const leaderGuide = require('./leader-guide');

async function buildContext(db, config, person, now, phone) {
  const mins = (
    await db.query(
      `SELECT mi.name FROM person_ministries pm JOIN ministries mi ON mi.id = pm.ministry_id WHERE pm.person_id = $1 ORDER BY mi.name`,
      [person.id]
    )
  ).rows.map((r) => r.name);
  const evs = (
    await db.query(
      `SELECT e.title, e.starts_at, e.location, ep.status
         FROM event_participants ep JOIN events e ON e.id = ep.event_id
        WHERE ep.person_id = $1 AND e.cancelled = FALSE AND e.starts_at > $2
        ORDER BY e.starts_at LIMIT 5`,
      [person.id, now]
    )
  ).rows;
  const dmy = (d) => new Date(d).toLocaleDateString('es-VE', { timeZone: config.timezone });
  // si quien escribe es líder de un grupo de cuidado, sabe de SU grupo (y solo de ese)
  const led = phone
    ? (
        await db.query(
          `SELECT g.name, g.meeting_day, g.meeting_time, g.place, g.token, g.link_active, g.profile_updated_at,
                  (SELECT max(r.meeting_date)::text FROM care_group_reports r WHERE r.group_id = g.id) AS last_report
             FROM care_groups g WHERE g.active AND g.leader_phone = $1 ORDER BY g.name LIMIT 5`,
          [phone]
        )
      ).rows
    : [];
  const ledLines = led.flatMap((g) => [
    `Esta persona lidera el grupo de cuidado "${g.name}"${[g.meeting_day, g.meeting_time].filter(Boolean).length ? ` (${[g.meeting_day, g.meeting_time].filter(Boolean).join(' ')})` : ''}${g.place ? ` en ${g.place}` : ''}.`,
    `- Último reporte semanal: ${g.last_report ? g.last_report.split('-').reverse().join('/') : 'aún no ha enviado ninguno'}.`,
    `- Datos del grupo: ${g.profile_updated_at ? `confirmados el ${dmy(g.profile_updated_at)}` : 'aún sin confirmar'}.`,
    ...(g.link_active && config.publicUrl ? [`- Su enlace para reportar la reunión: ${config.publicUrl}/g/${g.token}`, `- Su enlace para confirmar los datos del grupo: ${config.publicUrl}/g/${g.token}/datos`] : []),
  ]);
  // la guía del líder (solo lo confirmado) se la damos únicamente a quien lidera un grupo
  const guide = led.length ? await leaderGuide.confirmed(db) : [];
  const info = (await db.query('SELECT title, body FROM agent_knowledge WHERE active ORDER BY sort, id LIMIT 40')).rows;
  const infoText = clip(info.map((k) => `- ${k.title}: ${k.body}`).join('\n'), 4000);
  const first = String(person.full_name).split(' ')[0];
  return [
    `Iglesia: ${config.churchName}`,
    `Persona: ${first}${person.role ? ` (rol: ${person.role})` : ''}`,
    `Ministerios: ${mins.join(', ') || 'ninguno registrado'}`,
    'Próximos eventos de esta persona:',
    ...(evs.length
      ? evs.map((e) => `- ${e.title} · ${formatEventDate(e.starts_at, config.timezone)}${e.location ? ` · ${e.location}` : ''} · su respuesta: ${e.status}`)
      : ['- ninguno programado']),
    ...ledLines,
    ...(guide.length ? ['GUÍA DEL LÍDER (respuestas aprobadas por la iglesia; úsalas solo con este líder):', leaderGuide.contextText(guide)] : []),
    'INFORMACIÓN DE LA IGLESIA (la iglesia la escribió; puedes compartirla):',
    infoText || '- (todavía no hay; si preguntan algo general, escala)',
  ].join('\n');
}

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const onlyDigits = (s) => String(s).replace(/\D/g, '');

/**
 * Filtro de salida: la respuesta solo puede traer enlaces y teléfonos que ya estén en los datos que se le dieron al modelo.
 * Así una orden escondida en un mensaje no puede hacer que el asistente invente un enlace ni dé el teléfono de otra persona.
 * Devuelve el motivo del bloqueo, o null si está bien.
 */
function guardReply(reply, context) {
  const ctx = String(context || '');
  const ctxDigits = onlyDigits(ctx);
  for (const u of String(reply).match(URL_RE) || []) {
    if (!ctx.includes(u.replace(/[.,;:!?]+$/, ''))) return 'trae un enlace que no está en los datos';
  }
  for (const p of String(reply).match(PHONE_RE) || []) {
    const d = onlyDigits(p).replace(/^0+/, '');
    const core = d.length > 10 ? d.slice(-10) : d; // sin código de país: 0414… y +58 414… son el mismo número
    if (d.length >= 7 && !ctxDigits.includes(core)) return 'trae un teléfono que no está en los datos';
  }
  return null;
}

/**
 * Ensayo sin enviar nada ni guardar nada: qué contestaría el asistente si este número escribiera este mensaje.
 * No exige que el asistente esté encendido (sirve para probarlo antes), pero sí la clave del modelo.
 */
async function dryAnswer(ctx, { phone, text }, { fetchImpl, now = new Date() } = {}) {
  const { db, config } = ctx;
  if (!config.agent.apiKey) return { kind: 'sin_clave' };
  const message = String(text || '').trim().slice(0, 1000);
  if (!message) return { kind: 'vacio' };
  const { rows } = await db.query('SELECT id, full_name, role, active FROM people WHERE phone = $1 LIMIT 1', [phone]);
  const person = rows[0] && rows[0].active ? rows[0] : null;
  if (!person) return { kind: 'desconocido', reply: UNKNOWN_REPLY };
  if (isCrisis(message)) return { kind: 'crisis', reply: CRISIS_REPLY, escalate: true, reason: 'URGENTE: posible crisis (palabras de riesgo en el mensaje)' };
  try {
    const context = await buildContext(db, config, person, now, phone);
    const g = await generate(config, { context, history: [], message }, fetchImpl);
    if (g.blocked) return { kind: 'bloqueada', reply: FALLBACK_REPLY, escalate: true, reason: `Respuesta bloqueada: ${g.blocked}`, original: g.original };
    if (g.rejected) return { kind: 'rechazada', reply: FALLBACK_REPLY, escalate: true, reason: `Revisión interna: ${g.rejected}`, original: g.original };
    return { kind: 'modelo', ...g.out, revisions: g.revisions };
  } catch (err) {
    return { kind: 'error', error: String(err.message).slice(0, 200) };
  }
}

async function log(db, { phone, personId, direction, body, escalated = false, reason = null }) {
  await db.query(
    `INSERT INTO agent_messages (phone, person_id, direction, body, escalated, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [phone, personId || null, direction, String(body).slice(0, 4000), escalated, reason]
  );
}

/**
 * Atiende un mensaje entrante de WhatsApp. Devuelve null si el agente está apagado
 * (para que el flujo normal siga), o { handledAs } si ya respondió.
 */
async function handleInbound(ctx, { from, replyTo, body, type }, { fetchImpl, now = new Date() } = {}) {
  const { db, config, channels } = ctx;
  if (!config.agent.enabled || !config.agent.apiKey) return null;
  // con WeCall, cada respuesta queda anotada en Pruebas → Últimos avisos (enviada o el error exacto), sin texto ni número
  const note = config.whatsappProvider === 'wecall' && !channels.dryRun ? (r) => wecall.recordDelivery(db, { evento: 'respuesta_asistente', ...r }) : async () => {};
  const send = async (text) => {
    if (!channels.whatsapp.available) return note({ result: 'no_enviado', detail: 'WhatsApp no está disponible en el CRM' });
    try {
      const r = await channels.whatsapp.sendText(replyTo || from, text);
      await note({ result: 'enviado', detail: r && r.id ? `WeCall lo aceptó (id ${r.id})` : 'WeCall lo aceptó' });
    } catch (e) {
      console.error('[agente] no se pudo enviar:', e.message);
      await note({ result: 'envio_fallido', detail: String(e.message).replace(/\d{7,}/g, '…') });
    }
  };

  const { rows } = await db.query('SELECT id, full_name, role, active FROM people WHERE phone = $1 LIMIT 1', [from]);
  const person = rows[0] && rows[0].active ? rows[0] : null;

  const text = String(body || '').trim().slice(0, 1000);
  const { rows: cnt } = await db.query(
    // el límite diario cuenta las respuestas del asistente; los avisos fijos (como "voy a pasar tu mensaje") no gastan cupo
    `SELECT count(*)::int AS c FROM agent_messages
      WHERE phone = $1 AND direction = 'out' AND created_at > now() - interval '24 hours' AND NOT (btrim(body) = ANY($2::text[]))`,
    [from, [FALLBACK_REPLY, UNKNOWN_REPLY, CRISIS_REPLY, NOT_TEXT_REPLY]]
  );

  await log(db, { phone: from, personId: person && person.id, direction: 'in', body: text || `[${type}]` });

  if (cnt[0].c >= config.agent.maxRepliesPerDay) return { handledAs: 'agente_limite' };
  if (!person) {
    await send(UNKNOWN_REPLY);
    await log(db, { phone: from, direction: 'out', body: UNKNOWN_REPLY });
    return { handledAs: 'agente_desconocido' };
  }
  if (type !== 'text' || !text) {
    await send(NOT_TEXT_REPLY);
    await log(db, { phone: from, personId: person.id, direction: 'out', body: NOT_TEXT_REPLY });
    return { handledAs: 'agente_no_texto' };
  }

  let out;
  if (isCrisis(text)) {
    out = { reply: CRISIS_REPLY, escalate: true, reason: 'URGENTE: posible crisis (palabras de riesgo en el mensaje)' };
  } else {
    let context = '';
    try {
      const history = (
        await db.query(
          `SELECT direction, body FROM agent_messages
            WHERE phone = $1 AND created_at > now() - interval '12 hours'
              AND id < (SELECT max(id) FROM agent_messages WHERE phone = $1 AND direction = 'in')
            ORDER BY id DESC LIMIT 6`,
          [from]
        )
      ).rows.reverse();
      context = await buildContext(db, config, person, now, from);
      const g = await generate(config, { context, history, message: text }, fetchImpl);
      if (g.blocked) out = { reply: FALLBACK_REPLY, escalate: true, reason: `Respuesta bloqueada por seguridad: ${g.blocked}` };
      else if (g.rejected) out = { reply: FALLBACK_REPLY, escalate: true, reason: `Revisión interna: ${g.rejected}` };
      else out = g.out;
    } catch (err) {
      console.error('[agente] error:', err.message);
      out = { reply: FALLBACK_REPLY, escalate: true, reason: `El asistente no pudo responder; atender personalmente (${String(err.message).slice(0, 160)})` };
    }
  }

  await send(out.reply);
  await log(db, { phone: from, personId: person.id, direction: 'out', body: out.reply });
  if (out.escalate) {
    await db.query(
      `UPDATE agent_messages SET escalated = TRUE, reason = $2
        WHERE id = (SELECT max(id) FROM agent_messages WHERE phone = $1 AND direction = 'in')`,
      [from, out.reason || 'Pidió atención de un líder o pastor']
    );
  }
  return { handledAs: out.escalate ? 'agente_escalado' : 'agente' };
}

module.exports = { handleInbound, dryAnswer, guardReply, buildContext, askModel, reviewReply, generate, MAX_REVISIONS, parseModelJson, parseReviewerJson, toWhatsApp, isCrisis, systemPrompt, FALLBACK_REPLY, CRISIS_REPLY };
