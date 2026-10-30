'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const members = require('../src/members');
const { openTestDb } = require('./helpers/db');

// Todos los datos de estas pruebas son inventados.
async function withDb(t, fn) {
  const h = await openTestDb();
  if (!h) return t.skip('sin base de datos de prueba (instala @electric-sql/pglite o define DATABASE_URL_TEST)');
  try {
    await fn(h.db);
  } finally {
    await h.close();
  }
}

const row = async (db, phone) => (await db.query('SELECT * FROM people WHERE phone = $1', [phone])).rows[0];
const count = async (db, where = 'TRUE') => (await db.query(`SELECT count(*)::int AS n FROM people WHERE ${where}`)).rows[0].n;

test('la migración agrega las tres columnas con sus valores por defecto y respeta la restricción', async (t) => {
  await withDb(t, async (db) => {
    const cols = (
      await db.query(`SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'people' AND column_name IN ('membership','whatsapp_name','in_official_group') ORDER BY column_name`)
    ).rows;
    assert.deepEqual(cols.map((c) => c.column_name), ['in_official_group', 'membership', 'whatsapp_name']);
    assert.ok(cols.every((c) => c.is_nullable === 'NO'));
    // una persona que existía antes queda "por clasificar", sin grupo y sin nombre de WhatsApp
    await db.query(`INSERT INTO people (full_name, phone, opt_in) VALUES ('Persona Antigua', '584140000001', TRUE)`);
    const p = await row(db, '584140000001');
    assert.deepEqual([p.membership, p.whatsapp_name, p.in_official_group, p.opt_in], ['', '', false, true]);
    // solo '', miembro o amigo
    await db.query(`UPDATE people SET membership = 'miembro' WHERE id = $1`, [p.id]);
    await db.query(`UPDATE people SET membership = 'amigo' WHERE id = $1`, [p.id]);
    await db.query(`UPDATE people SET membership = '' WHERE id = $1`, [p.id]);
    await assert.rejects(db.query(`UPDATE people SET membership = 'visitante' WHERE id = $1`, [p.id]));
    await assert.rejects(db.query(`UPDATE people SET membership = NULL WHERE id = $1`, [p.id]));
  });
});

test('tipo, sí y rol: lectura de los valores del archivo', () => {
  assert.equal(members.parseTipo(''), '');
  assert.equal(members.parseTipo(' Miembro '), 'miembro');
  assert.equal(members.parseTipo('AMIGOS'), 'amigo');
  assert.equal(members.parseTipo('visitante'), null);
  assert.equal(members.addAdminRole(''), 'Admin grupo WhatsApp');
  assert.equal(members.addAdminRole('Diácono'), 'Diácono, Admin grupo WhatsApp');
  assert.equal(members.addAdminRole('Diácono, Admin grupo WhatsApp'), 'Diácono, Admin grupo WhatsApp'); // no se repite
  assert.equal(members.tipoLabel(''), 'Por clasificar');
  assert.equal(members.tipoLabel('amigo'), 'Amigo');
  const v = members.validateRow({ nombre: '(sin nombre)', telefono: '0414-000.00.07', admin: 'Sí', origen_del_nombre: '' });
  assert.deepEqual([v.errors, v.value.fullName, v.value.admin, v.value.phone], [[], '0414-000.00.07', true, '584140000007']);
  assert.match(members.validateRow({ nombre: 'X', telefono: '' }).errors[0], /Falta el teléfono/);
  assert.match(members.validateRow({ nombre: 'X', telefono: '12' }).errors[0], /Teléfono no válido/);
  assert.match(members.validateRow({ nombre: 'X', telefono: '0414-000.00.01', tipo: 'otro' }).errors[0], /Tipo no válido/);
});

const CSV = [
  'Nombre,Teléfono,Admin,Origen del nombre',
  'Persona Uno,0414-000.00.01,No,Contacto guardado',
  'Perfil Dos,+58 414 000 00 02,Sí,Perfil de WhatsApp',
  '(sin nombre),04140000003,No,',
  ',0414-000.00.04,Sí,',
  'Perfil Cinco,0414-000.00.05,No,Perfil de WhatsApp',
].join('\n');

test('importar: crea a todos sin consentimiento, con grupo oficial, por clasificar, y el teléfono como nombre si no hay', async (t) => {
  await withDb(t, async (db) => {
    const rep = await members.importGroup(db, CSV, '58');
    assert.deepEqual([rep.created, rep.updated, rep.errors.length], [5, 0, 0]);
    assert.equal(await count(db), 5);
    assert.equal(await count(db, 'opt_in'), 0); // estar en el grupo no es aceptar recordatorios
    assert.equal(await count(db, 'in_official_group'), 5);
    assert.equal(await count(db, `membership = ''`), 5);
    const dos = await row(db, '584140000002');
    assert.deepEqual([dos.full_name, dos.whatsapp_name, dos.role, dos.opt_in, dos.active, dos.preferred_channel], ['Perfil Dos', 'Perfil Dos', 'Admin grupo WhatsApp', false, true, 'whatsapp']);
    const uno = await row(db, '584140000001');
    assert.deepEqual([uno.full_name, uno.whatsapp_name, uno.role], ['Persona Uno', '', '']); // el origen no es el perfil: no se guarda
    assert.equal((await row(db, '584140000003')).full_name, '0414-000.00.03'); // "(sin nombre)"
    const cuatro = await row(db, '584140000004');
    assert.deepEqual([cuatro.full_name, cuatro.role, cuatro.whatsapp_name], ['0414-000.00.04', 'Admin grupo WhatsApp', '']); // nombre vacío
    assert.equal((await row(db, '584140000005')).whatsapp_name, 'Perfil Cinco');
  });
});

test('importar: quien ya existe se actualiza por teléfono sin pisar su nombre, rol, correo ni consentimiento', async (t) => {
  await withDb(t, async (db) => {
    await db.query(`INSERT INTO people (full_name, phone, email, role, opt_in, active, membership) VALUES
      ('Nombre Propio', '584140000002', 'dos@ejemplo.com', 'Coordinador', TRUE, TRUE, 'miembro'),
      ('Inactiva Tres', '584140000003', NULL, '', FALSE, FALSE, '')`);
    const before = await count(db);
    const rep = await members.importGroup(db, CSV, '58');
    assert.deepEqual([rep.created, rep.updated], [3, 2]);
    assert.equal(await count(db), before + 3); // nadie duplicado
    const dos = await row(db, '584140000002');
    assert.equal(dos.full_name, 'Nombre Propio'); // no se pisa el nombre
    assert.equal(dos.email, 'dos@ejemplo.com'); // ni el correo
    assert.equal(dos.opt_in, true); // ni el consentimiento
    assert.equal(dos.role, 'Coordinador, Admin grupo WhatsApp'); // el rol solo crece
    assert.equal(dos.membership, 'miembro'); // el archivo no trae tipo: se respeta el que tenía
    assert.equal(dos.whatsapp_name, 'Perfil Dos'); // el nombre de perfil sí se guarda
    assert.equal(dos.in_official_group, true);
    const tres = await row(db, '584140000003');
    assert.deepEqual([tres.full_name, tres.active, tres.opt_in, tres.in_official_group], ['Inactiva Tres', false, false, true]);
    // repetir la carga: ahora todos existen, nada cambia ni se repite el rol
    const again = await members.importGroup(db, CSV, '58');
    assert.deepEqual([again.created, again.updated], [0, 5]);
    assert.equal(await count(db), before + 3);
    assert.equal((await row(db, '584140000002')).role, 'Coordinador, Admin grupo WhatsApp');
    assert.equal((await row(db, '584140000004')).role, 'Admin grupo WhatsApp');
  });
});

test('importar: la columna tipo se aplica si viene, y las personas nuevas siguen sin consentimiento', async (t) => {
  await withDb(t, async (db) => {
    await db.query(`INSERT INTO people (full_name, phone, membership) VALUES ('Ya Clasificada', '584140000001', 'amigo')`);
    const csv = ['Nombre,Teléfono,Admin,Origen del nombre,Tipo', 'A,0414-000.00.01,No,,miembro', 'B,0414-000.00.02,No,,Amigo', 'C,0414-000.00.03,No,,'].join('\n');
    const rep = await members.importGroup(db, csv, '58');
    assert.deepEqual([rep.created, rep.updated], [2, 1]);
    assert.equal((await row(db, '584140000001')).membership, 'miembro');
    assert.equal((await row(db, '584140000002')).membership, 'amigo');
    assert.equal((await row(db, '584140000003')).membership, '');
    assert.equal(await count(db, 'opt_in'), 0);
  });
});

test('importar: revisar no guarda; los errores se reportan por línea y no se guarda nada', async (t) => {
  await withDb(t, async (db) => {
    await db.query(`INSERT INTO people (full_name, phone) VALUES ('Existente', '584140000001')`);
    const dry = await members.importGroup(db, CSV, '58', { dryRun: true });
    assert.deepEqual([dry.created, dry.updated, dry.errors.length], [4, 1, 0]);
    assert.equal(await count(db), 1);
    assert.equal(await count(db, 'in_official_group'), 0);

    const bad = ['Nombre,Teléfono,Admin,Origen del nombre,Tipo', 'Bien,0414-000.00.10,No,,', 'Sin Teléfono,,No,,', 'Teléfono Malo,12,No,,', 'Tipo Raro,0414-000.00.11,No,,visitante', 'Repetida,0414-000.00.10,No,,'].join('\n');
    const rep = await members.importGroup(db, bad, '58');
    assert.equal(rep.errors.length, 4);
    assert.deepEqual(rep.errors.map((e) => e.line), [3, 4, 5, 6]);
    assert.match(rep.errors[0].errors[0], /Falta el teléfono/);
    assert.match(rep.errors[1].errors[0], /Teléfono no válido/);
    assert.match(rep.errors[2].errors[0], /Tipo no válido/);
    assert.match(rep.errors[3].errors[0], /Repetido con la línea 2/);
    assert.equal(await count(db), 1); // todo o nada: ni siquiera la fila buena

    const empty = await members.importGroup(db, 'Nombre,Teléfono\n', '58');
    assert.match(empty.errors[0].errors[0], /No encontré filas/);
    const many = 'Nombre,Teléfono\n' + Array.from({ length: 3001 }, (_, i) => `P${i},0414-${String(i).padStart(7, '0')}`).join('\n');
    assert.match((await members.importGroup(db, many, '58')).errors[0].errors[0], /más de 3000 filas/);
  });
});

test('importar: si algo falla a mitad de la carga, no queda nada a medias', async (t) => {
  await withDb(t, async (db) => {
    // un disparador que rechaza un teléfono concreto simula un fallo en la fila 3
    await db.query(`CREATE FUNCTION falla() RETURNS trigger AS $$ BEGIN IF NEW.phone = '584140000003' THEN RAISE EXCEPTION 'fallo simulado'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.query('CREATE TRIGGER falla_t BEFORE INSERT ON people FOR EACH ROW EXECUTE FUNCTION falla()');
    await assert.rejects(members.importGroup(db, CSV, '58'), /fallo simulado/);
    assert.equal(await count(db), 0);
  });
});

test('cambiar el tipo, lista, filtros, búsqueda y contadores', async (t) => {
  await withDb(t, async (db) => {
    await members.importGroup(db, CSV, '58');
    await db.query(`INSERT INTO people (full_name, phone) VALUES ('Fuera Del Grupo', '584140000099')`);
    const id = (p) => row(db, p).then((r) => r.id);
    assert.equal(await members.setMembership(db, await id('584140000001'), 'miembro'), null);
    assert.equal(await members.setMembership(db, await id('584140000002'), 'amigo'), null);
    assert.equal(await members.setMembership(db, await id('584140000003'), 'amigo'), null);
    assert.equal(await members.setMembership(db, await id('584140000003'), ''), null); // volver a "por clasificar"
    assert.equal(await members.setMembership(db, await id('584140000001'), 'visitante'), 'Tipo no válido.');
    assert.equal(await members.setMembership(db, await id('584140000001'), 'constructor'), 'Tipo no válido.');
    assert.equal(await members.setMembership(db, 999999, 'miembro'), 'No existe esa persona.');
    assert.equal(await members.setMembership(db, await id('584140000001'), undefined), null); // sin valor = por clasificar
    assert.equal(await members.setMembership(db, await id('584140000001'), 'miembro'), null);

    assert.deepEqual(await members.counts(db), { todos: 6, miembro: 1, amigo: 1, sin: 4, grupo: 5 });
    const names = async (f) => (await members.list(db, f)).map((r) => r.full_name);
    assert.equal((await names({ tipo: 'todos' })).length, 6);
    assert.deepEqual(await names({ tipo: 'miembro' }), ['Persona Uno']);
    assert.deepEqual(await names({ tipo: 'amigo' }), ['Perfil Dos']);
    assert.equal((await names({ tipo: 'sin' })).length, 4);
    assert.deepEqual(await names({ q: 'perfil' }), ['Perfil Cinco', 'Perfil Dos']);
    assert.deepEqual(await names({ q: '0414-000.00.01' }), ['Persona Uno']); // por teléfono, con formato
    assert.deepEqual(await names({ q: '0414-000.00.99' }), ['Fuera Del Grupo']);
    assert.deepEqual(await names({ q: '584140000099' }), ['Fuera Del Grupo']); // también con el código de país
    assert.deepEqual(await names({ q: '99' }), []); // dos dígitos no bastan para buscar por teléfono
    assert.deepEqual(await names({ tipo: 'miembro', q: 'perfil' }), []); // filtro y búsqueda juntos
    assert.deepEqual(await names({ q: '%' }), []); // el comodín se escapa
    const all = await members.list(db, {});
    assert.equal(all.find((r) => r.full_name === 'Fuera Del Grupo').in_official_group, false);
  });
});

test('un archivo del tamaño del grupo (434 filas, datos inventados) con tildes, emojis, comas, varios países, ";" y BOM', async (t) => {
  await withDb(t, async (db) => {
    const pad = (i) => String(i).padStart(7, '0');
    const lines = ['﻿Nombre;Teléfono;Admin;Origen del nombre'];
    for (let i = 1; i <= 434; i++) {
      const phone = [`0414-${pad(i)}`, `+58 424 ${pad(i)}`, `+57 312 ${pad(i)}`][i % 3];
      const nombre = i % 17 === 0 ? '(sin nombre)' : i % 11 === 0 ? `"Pérez, María ${i} 🙏"` : i % 5 === 0 ? `Ñandú Ángel ${i}` : `Persona ${i}`;
      lines.push(`${nombre};${phone};${i % 50 === 0 ? 'Sí' : 'No'};${i % 2 ? 'Perfil de WhatsApp' : 'Contacto guardado'}`);
    }
    const csv = lines.join('\r\n');
    const dry = await members.importGroup(db, csv, '58', { dryRun: true });
    assert.deepEqual([dry.created, dry.updated, dry.errors.length, dry.rows], [434, 0, 0, 434]);
    assert.equal(await count(db), 0);
    const rep = await members.importGroup(db, csv, '58');
    assert.deepEqual([rep.created, rep.updated, rep.errors.length], [434, 0, 0]);
    assert.equal(await count(db), 434);
    assert.equal(await count(db, 'opt_in'), 0);
    assert.equal(await count(db, 'in_official_group'), 434);
    assert.equal(await count(db, `role = 'Admin grupo WhatsApp'`), 8); // 50, 100, … 400
    assert.equal((await row(db, '573120000011')).full_name, 'Pérez, María 11 🙏'); // fila 11: tildes, coma y emoji intactos
    assert.equal((await row(db, '584140000015')).full_name, 'Ñandú Ángel 15'); // fila 15: Ñ y tildes
    assert.equal((await row(db, '584240000013')).whatsapp_name, 'Persona 13'); // origen = perfil de WhatsApp
    assert.equal((await row(db, '584140000012')).whatsapp_name, ''); // origen = contacto guardado
    assert.equal((await row(db, '573120000017')).full_name, '+573120000017'); // "(sin nombre)": teléfono internacional, con +
    const again = await members.importGroup(db, csv, '58');
    assert.deepEqual([again.created, again.updated], [0, 434]);
    assert.equal(await count(db), 434); // sin duplicados
  });
});
