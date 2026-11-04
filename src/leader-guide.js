'use strict';

/**
 * Guía del líder: respuestas aprobadas a las dudas operativas de los líderes.
 * Los líderes (en su enlace) y el asistente de WhatsApp solo ven las "confirmada" y activas.
 */
const CATEGORIES = ['Mi enlace y el sistema', 'REDIL ordinario', 'REDIL extraordinario', 'REDIL extendido', 'Grupos de cuidado', 'Ofrendas y cuidado pastoral', 'Espacios y equipos', 'Formación (Riel)', 'Ruta de crecimiento'];
const STATUSES = { confirmada: 'Confirmada', por_confirmar: 'Por confirmar' };
const MAX = { question: 200, answer: 1500, contact: 160, source: 160 };

const clean = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);

/** Entrada desde un formulario. Devuelve { value, errors }. */
function parseEntry(body, today) {
  const errors = [];
  const category = String(body.category ?? '').trim();
  if (!CATEGORIES.includes(category)) errors.push('Elige una categoría.');
  const question = clean(body.question, MAX.question).replace(/\s+/g, ' ');
  const answer = clean(body.answer, MAX.answer);
  if (!question) errors.push('Escribe la pregunta.');
  if (!answer) errors.push('Escribe la respuesta.');
  const review = String(body.review_by ?? '').trim();
  if (review && !/^\d{4}-\d{2}-\d{2}$/.test(review)) errors.push('La fecha de revisión no es válida.');
  else if (review && today && review < today) errors.push('La fecha de revisión ya pasó.');
  return {
    value: {
      category, question, answer,
      contact: clean(body.contact, MAX.contact).replace(/\s+/g, ' '),
      source: clean(body.source, MAX.source).replace(/\s+/g, ' '),
      status: body.status === 'confirmada' ? 'confirmada' : 'por_confirmar',
      review_by: review,
      active: body.active === '1',
    },
    errors,
  };
}

/** Lo que ven los líderes: solo lo confirmado y activo, ordenado por categoría. */
async function confirmed(db) {
  return (
    await db.query(
      `SELECT id, category, question, answer, contact FROM leader_guide
        WHERE active AND status = 'confirmada' ORDER BY sort, id`
    )
  ).rows;
}

/** Entradas agrupadas en el orden de CATEGORIES (las categorías desconocidas van al final). */
function groupByCategory(entries) {
  const by = new Map();
  for (const e of entries) {
    if (!by.has(e.category)) by.set(e.category, []);
    by.get(e.category).push(e);
  }
  const known = CATEGORIES.filter((c) => by.has(c));
  const other = [...by.keys()].filter((c) => !CATEGORIES.includes(c));
  return [...known, ...other].map((c) => ({ category: c, entries: by.get(c) }));
}

/** Texto para el asistente: solo lo confirmado, con su contacto, y acotado de tamaño. */
function contextText(entries, max = 6000) {
  const lines = entries.map((e) => `- ${e.question} ${e.answer}${e.contact ? ` (Escribir a: ${e.contact})` : ''}`);
  return lines.join('\n').slice(0, max);
}

module.exports = { CATEGORIES, STATUSES, MAX, parseEntry, confirmed, groupByCategory, contextText };
