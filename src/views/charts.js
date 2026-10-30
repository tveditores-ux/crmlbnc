'use strict';
const { esc } = require('../util');

/** Gráficas en SVG generadas en el servidor: sin librerías ni JavaScript en el navegador. */

const PALETTE = ['#2f5d62', '#b4642a', '#6b5b95', '#2f6b4f', '#8a3b2e', '#8a6116'];
const INK = '#6b665c';
const GRID = '#e3ddcf';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (v) => (Math.round(v * 10) / 10).toLocaleString('es-VE');

/** Tope "redondo" para el eje: 1, 2 o 5 por una potencia de diez. */
function niceMax(max) {
  if (!(max > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (max <= m * pow) return m * pow;
  return 10 * pow;
}

const trim = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function empty(msg = 'Aún no hay datos para graficar.') {
  return `<p class="muted" style="margin:6px 0">${esc(msg)}</p>`;
}

function legend(items) {
  return `<div class="legend">${items
    .map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`)
    .join('')}</div>`;
}

/** Barras verticales: items = [{ label, value }]. */
function barChart(items, { title = 'Gráfica de barras', color = PALETTE[0], height = 230 } = {}) {
  const data = (items || []).map((i) => ({ label: i.label, value: num(i.value) }));
  if (!data.length || data.every((d) => d.value === 0)) return empty();
  const W = 640;
  const m = { l: 44, r: 12, t: 22, b: 40 };
  const top = niceMax(Math.max(...data.map((d) => d.value)));
  const iw = W - m.l - m.r;
  const ih = height - m.t - m.b;
  const slot = iw / data.length;
  const bw = Math.min(46, slot * 0.64);
  const y = (v) => m.t + ih - (v / top) * ih;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = top * f;
      return `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${INK}">${fmt(v)}</text>`;
    })
    .join('');
  const bars = data
    .map((d, i) => {
      const x = m.l + slot * i + (slot - bw) / 2;
      const h = Math.max(0, m.t + ih - y(d.value));
      return `<g><title>${esc(d.label)}: ${fmt(d.value)}</title>
        <rect x="${x}" y="${y(d.value)}" width="${bw}" height="${h}" rx="3" fill="${color}"/>
        <text x="${x + bw / 2}" y="${y(d.value) - 5}" text-anchor="middle" font-size="11" fill="${INK}">${fmt(d.value)}</text>
        <text x="${x + bw / 2}" y="${height - m.b + 16}" text-anchor="middle" font-size="11" fill="${INK}">${esc(trim(d.label, 10))}</text></g>`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}">${grid}${bars}</svg>`;
}

/** Barras horizontales: items = [{ label, value }], para listas largas (ministerios). */
function hBarChart(items, { title = 'Gráfica de barras', color = PALETTE[0], suffix = '' } = {}) {
  const data = (items || []).map((i) => ({ label: i.label, value: num(i.value) }));
  if (!data.length || data.every((d) => d.value === 0)) return empty();
  const W = 640;
  const labelW = 170;
  const rowH = 26;
  const height = data.length * rowH + 8;
  const max = Math.max(...data.map((d) => d.value));
  const iw = W - labelW - 60;
  const rows = data
    .map((d, i) => {
      const yy = 4 + i * rowH;
      const w = max ? (d.value / max) * iw : 0;
      return `<g><title>${esc(d.label)}: ${fmt(d.value)}${suffix}</title>
        <text x="${labelW - 8}" y="${yy + 16}" text-anchor="end" font-size="12" fill="#1f2a2e">${esc(trim(d.label, 26))}</text>
        <rect x="${labelW}" y="${yy + 3}" width="${Math.max(w, d.value > 0 ? 2 : 0)}" height="${rowH - 9}" rx="3" fill="${color}"/>
        <text x="${labelW + w + 6}" y="${yy + 16}" font-size="12" fill="${INK}">${fmt(d.value)}${esc(suffix)}</text></g>`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}">${rows}</svg>`;
}

/** Líneas: labels = eje X; series = [{ name, values: [number|null] }]. */
function lineChart(labels, series, { title = 'Gráfica de líneas', height = 250 } = {}) {
  const ss = (series || []).filter((s) => (s.values || []).some((v) => v !== null && v !== undefined));
  if (!labels || !labels.length || !ss.length) return empty();
  const W = 640;
  const m = { l: 44, r: 14, t: 16, b: 44 };
  const all = ss.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined).map(num));
  const top = niceMax(Math.max(...all));
  const iw = W - m.l - m.r;
  const ih = height - m.t - m.b;
  const x = (i) => m.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1));
  const y = (v) => m.t + ih - (v / top) * ih;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = top * f;
      return `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${INK}">${fmt(v)}</text>`;
    })
    .join('');
  const step = Math.ceil(labels.length / 12);
  const xl = labels
    .map((l, i) => (i % step === 0 ? `<text x="${x(i)}" y="${height - m.b + 18}" text-anchor="middle" font-size="11" fill="${INK}">${esc(trim(l, 9))}</text>` : ''))
    .join('');
  const lines = ss
    .map((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${x(i)} ${y(num(v))} `;
        pen = true;
      });
      const dots = s.values
        .map((v, i) =>
          v === null || v === undefined
            ? ''
            : `<circle cx="${x(i)}" cy="${y(num(v))}" r="3.5" fill="${color}"><title>${esc(s.name)} · ${esc(labels[i])}: ${fmt(num(v))}</title></circle>`
        )
        .join('');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>${dots}`;
    })
    .join('');
  const leg = ss.length > 1 ? legend(ss.map((s, i) => ({ label: s.name, color: PALETTE[i % PALETTE.length] }))) : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}">${grid}${xl}${lines}</svg>${leg}`;
}

/** Una barra apilada horizontal: segments = [{ label, value, color }]. */
function stackedBar(segments, { title = 'Proporción', height = 26 } = {}) {
  const segs = (segments || []).map((s) => ({ ...s, value: num(s.value) }));
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) return empty('Sin participantes todavía.');
  const W = 640;
  let acc = 0;
  const rects = segs
    .filter((s) => s.value > 0)
    .map((s) => {
      const w = (s.value / total) * W;
      const r = `<g><title>${esc(s.label)}: ${s.value} (${Math.round((s.value / total) * 100)}%)</title><rect x="${acc}" y="0" width="${w}" height="${height}" fill="${s.color}"/>${
        w > 34 ? `<text x="${acc + w / 2}" y="${height / 2 + 4}" text-anchor="middle" font-size="12" fill="#fff" font-weight="600">${s.value}</text>` : ''
      }</g>`;
      acc += w;
      return r;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}" style="border-radius:6px">${rects}</svg>${legend(
    segs.map((s) => ({ label: `${s.label} (${s.value})`, color: s.color }))
  )}`;
}

/** Anillo con el porcentaje del primer segmento en el centro. */
function donut(segments, { title = 'Proporción', size = 170 } = {}) {
  const segs = (segments || []).map((s) => ({ ...s, value: num(s.value) }));
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) return empty();
  const r = size / 2 - 16;
  const c = 2 * Math.PI * r;
  let off = 0;
  const arcs = segs
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * c;
      const a = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="22" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(s.label)}: ${s.value}</title></circle>`;
      off += len;
      return a;
    })
    .join('');
  const pct = Math.round((segs[0].value / total) * 100);
  return `<div style="text-align:center"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(title)}">${arcs}<text x="${size / 2}" y="${size / 2 + 8}" text-anchor="middle" font-size="26" font-weight="700" fill="#1f2a2e">${pct}%</text></svg>${legend(
    segs.map((s) => ({ label: `${s.label} (${s.value})`, color: s.color }))
  )}</div>`;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2025-08' -> 'ago 25' */
function monthLabel(ym) {
  const [y, m] = String(ym).split('-');
  return `${MESES[(parseInt(m, 10) || 1) - 1]} ${String(y).slice(2)}`;
}

const CSS = `.chart{width:100%;height:auto;display:block}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:16px;margin-bottom:16px}
.charts .card{margin:0}.charts h3{margin:0 0 8px;font-size:15px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:12px;color:#6b665c}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.charts .wide{grid-column:1/-1}
@media print{header.top,.no-print,nav{display:none!important}body{background:#fff}.card{break-inside:avoid;box-shadow:none}.charts{grid-template-columns:1fr 1fr}}`;

module.exports = { monthLabel, barChart, hBarChart, lineChart, stackedBar, donut, niceMax, CSS, PALETTE };
