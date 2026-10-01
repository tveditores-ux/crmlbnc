'use strict';
/**
 * Pruebas de integración contra un Postgres real.
 * Requiere DATABASE_URL_TEST (se borra y recrea el esquema "public" de esa base).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { loadConfig } = require('../src/config');
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');
const repo = require('../src/repo');
const rem = require('../src/reminders');
const { csvToRecords } = require('../src/csv');
const time = require('../src/time');

const URL_TEST = process.env.DATABASE_URL_TEST;
const DAY = 86400000;
const TZ = 'America/Caracas';

if (!URL_TEST) {
  test('integración (omitida: falta DATABASE_URL_TEST)', { skip: true }, () => {});
  return;
}

function fakeChannels() {
  const sent = [];
  const state = { fail: false };
  let n = 0;
  return {
    sent,
    state,
    dryRun: false,
    whatsapp: {
      available: true,
      async sendTemplate(to, args) {
        if (state.fail) throw new Error('WhatsApp 131026: Message undeliverable');
        sent.push({ channel: 'whatsapp', type: 'template', to, args });
        return { id: `wamid.${++n}` };
      },
      async sendText(to, text) {
        sent.push({ channel: 'whatsapp', type: 'text', to, text });
        return { id: `wamid.${++n}` };
      },
    },
    email: {
      available: true,
      async send(m) {
        if (state.fail) throw new Error('Resend 403');
        sent.push({ channel: 'email', ...m });
        return { id: `mail.${++n}` };
      },
    },
  };
}

const config = loadConfig({
  DATABASE_URL: URL_TEST,
  CHURCH_NAME: 'Iglesia de Prueba',
  PUBLIC_URL: 'http://localhost',
  ADMIN_PASSWORD: 'clave-de-prueba-123',
  SESSION_SECRET: 's'.repeat(48),
  DRY_RUN: 'false',
  WHATSAPP_APP_SECRET: 'app-secret',
  WHATSAPP_VERIFY_TOKEN: 'verificame',
});

let db;
let channels;
let ctx;

// "Ahora" fijo para las pruebas del programador: 10:00 en Caracas.
const NOW = new Date('2030-03-01T14:00:00Z');
const at = (msAfterNow) => new Date(NOW.getTime() + msAfterNow);

test.before(async () => {
  db = createPool(URL_TEST);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await migrate(db); // idempotente
  channels = fakeChannels();
  ctx = { db, config, channels };
});

test.after(async () => {
  await db.end();
});

async function addPerson(name, phone, { optIn = true, channel = 'whatsapp', email = null } = {}) {
  const { value, errors } = repo.validatePerson(
    { full_name: name, phone, email, opt_in: optIn, preferred_channel: channel },
    '58'
  );
  assert.deepEqual(errors, []);
  return repo.savePerson(db, null, value);
}

async function participant(eventId, personId) {
  return (await db.query('SELECT * FROM event_participants WHERE event_id=$1 AND person_id=$2', [eventId, personId])).rows[0];
}

test('importación: con errores no guarda nada; luego crea y actualiza', async () => {
  const bad = csvToRecords('nombre;telefono;correo;ministerios;acepta_mensajes\nAna;0414-1111111;;Diáconos;si\nBeto;12;;Diáconos;si\n');
  const r1 = await repo.importPeople(db, bad.records, '58');
  assert.equal(r1.errors.length, 1);
  assert.equal(r1.errors[0].line, 3);
  assert.equal((await db.query('SELECT count(*)::int AS c FROM people')).rows[0].c, 0);

  const good = csvToRecords(
    'Nombre,Teléfono,Correo,Ministerios,Rol,Acepta mensajes,Canal\n' +
      'Ana Díaz,0414-1111111,,"Diáconos; Alabanza",Coordinadora,si,whatsapp\n' +
      'Beto Ruiz,0424-2222222,beto@ejemplo.com,Diáconos,,si,ambos\n' +
      'Carla Gil,,carla@ejemplo.com,Medios,,no,correo\n'
  );
  const preview = await repo.importPeople(db, good.records, '58', { dryRun: true });
  assert.equal(preview.created, 3);
  assert.equal((await db.query('SELECT count(*)::int AS c FROM people')).rows[0].c, 0);

  const r2 = await repo.importPeople(db, good.records, '58');
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.created, 3);
  assert.deepEqual(r2.ministriesCreated.sort(), ['Alabanza', 'Diáconos', 'Medios']);

  const again = csvToRecords('nombre,telefono,ministerios,acepta_mensajes\nAna María Díaz,+58 414 111 1111,Medios,si\n');
  const r3 = await repo.importPeople(db, again.records, '58');
  assert.equal(r3.updated, 1);
  const ana = (await db.query(`SELECT * FROM people WHERE phone='584141111111'`)).rows[0];
  assert.equal(ana.full_name, 'Ana María Díaz');
  const mins = (
    await db.query(
      'SELECT m.name FROM person_ministries pm JOIN ministries m ON m.id=pm.ministry_id WHERE pm.person_id=$1 ORDER BY 1',
      [ana.id]
    )
  ).rows.map((x) => x.name);
  assert.deepEqual(mins, ['Alabanza', 'Diáconos', 'Medios']); // suma ministerios, no los borra

  const dup = csvToRecords('nombre,telefono\nX,0414-5555555\nY,04145555555\n');
  const r4 = await repo.importPeople(db, dup.records, '58');
  assert.match(r4.errors[0].errors[0], /Repetido con la línea 2/);
});

test('programador: 1 mes, 1 semana, 1 día, sin duplicados y respetando respuestas', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  channels.sent.length = 0;

  const mid = await repo.ensureMinistry(db, 'Diáconos');
  const ana = await addPerson('Ana Díaz', '0414-1111111');
  const beto = await addPerson('Beto Ruiz', '0424-2222222');
  const caro = await addPerson('Caro Sin Permiso', '0412-3333333', { optIn: false });
  const dani = await addPerson('Dani Correo', null, { channel: 'email', email: 'dani@ejemplo.com' });
  for (const p of [ana, beto, caro, dani]) await repo.setPersonMinistries(db, p, [mid]);

  const startsAt = at(30 * DAY - 2 * 3600 * 1000); // 31 de marzo, 8:00 a. m. en Caracas
  const { eventId, added } = await repo.saveEvent(
    db,
    null,
    { title: 'Reunión de diáconos', starts_at: startsAt, location: 'Templo', description: '' },
    [mid]
  );
  assert.equal(added, 4);

  // Fuera de horario (7:00 local) no se envía nada.
  const early = await rem.runReminders({ ...ctx, now: new Date('2030-03-01T11:00:00Z') });
  assert.equal(early.outsideWindow, true);
  assert.equal(channels.sent.length, 0);

  // 1 mes antes: Ana, Beto (WhatsApp) y Dani (correo). Caro no aceptó.
  const s1 = await rem.runReminders({ ...ctx, now: NOW });
  assert.equal(s1.sent, 3);
  assert.deepEqual(channels.sent.map((m) => m.to).sort(), ['584141111111', '584242222222', 'dani@ejemplo.com'].sort());
  const waMsg = channels.sent.find((m) => m.to === '584141111111');
  assert.equal(waMsg.args.name, 'recordatorio_evento');
  assert.equal(waMsg.args.bodyParams[0], 'Ana');
  assert.equal(waMsg.args.bodyParams[1], 'Reunión de diáconos');
  assert.equal(waMsg.args.bodyParams[2], 'en un mes');
  const tokenAna = (await participant(eventId, ana)).token;
  assert.deepEqual(waMsg.args.buttonPayloads, [`R:${tokenAna}:si`, `R:${tokenAna}:no`]);
  const mail = channels.sent.find((m) => m.channel === 'email');
  assert.match(mail.subject, /Reunión de diáconos/);
  assert.match(mail.html, new RegExp(`/c/${(await participant(eventId, dani)).token}\\?r=si`));

  // Segunda pasada en la misma ventana: nada nuevo.
  const s2 = await rem.runReminders({ ...ctx, now: at(3600 * 1000) });
  assert.equal(s2.sent, 0);
  assert.equal(channels.sent.length, 3);

  // Ana confirma, Beto dice que no.
  await db.query(`UPDATE event_participants SET status='confirmado' WHERE event_id=$1 AND person_id=$2`, [eventId, ana]);
  await db.query(`UPDATE event_participants SET status='no_puede' WHERE event_id=$1 AND person_id=$2`, [eventId, beto]);

  // 1 semana antes: solo Dani (pendiente).
  channels.sent.length = 0;
  const s3 = await rem.runReminders({ ...ctx, now: new Date(startsAt.getTime() - 7 * DAY + 3 * 3600 * 1000) });
  assert.equal(s3.sent, 1);
  assert.equal(channels.sent[0].to, 'dani@ejemplo.com');

  // 1 día antes: Ana (confirmada) y Dani; Beto no.
  channels.sent.length = 0;
  const s4 = await rem.runReminders({ ...ctx, now: new Date(startsAt.getTime() - DAY + 3600 * 1000) });
  assert.equal(s4.sent, 2);
  assert.deepEqual(channels.sent.map((m) => m.to).sort(), ['584141111111', 'dani@ejemplo.com']);
  assert.equal(channels.sent.find((m) => m.to === '584141111111').args.bodyParams[2], 'mañana');

  // Evento cancelado: nada.
  await db.query('UPDATE events SET cancelled=TRUE WHERE id=$1', [eventId]);
  await db.query(`DELETE FROM notifications`);
  channels.sent.length = 0;
  const s5 = await rem.runReminders({ ...ctx, now: new Date(startsAt.getTime() - DAY + 3600 * 1000) });
  assert.equal(s5.sent, 0);
});

test('evento creado con pocos días: no manda el de 1 mes ni el de 1 semana tarde', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  channels.sent.length = 0;
  const p = await addPerson('Eva', '0414-4444444');
  const startsAt = at(3 * DAY);
  const { eventId } = await repo.saveEvent(db, null, { title: 'Ensayo', starts_at: startsAt, location: '', description: '' }, []);
  await repo.addParticipant(db, eventId, p);

  const s = await rem.runReminders({ ...ctx, now: NOW });
  assert.equal(s.sent, 1);
  const kinds = (await db.query('SELECT kind FROM notifications')).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['1w']); // la ventana vigente es la de "1 semana"
  assert.equal(channels.sent[0].args.bodyParams[2], 'en 3 días');
  assert.equal(channels.sent[0].args.bodyParams[4], 'Iglesia de Prueba'); // sin lugar: usa el nombre de la iglesia
});

test('envío fallido se registra y se reintenta después de 30 minutos (máximo 3)', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  channels.sent.length = 0;
  const p = await addPerson('Fede', '0414-6666666');
  const { eventId } = await repo.saveEvent(db, null, { title: 'Culto', starts_at: at(5 * DAY), location: 'X', description: '' }, []);
  await repo.addParticipant(db, eventId, p);

  channels.state.fail = true;
  const s1 = await rem.runReminders({ ...ctx, now: NOW });
  assert.equal(s1.failed, 1);
  let n = (await db.query('SELECT * FROM notifications')).rows[0];
  assert.equal(n.status, 'fallido');
  assert.match(n.error, /131026/);

  // Inmediatamente: no reintenta.
  const s2 = await rem.runReminders({ ...ctx, now: NOW });
  assert.equal(s2.failed + s2.sent, 0);

  // Después de 30 minutos y con el canal sano: reintenta y queda enviado.
  channels.state.fail = false;
  await db.query(`UPDATE notifications SET updated_at = now() - interval '31 minutes'`);
  const s3 = await rem.runReminders({ ...ctx, now: NOW });
  assert.equal(s3.sent, 1);
  n = (await db.query('SELECT * FROM notifications')).rows[0];
  assert.equal(n.status, 'enviado');
  assert.equal(n.attempts, 2);

  // Tope de 3 intentos.
  channels.state.fail = true;
  await db.query(`UPDATE notifications SET status='fallido', attempts=3, updated_at = now() - interval '2 hours'`);
  const s4 = await rem.runReminders({ ...ctx, now: NOW });
  assert.equal(s4.failed + s4.sent, 0);
  channels.state.fail = false;
});

test('envío manual solo a pendientes', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  channels.sent.length = 0;
  const a = await addPerson('Gabi', '0414-7777777');
  const b = await addPerson('Hugo', '0414-8888888');
  const { eventId } = await repo.saveEvent(db, null, { title: 'Taller', starts_at: at(20 * DAY), location: '', description: '' }, []);
  await repo.addParticipant(db, eventId, a);
  await repo.addParticipant(db, eventId, b);
  await db.query(`UPDATE event_participants SET status='confirmado' WHERE person_id=$1`, [b]);
  const s = await rem.sendManual({ ...ctx, now: NOW }, eventId);
  assert.equal(s.sent, 1);
  assert.equal(channels.sent[0].to, '584147777777');
  // Se puede repetir (los manuales no se bloquean por duplicado).
  const s2 = await rem.sendManual({ ...ctx, now: NOW }, eventId);
  assert.equal(s2.sent, 1);
});

/* ---------------- Pruebas por HTTP ---------------- */

async function startServer() {
  const app = createApp(ctx);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
}

test('webhook de WhatsApp: verificación, firma, botones, texto libre y estados', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  await db.query('TRUNCATE inbound_messages');
  channels.sent.length = 0;
  const ana = await addPerson('Ana', '0414-1111111');
  const ev1 = (await repo.saveEvent(db, null, { title: 'Ensayo', starts_at: new Date(Date.now() + 2 * DAY), location: '', description: '' }, [])).eventId;
  const ev2 = (await repo.saveEvent(db, null, { title: 'Culto', starts_at: new Date(Date.now() + 9 * DAY), location: '', description: '' }, [])).eventId;
  await repo.addParticipant(db, ev1, ana);
  await repo.addParticipant(db, ev2, ana);
  const tok2 = (await participant(ev2, ana)).token;

  const { server, base } = await startServer();
  try {
    // Verificación del webhook
    let r = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verificame&hub.challenge=12345`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '12345');
    r = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=1`);
    assert.equal(r.status, 403);

    const post = (obj, signature) => {
      const body = JSON.stringify(obj);
      return fetch(`${base}/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature || sign(body) },
        body,
      });
    };
    const wrap = (value) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] });

    // Firma inválida
    r = await post(wrap({ messages: [] }), 'sha256=00');
    assert.equal(r.status, 401);

    // Botón "Confirmo" del evento 2
    r = await post(
      wrap({ messages: [{ from: '584141111111', type: 'button', button: { payload: `R:${tok2}:si`, text: 'Confirmo' } }] })
    );
    assert.equal(r.status, 200);
    assert.equal((await participant(ev2, ana)).status, 'confirmado');
    assert.equal((await participant(ev2, ana)).response_channel, 'whatsapp');
    assert.equal((await participant(ev1, ana)).status, 'pendiente');
    const ack = channels.sent.find((m) => m.type === 'text');
    assert.match(ack.text, /Culto/);

    // Texto libre "No puedo" → el evento pendiente más próximo (ev1)
    await post(wrap({ messages: [{ from: '584141111111', type: 'text', text: { body: 'No puedo, disculpen' } }] }));
    assert.equal((await participant(ev1, ana)).status, 'no_puede');

    // Mensaje que no se entiende → queda registrado sin interpretar
    await post(wrap({ messages: [{ from: '584141111111', type: 'text', text: { body: '¿A qué hora es?' } }] }));
    const inbound = (await db.query('SELECT handled_as FROM inbound_messages ORDER BY id')).rows.map((x) => x.handled_as);
    assert.deepEqual(inbound, ['confirmado', 'no_puede', 'sin_interpretar']);

    // Estados de entrega: no retroceden (read no vuelve a delivered)
    const pid = (await participant(ev2, ana)).id;
    await db.query(
      `INSERT INTO notifications (participant_id, kind, channel, status, provider_message_id) VALUES ($1,'1w','whatsapp','enviado','wamid.X')`,
      [pid]
    );
    await post(wrap({ statuses: [{ id: 'wamid.X', status: 'read' }] }));
    await post(wrap({ statuses: [{ id: 'wamid.X', status: 'delivered' }] }));
    assert.equal((await db.query(`SELECT delivery_status FROM notifications WHERE provider_message_id='wamid.X'`)).rows[0].delivery_status, 'read');
    await post(wrap({ statuses: [{ id: 'wamid.X', status: 'failed', errors: [{ code: 131049, title: 'Not delivered' }] }] }));
    const failed = (await db.query(`SELECT status, error FROM notifications WHERE provider_message_id='wamid.X'`)).rows[0];
    assert.equal(failed.status, 'fallido');
    assert.match(failed.error, /131049/);
  } finally {
    server.close();
  }
});

test('página de confirmación por enlace: GET no cambia nada, POST sí', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  const p = await addPerson('Iris', null, { channel: 'email', email: 'iris@ejemplo.com' });
  const { eventId } = await repo.saveEvent(db, null, { title: 'Retiro', starts_at: new Date(Date.now() + 4 * DAY), location: 'Campamento', description: '' }, []);
  await repo.addParticipant(db, eventId, p);
  const tok = (await participant(eventId, p)).token;
  const { server, base } = await startServer();
  try {
    let r = await fetch(`${base}/c/${tok}?r=si`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Retiro/);
    assert.match(html, /Campamento/);
    assert.equal((await participant(eventId, p)).status, 'pendiente');

    r = await fetch(`${base}/c/${tok}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'r=si',
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Gracias por responder/);
    const row = await participant(eventId, p);
    assert.equal(row.status, 'confirmado');
    assert.equal(row.response_channel, 'enlace');

    r = await fetch(`${base}/c/noexiste123`);
    assert.equal(r.status, 404);
  } finally {
    server.close();
  }
});

test('panel: inicio de sesión, todas las páginas cargan, formularios funcionan', async () => {
  await db.query('TRUNCATE people, ministries, events RESTART IDENTITY CASCADE');
  const { server, base } = await startServer();
  const form = (obj) => new URLSearchParams(obj).toString();
  try {
    let r = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/entrar');

    r = await fetch(`${base}/entrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'mala' }),
      redirect: 'manual',
    });
    assert.equal(r.status, 401);

    r = await fetch(`${base}/entrar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'clave-de-prueba-123' }),
      redirect: 'manual',
    });
    assert.equal(r.status, 303);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const H = { Cookie: cookie };
    const P = { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' };

    // Crear ministerio y persona por formulario
    r = await fetch(`${base}/ministerios`, { method: 'POST', headers: P, body: form({ name: 'Medios' }), redirect: 'manual' });
    assert.equal(r.status, 303);
    const mid = (await db.query(`SELECT id FROM ministries WHERE name='Medios'`)).rows[0].id;
    const body = new URLSearchParams({ full_name: 'Juan Prueba', phone: '0414-9999999', preferred_channel: 'whatsapp', opt_in: '1', active: '1' });
    body.append('ministries', String(mid));
    r = await fetch(`${base}/personas`, { method: 'POST', headers: P, body: body.toString(), redirect: 'manual' });
    assert.equal(r.status, 303);
    const juan = (await db.query(`SELECT * FROM people WHERE phone='584149999999'`)).rows[0];
    assert.ok(juan && juan.opt_in);

    // Duplicado: muestra error y no crea
    r = await fetch(`${base}/personas`, { method: 'POST', headers: P, body: form({ full_name: 'Otro', phone: '04149999999', preferred_channel: 'whatsapp' }) });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Ya existe otra persona/);

    // Crear evento con hora local
    const ev = new URLSearchParams({ title: 'Reunión de medios', starts_at: '2031-01-10T16:00', location: 'Sala' });
    ev.append('ministries', String(mid));
    r = await fetch(`${base}/eventos`, { method: 'POST', headers: P, body: ev.toString(), redirect: 'manual' });
    assert.equal(r.status, 303);
    const event = (await db.query(`SELECT * FROM events WHERE title='Reunión de medios'`)).rows[0];
    assert.equal(new Date(event.starts_at).toISOString(), '2031-01-10T20:00:00.000Z');
    assert.equal(time.dateToLocalInput(event.starts_at, TZ), '2031-01-10T16:00');
    assert.ok(await participant(event.id, juan.id), 'Juan quedó convocado por su ministerio');

    // Importar por el panel (revisión)
    r = await fetch(`${base}/personas/importar`, {
      method: 'POST',
      headers: P,
      body: form({ csv: 'nombre;telefono;ministerios;acepta_mensajes\nLuz;0414-1212121;Medios;si', accion: 'revisar' }),
    });
    assert.match(await r.text(), /Todo correcto: 1 nuevas/);

    // Envío manual desde el panel
    r = await fetch(`${base}/eventos/${event.id}/enviar`, { method: 'POST', headers: P, redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.match(new URL(r.headers.get('location'), base).searchParams.get('ok'), /Enviados: 1/);

    // Todas las páginas GET responden 200
    for (const path of [
      '/',
      '/personas',
      '/personas?q=juan',
      `/personas?m=${mid}`,
      '/personas/nueva',
      `/personas/${juan.id}`,
      '/personas/importar',
      '/ministerios',
      `/ministerios/${mid}`,
      '/eventos',
      '/eventos?pasados=1',
      '/eventos/nuevo',
      `/eventos/${event.id}`,
      `/eventos/${event.id}/editar`,
      '/mensajes',
      '/pruebas',
    ]) {
      r = await fetch(base + path, { headers: H });
      assert.equal(r.status, 200, path);
      const t = await r.text();
      assert.ok(!/undefined|NaN|\[object Object\]/.test(t), `contenido raro en ${path}`);
    }

    r = await fetch(`${base}/personas/plantilla.csv`, { headers: H });
    assert.match(await r.text(), /nombre,telefono,correo,ministerios/);
    r = await fetch(`${base}/personas/exportar.csv`, { headers: H });
    assert.match(await r.text(), /Juan Prueba,\+584149999999/);

    // Cambiar estado manualmente
    const pid = (await participant(event.id, juan.id)).id;
    await fetch(`${base}/eventos/${event.id}/participantes/${pid}/estado`, { method: 'POST', headers: P, body: form({ status: 'confirmado' }), redirect: 'manual' });
    assert.equal((await participant(event.id, juan.id)).status, 'confirmado');

    // POST sin sesión → 401
    r = await fetch(`${base}/ministerios`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ name: 'X' }) });
    assert.equal(r.status, 401);

    r = await fetch(`${base}/health`);
    assert.deepEqual(await r.json(), { ok: true });
  } finally {
    server.close();
  }
});
