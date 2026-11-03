-- 018: hoja de la pestaña "Reunión de equipo".
-- Una fila por casilla (clave -> texto). Sin FK a people: no crea personas ni toca opt_in.

CREATE TABLE IF NOT EXISTS reunion_equipo (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
