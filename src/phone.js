'use strict';

/**
 * Normaliza un teléfono al formato que exige WhatsApp: solo dígitos, con código de país.
 *   "0414-123.45.67" -> "584141234567"
 *   "+58 414 1234567" -> "584141234567"
 * Devuelve null si no parece un número válido.
 */
function normalizePhone(raw, countryCode = '58') {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const hasPlus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (hasPlus) {
    // ya trae código de país
  } else if (d.startsWith('00')) {
    d = d.slice(2);
  } else if (d.startsWith('0')) {
    d = countryCode + d.slice(1);
  } else if (d.length <= 10 && !d.startsWith(countryCode)) {
    d = countryCode + d;
  }
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  if (!e) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function displayPhone(phone) {
  if (!phone) return '';
  if (phone.startsWith('58') && phone.length === 12) {
    return `0${phone.slice(2, 5)}-${phone.slice(5, 8)}.${phone.slice(8, 10)}.${phone.slice(10)}`;
  }
  return `+${phone}`;
}

module.exports = { normalizePhone, normalizeEmail, displayPhone };
