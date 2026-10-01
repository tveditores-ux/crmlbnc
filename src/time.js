'use strict';

function partsInZone(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}

function offsetMs(date, tz) {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** '2026-10-05T09:30' (hora local de la iglesia) -> Date UTC */
function localInputToDate(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off1 = offsetMs(new Date(guess), tz);
  let utc = guess - off1;
  const off2 = offsetMs(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

const pad = (n) => String(n).padStart(2, '0');

/** Date -> '2026-10-05T09:30' en la zona horaria dada (para <input type="datetime-local">) */
function dateToLocalInput(date, tz) {
  const p = partsInZone(new Date(date), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "domingo 5 de octubre, 9:30 a. m." */
function formatEventDate(date, tz) {
  const d = new Date(date);
  const day = d.toLocaleDateString('es-VE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString('es-VE', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

function formatShort(date, tz) {
  const d = new Date(date);
  return d.toLocaleString('es-VE', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function localHour(date, tz) {
  return partsInZone(new Date(date), tz).hour;
}

function dayNumber(date, tz) {
  const p = partsInZone(new Date(date), tz);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
}

/** "hoy", "mañana", "en 6 días", "en 1 mes"… según días de calendario locales */
function whenLabel(eventDate, now, tz) {
  const diff = dayNumber(eventDate, tz) - dayNumber(now, tz);
  if (diff <= 0) return 'hoy';
  if (diff === 1) return 'mañana';
  if (diff === 7) return 'en una semana';
  if (diff >= 28 && diff <= 31) return 'en un mes';
  return `en ${diff} días`;
}

module.exports = {
  localInputToDate,
  dateToLocalInput,
  formatEventDate,
  formatShort,
  localHour,
  whenLabel,
};
