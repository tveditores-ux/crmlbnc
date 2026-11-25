-- 049: registro de presentación de niños (pestaña Presentación de Niños, grupo Seguimiento).
-- Lista independiente, como bautizados y nueva_vida: sin FK a people, para que unir o borrar
-- personas nunca la rompa. No crea personas ni toca opt_in.

CREATE TABLE IF NOT EXISTS presentaciones_ninos (
  id                SERIAL PRIMARY KEY,
  child_name        TEXT NOT NULL,
  birth_date        DATE,
  presentation_date DATE,
  sede              TEXT NOT NULL DEFAULT '',
  parents           TEXT NOT NULL DEFAULT '',   -- padres o representantes
  presented_by      TEXT NOT NULL DEFAULT '',   -- quién lo presentó
  note              TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT 'Registro manual',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS presentaciones_ninos_date_idx ON presentaciones_ninos (presentation_date DESC);
