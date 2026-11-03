-- 019: respuestas que el equipo envía desde la libreta del teléfono (/reunion/<token>).
-- Una fila por aparato (device_id): volver a enviar corrige la misma respuesta, no la duplica.
-- Sin FK a people: no crea personas ni toca opt_in.

CREATE TABLE IF NOT EXISTS reunion_respuestas (
  id          SERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  answers     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- clave de casilla -> texto
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
