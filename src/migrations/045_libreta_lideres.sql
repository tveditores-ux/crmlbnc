-- 045: libreta de líderes — propuestas (hermana de la hoja de "Reunión de equipo", migración 018/019).
-- Hoja del panel: una fila por casilla (clave -> texto). Sin FK a people: no crea personas ni toca opt_in.

CREATE TABLE IF NOT EXISTS libreta_lideres (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Respuestas que los líderes envían desde la libreta del teléfono (/libreta-lideres/<token>).
-- Una fila por aparato (device_id): volver a enviar corrige la misma respuesta, no la duplica.
-- Sin FK a people: no crea personas ni toca opt_in.

CREATE TABLE IF NOT EXISTS libreta_lideres_respuestas (
  id          SERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  answers     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- clave de casilla -> texto
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
