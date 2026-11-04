'use strict';

/**
 * Tipos de evento. REDIL = reunión de empoderamiento, dirección e instrucción para el liderazgo.
 * Un evento sin tipo ('') es un evento general. El tipo solo clasifica: no cambia a quién se convoca ni los recordatorios.
 */
const EVENT_TYPES = ['REDIL ordinario', 'REDIL extraordinario', 'REDIL extendido'];

/** Devuelve el tipo si es uno de la lista; cualquier otra cosa es "sin tipo". */
const parseEventType = (v) => (EVENT_TYPES.includes(String(v ?? '').trim()) ? String(v).trim() : '');

module.exports = { EVENT_TYPES, parseEventType };
