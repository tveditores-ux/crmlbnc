'use strict';

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || 'hermano(a)';
}

module.exports = { esc, firstName };
