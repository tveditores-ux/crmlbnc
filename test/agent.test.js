'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('../src/agent');

const config = {
  churchName: 'Iglesia de Prueba',
  timezone: 'America/Caracas',
  agent: { enabled: true, apiKey: 'sk-test', model: 'claude-test', maxRepliesPerDay: 2 },
};

/** Base de datos falsa mínima: responde por el texto de la consulta. */
function fakeDb({ person = { id: 1, full_name: 'María Pérez', role: 'Líder', active: true }, outs = 0 } = {}) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      if (/FROM people WHERE phone/.test(sql)) return { rows: person ? [person] : [] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ c: outs }] };
      if (/INSERT INTO agent_messages/.test(sql)) {
        log.push({ kind: 'insert', direction: params[2], body: params[3] });
        return { rows: [] };
      }
      if (/UPDATE agent_messages SET escalated/.test(sql)) {
        log.push({ kind: 'escalate', reason: params[1] });
        return { rows: [] };
      }
      return { rows: [] }; // historial, ministerios y eventos vacíos
    },
  };
}

function fakeChannels() {
  const sent = [];
  return { sent, whatsapp: { available: true, sendText: async (to, text) => sent.push({ to, text }) } };
}

const okFetch = (obj) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }),
});

test('detecta mensajes de crisis sin importar tildes ni mayúsculas', () => {
  assert.equal(agent.isCrisis('Quiero MORIRME'), true);
  assert.equal(agent.isCrisis('mi esposo me pega'), true);
  assert.equal(agent.isCrisis('¿A qué hora es el culto del domingo?'), false);
});

test('parseModelJson acepta bloques de código y rechaza respuestas vacías', () => {
  const ok = agent.parseModelJson('```json\n{"respuesta":"Hola","escalar":true,"motivo":"pide pastor"}\n```');
  assert.deepEqual(ok, { reply: 'Hola', escalate: true, reason: 'pide pastor' });
  assert.equal(agent.parseModelJson('no es json'), null);
  assert.equal(agent.parseModelJson('{"respuesta":"","escalar":false}'), null);
});

test('el prompt limita el alcance y trata el mensaje como no confiable', () => {
  const p = agent.systemPrompt(config);
  assert.match(p, /grupos de cuidado/);
  assert.match(p, /ajeno a la iglesia/i);
  assert.match(p, /no confiable/);
  assert.match(p, /datos de otras personas/i);
});

test('askModel envía el contexto de la persona y el mensaje entre comillas', async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"respuesta":"Claro","escalar":false,"motivo":""}' }] }) };
  };
  const out = await agent.askModel(config, { context: 'Persona: María', history: [], message: '¿Cuándo es el GdC?' }, fetchImpl);
  assert.equal(out.reply, 'Claro');
  assert.match(body.system, /Persona: María/);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /¿Cuándo es el GdC\?/);
});

test('apagado: no responde y deja seguir el flujo normal', async () => {
  const off = { ...config, agent: { ...config.agent, enabled: false } };
  const r = await agent.handleInbound({ db: fakeDb(), config: off, channels: fakeChannels() }, { from: '58414', body: 'hola', type: 'text' });
  assert.equal(r, null);
});

test('número desconocido: respuesta fija, sin llamar al modelo', async () => {
  const ch = fakeChannels();
  let called = false;
  const r = await agent.handleInbound(
    { db: fakeDb({ person: null }), config, channels: ch },
    { from: '58414', body: 'hola', type: 'text' },
    { fetchImpl: async () => { called = true; } }
  );
  assert.equal(r.handledAs, 'agente_desconocido');
  assert.equal(called, false);
  assert.match(ch.sent[0].text, /líder de grupo de cuidado/);
});

test('crisis: respuesta fija, escala como urgente y no llama al modelo', async () => {
  const ch = fakeChannels();
  const db = fakeDb();
  let called = false;
  const r = await agent.handleInbound(
    { db, config, channels: ch },
    { from: '58414', body: 'ya no quiero vivir', type: 'text' },
    { fetchImpl: async () => { called = true; } }
  );
  assert.equal(r.handledAs, 'agente_escalado');
  assert.equal(called, false);
  assert.equal(ch.sent[0].text, agent.CRISIS_REPLY);
  assert.match(db.log.find((l) => l.kind === 'escalate').reason, /URGENTE/);
});

test('consulta normal: responde con lo que devuelve el modelo', async () => {
  const ch = fakeChannels();
  const r = await agent.handleInbound(
    { db: fakeDb(), config, channels: ch },
    { from: '58414', body: '¿A qué hora es el grupo de cuidado?', type: 'text' },
    { fetchImpl: okFetch({ respuesta: 'Pregúntale a tu líder de GdC.', escalar: false, motivo: '' }) }
  );
  assert.equal(r.handledAs, 'agente');
  assert.equal(ch.sent[0].text, 'Pregúntale a tu líder de GdC.');
});

test('si el modelo falla, avisa que lo atenderá una persona y escala', async () => {
  const ch = fakeChannels();
  const db = fakeDb();
  const r = await agent.handleInbound(
    { db, config, channels: ch },
    { from: '58414', body: 'necesito orientación', type: 'text' },
    { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }
  );
  assert.equal(r.handledAs, 'agente_escalado');
  assert.equal(ch.sent[0].text, agent.FALLBACK_REPLY);
  assert.ok(db.log.some((l) => l.kind === 'escalate'));
});

test('límite diario: no responde más', async () => {
  const ch = fakeChannels();
  const r = await agent.handleInbound(
    { db: fakeDb({ outs: 2 }), config, channels: ch },
    { from: '58414', body: 'otra pregunta', type: 'text' },
    { fetchImpl: async () => { throw new Error('no debería llamarse'); } }
  );
  assert.equal(r.handledAs, 'agente_limite');
  assert.equal(ch.sent.length, 0);
});
