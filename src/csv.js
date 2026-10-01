'use strict';

/** Detecta el separador mirando la primera línea (Excel en español suele usar ';'). */
function detectDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const candidates = [',', ';', '\t'].map((c) => [c, count(c)]).sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ',';
}

/** Parser CSV mínimo con soporte de comillas, comillas dobles escapadas y saltos de línea dentro de campos. */
function parseCsv(text, delimiter) {
  text = String(text || '').replace(/^﻿/, '');
  const delim = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

const HEADER_ALIASES = {
  nombre: 'nombre',
  nombre_completo: 'nombre',
  nombre_y_apellido: 'nombre',
  telefono: 'telefono',
  whatsapp: 'telefono',
  celular: 'telefono',
  correo: 'correo',
  email: 'correo',
  correo_electronico: 'correo',
  ministerios: 'ministerios',
  ministerio: 'ministerios',
  rol: 'rol',
  cargo: 'rol',
  acepta_mensajes: 'acepta_mensajes',
  acepta: 'acepta_mensajes',
  consentimiento: 'acepta_mensajes',
  canal: 'canal',
  canal_preferido: 'canal',
};

/** Convierte el CSV en objetos con claves estándar. Devuelve { records, unknownHeaders }. */
function csvToRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { records: [], unknownHeaders: [] };
  const headers = rows[0].map(normalizeHeader);
  const keys = headers.map((h) => HEADER_ALIASES[h] || null);
  const unknownHeaders = rows[0].filter((_, i) => !keys[i] && headers[i]);
  const records = rows.slice(1).map((r, idx) => {
    const rec = { _line: idx + 2 };
    keys.forEach((k, i) => {
      if (k) rec[k] = (r[i] || '').trim();
    });
    return rec;
  });
  return { records, unknownHeaders };
}

function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseCsv, csvToRecords, detectDelimiter, toCsv, normalizeHeader };
