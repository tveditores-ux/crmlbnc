'use strict';
const { esc } = require('./util');

/**
 * La regla que pidió el pastor (2026-11-21): un número de teléfono es de UNA persona. Cuando alguien se
 * registra por un remoto y el número ya está registrado, hay dos casos:
 * - Es la MISMA persona (coinciden el nombre y la cédula no contradice): no es un registro nuevo, es una
 *   ACTUALIZACIÓN — el remoto le pregunta «¿quieres actualizar tus datos?» antes de guardar nada.
 * - Es OTRA persona: no se acepta el registro con ese número.
 * La coincidencia se juzga contra lo que ya existe con ese teléfono: la ficha de Personas, las respuestas
 * pendientes del mismo registro y, en el registro de líderes de GdC, los grupos que ya llevan ese líder.
 */
const keyOf = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const MENSAJE_OTRO = 'Este número de teléfono ya está registrado con otros datos. Si es tu número, pide ayuda a la iglesia para revisar tu registro.';

/** ¿Lo enviado es de la misma persona que ya tiene el número? Nombre igual y cédula sin contradicción. */
function esLaMisma(registro, { nombre, cedula }) {
  if (!registro || keyOf(registro.nombre) !== keyOf(nombre)) return false;
  const a = String(registro.cedula || '').trim().toUpperCase();
  const b = String(cedula || '').trim().toUpperCase();
  return !(a && b && a !== b);
}

/** registros: [{ nombre, cedula }] ya conocidos con ese teléfono. Devuelve 'libre' | 'misma' | 'otro'. */
function verdict(registros, identidad) {
  if (!registros.length) return { state: 'libre' };
  return registros.some((r) => esLaMisma(r, identidad)) ? { state: 'misma' } : { state: 'otro' };
}

/** La ficha de Personas con ese teléfono, como registro comparable (o null). */
async function desdePersonas(db, phone) {
  if (!phone) return [];
  const { rows } = await db.query('SELECT full_name, cedula FROM people WHERE phone = $1', [phone]);
  return rows.map((r) => ({ nombre: r.full_name, cedula: r.cedula }));
}

/** Las respuestas PENDIENTES de un registro (tabla con full_name/phone/cedula) con ese teléfono. */
async function desdePendientes(db, tabla, phone) {
  if (!phone) return [];
  const { rows } = await db.query(`SELECT full_name, cedula FROM ${tabla} WHERE phone = $1 AND status = 'pendiente'`, [phone]);
  return rows.map((r) => ({ nombre: r.full_name, cedula: r.cedula }));
}

/** Los grupos cuyo líder usa ese teléfono (registro de líderes de GdC). */
async function desdeGrupos(db, phone) {
  if (!phone) return [];
  const { rows } = await db.query('SELECT leader_name, leader_cedula FROM care_groups WHERE leader_phone = $1', [phone]);
  return rows.map((r) => ({ nombre: r.leader_name, cedula: r.leader_cedula }));
}

/** Las respuestas pendientes del registro de líderes de GdC con ese teléfono de líder. */
async function desdePendientesGdC(db, phone) {
  if (!phone) return [];
  const { rows } = await db.query("SELECT leader_name, leader_cedula FROM care_group_submissions WHERE leader_phone = $1 AND status = 'pendiente'", [phone]);
  return rows.map((r) => ({ nombre: r.leader_name, cedula: r.leader_cedula }));
}

/** Los campos del formulario como ocultos, para reenviar lo mismo al confirmar la actualización. */
function hiddenFields(body) {
  return Object.entries(body || {})
    .filter(([k]) => k !== 'es_actualizacion' && k !== 'web')
    .map(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `<input type="hidden" name="${esc(k)}" value="${esc(String(x ?? ''))}">`).join(''))
    .join('');
}

/**
 * La pregunta de actualización: se muestra cuando el número ya es de la misma persona y todavía no
 * confirmó. El formulario reenvía todo tal cual, con es_actualizacion=1; si cierra la página, no se
 * guardó nada.
 */
function confirmHtml(body, nombre) {
  return `<h1>Ya estás registrado</h1>
  <div class="card"><p>Este número ya tiene un registro a tu nombre, <strong>${esc(nombre)}</strong>. Si lo que quieres es <strong>actualizar tus datos</strong> con la información que acabas de enviar, confírmalo aquí:</p>
  <form method="post">${hiddenFields(body)}<input type="hidden" name="es_actualizacion" value="1"><button class="go">Sí, actualizar mis datos</button></form>
  <p class="muted" style="margin-top:10px">Si no quieres cambiar nada, cierra esta página: no se guardó ningún cambio.</p></div>`;
}

module.exports = { MENSAJE_OTRO, esLaMisma, verdict, desdePersonas, desdePendientes, desdeGrupos, desdePendientesGdC, confirmHtml, hiddenFields };
