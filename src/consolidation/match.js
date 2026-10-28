'use strict';
const { normalizePhone } = require('../phone');

/**
 * Unir la lista de Nueva Vida con las personas que ya existen.
 *  - Mismo teléfono (normalizado): es la misma persona.
 *  - Nombre parecido: SOLO es una sugerencia; siempre se pide confirmación manual.
 *  - Si no hay nada parecido: es una persona nueva.
 * Nunca se une por nombre sin confirmación, y nunca se crea a alguien cuyo teléfono ya existe.
 */

const STOP = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'pastor', 'pastora', 'pra', 'sr', 'sra', 'hno', 'hna', 'hermano', 'hermana']);

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const ratio = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/** Parecido entre dos nombres, de 0 a 1. Los nombres de una sola palabra solo coinciden si son idénticos. */
function nameScore(a, b) {
  const ta = normName(a).split(' ').filter(Boolean);
  const tb = normName(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  if (ta.length < 2 || tb.length < 2) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // Todas las palabras del nombre corto aparecen (con pequeños errores de escritura) en el largo.
  const hits = short.filter((t) => long.some((u) => ratio(t, u) >= 0.8));
  if (hits.length === short.length) return 0.9;
  // Mismo primer nombre y el último apellido de uno aparece (casi igual) en el otro.
  // Compartir solo el segundo nombre no basta.
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  if (ratio(ta[0], tb[0]) >= 0.8 && (tb.slice(1).some((y) => ratio(lastA, y) >= 0.8) || ta.slice(1).some((x) => ratio(lastB, x) >= 0.8))) return 0.8;
  return 0;
}

const THRESHOLD = 0.8;

/**
 * Clasifica una fila contra la lista de personas.
 * people: [{ id, full_name, phone }]. Devuelve { group, person?, candidates? }
 *   group: 'existe' (mismo teléfono) | 'posible' (nombre parecido) | 'nueva'
 */
function classify(row, people, countryCode = '58') {
  const phone = normalizePhone(row.phone, countryCode);
  if (phone) {
    const same = people.find((p) => p.phone && p.phone === phone);
    if (same) return { group: 'existe', person: same, phone };
  }
  const candidates = people
    .map((p) => ({ person: p, score: nameScore(row.name, p.full_name) }))
    .filter((c) => c.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (candidates.length) return { group: 'posible', candidates, phone };
  return { group: 'nueva', phone };
}

module.exports = { normName, nameScore, classify, levenshtein, THRESHOLD };
