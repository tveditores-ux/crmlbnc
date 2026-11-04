-- 026: tipo de evento. Hoy hay tres tipos de REDIL: ordinario, extraordinario y extendido
-- (vacío = evento general, que no es un REDIL). Solo clasifica el evento: no cambia a quién se convoca ni los recordatorios.

ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT '';
