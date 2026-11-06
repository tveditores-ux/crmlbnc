'use strict';
const { esc } = require('../util');
const cal = require('../calendar');

/** Colores por tipo: con el icono delante nunca depende solo del color. */
const KIND_CSS = { actividad: 'k-act', redil: 'k-redil', lider: 'k-lider', cumple: 'k-cumple' };

const CSS = `<style>
.k-act{background:#e3edf0;color:#244a50}.k-redil{background:#e6e1f2;color:#4a3a80}.k-lider{background:#f8eed8;color:#7a5410}.k-cumple{background:#f6e2e2;color:#8a2f2f}
.cal-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.cal-tools a{padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--surface);text-decoration:none;color:inherit;font-size:14px}
.cal-tools a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;min-width:640px}
.cal-wrap{overflow-x:auto;margin-bottom:16px}
.cal-h{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:4px}
.cal-d{background:var(--surface);border:1px solid var(--line);border-radius:8px;min-height:92px;padding:4px;font-size:12px;overflow:hidden}
.cal-d.off{background:transparent;border-style:dashed;opacity:.5}
.cal-d.today{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.cal-n{font-weight:700;font-size:13px}
.cal-i{display:block;border-radius:4px;padding:1px 5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none}
.cal-more{color:var(--muted);font-size:11px;margin-top:2px}
.agenda .day{font-weight:700;margin:14px 0 4px}
.agenda .day.today{color:var(--accent)}
.agenda .it{display:flex;gap:10px;align-items:baseline;padding:6px 10px;border-radius:8px;margin-bottom:4px;text-decoration:none;color:inherit}
.agenda .it .t{min-width:44px;font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px}
</style>`;

const itemText = (it) => `${cal.KINDS[it.kind].icon} ${it.title}${it.time ? ` · ${it.time}` : ''}`;
const tag = (it, cls, extra = '') => {
  const t = `${esc(itemText(it))}`;
  return it.href ? `<a class="${cls} ${KIND_CSS[it.kind]}" ${extra} href="${esc(it.href)}">${t}</a>` : `<span class="${cls} ${KIND_CSS[it.kind]}" ${extra}>${t}</span>`;
};

const agendaRow = (it) => {
  const inner = `<span class="t">${esc(it.time || '')}</span><span>${esc(cal.KINDS[it.kind].icon)} ${esc(it.title)}${it.sub ? `<br><span class="muted" style="font-size:12px">${esc(it.sub)}</span>` : ''}</span>`;
  return it.href ? `<a class="it ${KIND_CSS[it.kind]}" href="${esc(it.href)}">${inner}</a>` : `<div class="it ${KIND_CSS[it.kind]}">${inner}</div>`;
};

/** Cuadrícula del mes (lunes a domingo) + agenda del mes debajo, que es lo que se lee bien en el teléfono. */
function monthView({ month, items, today, filter }) {
  const { from, to } = cal.monthRange(month);
  const lead = cal.weekday(from);
  const byDay = new Map();
  for (const it of items) (byDay.get(it.date) || byDay.set(it.date, []).get(it.date)).push(it);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-d off"></div>');
  for (let d = from; d <= to; d = cal.addDays(d, 1)) {
    const list = byDay.get(d) || [];
    cells.push(`<div class="cal-d${d === today ? ' today' : ''}"><div class="cal-n">${+d.slice(8)}</div>${list.slice(0, 3).map((it) => tag(it, 'cal-i', `title="${esc(itemText(it))}"`)).join('')}${list.length > 3 ? `<div class="cal-more">+${list.length - 3} más</div>` : ''}</div>`);
  }
  const days = [...byDay.keys()].sort();
  const agenda = days.length
    ? days
        .map((d) => `<div class="day${d === today ? ' today' : ''}">${esc(cal.dayLabel(d))}${d === today ? ' · hoy' : ''}</div>${byDay.get(d).map(agendaRow).join('')}`)
        .join('')
    : '<p class="muted">No hay nada en este mes con ese filtro.</p>';
  const pill = (key, label) => `<a href="/calendario?mes=${month}&ver=${key}" class="${filter === key ? 'on' : ''}">${label}</a>`;
  const name = `${cal.MONTHS[+month.slice(5) - 1]} ${month.slice(0, 4)}`;
  return `${CSS}<h1>Calendario</h1><p class="sub">Actividades, REDIL y cumpleaños de las personas y de los líderes. Se arma solo con lo que ya está en el sistema.</p>
    <div class="cal-tools"><a href="/calendario?mes=${cal.shiftMonth(month, -1)}&ver=${filter}">← Anterior</a><strong style="min-width:140px;text-align:center;text-transform:capitalize">${esc(name)}</strong><a href="/calendario?mes=${cal.shiftMonth(month, 1)}&ver=${filter}">Siguiente →</a><a href="/calendario?ver=${filter}">Hoy</a></div>
    <div class="cal-tools">${pill('todo', 'Todo')}${pill('actividades', '📅 Actividades y REDIL')}${pill('cumpleanos', '🎂 Cumpleaños')}${pill('lideres', '⭐ Líderes')}</div>
    <div class="cal-wrap"><div class="cal-grid">${cal.DAYS.map((d) => `<div class="cal-h">${esc(d.slice(0, 3))}</div>`).join('')}${cells.join('')}</div></div>
    <div class="card agenda"><h3 style="margin:0">Agenda de ${esc(name)}</h3>${agenda}</div>
    <p class="muted" style="font-size:13px">Las actividades salen de <a href="/eventos">Eventos</a>. Los cumpleaños, de la fecha de nacimiento en la ficha de cada persona y de los datos de los líderes (solo se muestra día y mes).</p>`;
}

const TICKER_CSS = `<style>
.ticker{background:var(--accent);color:#fff;border-radius:10px;overflow:hidden;margin:0 0 16px;display:flex;align-items:stretch}
.ticker .tl{flex:none;background:rgba(0,0,0,.22);padding:8px 12px;font-weight:700;font-size:13px;white-space:nowrap;text-decoration:none;color:#fff;display:flex;align-items:center}
.ticker .tv{overflow:hidden;flex:1;position:relative}
.ticker .tt{display:inline-flex;white-space:nowrap;padding:8px 0;animation:tick var(--dur,40s) linear infinite}
.ticker:hover .tt,.ticker:focus-within .tt{animation-play-state:paused}
.ticker .tt span{padding:0 28px;font-size:14px}
.ticker .tt a{color:#fff;text-decoration:none}.ticker .tt a:hover{text-decoration:underline}
@keyframes tick{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.ticker .tt{animation:none}.ticker .tv{overflow-x:auto}}
</style>`;

/** Cintillo de la pantalla de inicio: lo que queda de esta semana, de derecha a izquierda. */
function ticker({ items, today, weekFrom, weekTo }) {
  const left = items.filter((i) => i.date >= today);
  const when = (d) => (d === today ? 'Hoy' : d === cal.addDays(today, 1) ? 'Mañana' : cal.dayLabel(d).replace(/ de .*/, '').replace(/^./, (c) => c.toUpperCase()));
  const parts = left.map((it) => {
    const txt = `<strong>${esc(when(it.date))}</strong> ${esc(cal.KINDS[it.kind].icon)} ${esc(it.title)}${it.time ? ` · ${esc(it.time)}` : ''}`;
    return `<span>${it.href && it.kind !== 'cumple' && it.kind !== 'lider' ? `<a href="${esc(it.href)}">${txt}</a>` : txt}</span>`;
  });
  const track = parts.length ? parts.join('') : '<span>No hay actividades ni cumpleaños el resto de esta semana.</span>';
  // el contenido va dos veces para que el desplazamiento no tenga salto; la velocidad depende de cuánto texto hay
  const dur = Math.max(25, Math.round(parts.join('').replace(/<[^>]+>/g, '').length / 6));
  return `${TICKER_CSS}<div class="ticker no-print" role="region" aria-label="Calendario de esta semana"><a class="tl" href="/calendario" title="Ver el calendario">📅 Esta semana</a>
    <div class="tv"><div class="tt" style="--dur:${dur}s"><div style="display:inline-flex">${track}</div><div style="display:inline-flex" aria-hidden="true">${track}</div></div></div></div>`;
}

module.exports = { monthView, ticker };
