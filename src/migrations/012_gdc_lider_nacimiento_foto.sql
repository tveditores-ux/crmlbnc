-- 012: fecha de nacimiento del líder (y de su pareja o co-líder) y foto del líder, enviadas desde el formulario del teléfono.
-- Las fechas van como texto 'YYYY-MM-DD' (vacío = no la dio) para evitar problemas de zona horaria.
-- La foto va en su propia tabla para que las consultas de grupos (SELECT *) nunca arrastren los bytes.

ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS leader_birth_date    TEXT NOT NULL DEFAULT '';
ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS co_leader_name        TEXT NOT NULL DEFAULT '';
ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS co_leader_birth_date  TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS care_group_photos (
  group_id    INTEGER PRIMARY KEY REFERENCES care_groups(id) ON DELETE CASCADE,
  data        BYTEA NOT NULL,                 -- JPEG ya reducido por el teléfono
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
