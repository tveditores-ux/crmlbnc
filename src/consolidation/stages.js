'use strict';

/** Las etapas del proceso, en orden. Cada una guarda fecha y responsable. */
const STAGES = [
  { key: 'decision', label: 'Decisión', date: 'decision_date', by: null },
  { key: 'llamada', label: 'Llamada de Nueva Vida', date: 'call_date', by: 'call_by' },
  { key: 'reunion', label: 'Reunión de Nueva Vida', date: 'meeting_date', by: 'meeting_by' },
  { key: 'pp_inicio', label: 'Primeros Pasos: inicio', date: 'pp_start_date', by: 'pp_start_by' },
  { key: 'pp_fin', label: 'Primeros Pasos: terminó', date: 'pp_end_date', by: 'pp_end_by' },
  { key: 'bautismo', label: 'Bautismo', date: 'baptism_date', by: 'baptism_by', optional: true },
  { key: 'grupo', label: 'Grupo de cuidado', date: 'group_date', by: 'group_by' },
  { key: 'riel', label: 'Riel de capacitación', date: 'riel_date', by: 'riel_by' },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

const STATUSES = { activo: 'Activa', en_pausa: 'En pausa', perdido: 'Perdida' };
const LOST_REASONS = {
  no_contesta: 'No contesta',
  se_mudo: 'Se mudó',
  otra_iglesia: 'Otra iglesia',
  otra_ciudad_pais: 'Otra ciudad o país',
  no_interesa: 'No le interesa',
};
const CALL_RESULTS = {
  contesto: 'Contestó',
  no_contesto: 'No contestó',
  numero_equivocado: 'Número equivocado',
  no_llamar: 'Pidió no ser llamada',
};

/** Acepta 2026-10-05 o 5/10/2026 (también 05-10-2026). Devuelve 'AAAA-MM-DD' o null. */
function parseDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let y;
  let m;
  let d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)/.exec(s))) {
    [, d, m, y] = r;
    if (y.length === 2) y = `20${y}`;
  } else return null;
  y = +y;
  m = +m;
  d = +d;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Etapa actual: la última de la lista que ya tiene fecha. */
function currentStage(row) {
  let cur = STAGES[0];
  for (const s of STAGES) if (row[s.date]) cur = s;
  return cur;
}

module.exports = { STAGES, STAGE_BY_KEY, STATUSES, LOST_REASONS, CALL_RESULTS, parseDate, currentStage };
