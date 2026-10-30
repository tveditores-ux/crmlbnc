-- 017: fotos generales de un bautizo (el grupo, el momento), por fecha del bautismo. Puede haber varias por fecha.
-- No están ligadas a una persona. Solo se sirven con sesión del panel.

CREATE TABLE IF NOT EXISTS bautizos_fotos_generales (
  id            SERIAL PRIMARY KEY,
  baptism_date  DATE NOT NULL,
  sede          TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  data          BYTEA NOT NULL,                 -- JPEG ya reducido en el navegador (sin datos de ubicación)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bautizos_fotos_generales_fecha_idx ON bautizos_fotos_generales (baptism_date DESC);
