-- 022: datos que las personas envían ellas mismas por el enlace "Mis datos" (/mis-datos/<token>).
-- Ojo con lo sensible: cédula, dirección y fecha de nacimiento solo se ven en la ficha del panel (con sesión);
-- nunca van en la lista, ni en las descargas, ni en mensajes. Las fechas van como texto 'YYYY-MM-DD'.

ALTER TABLE people ADD COLUMN IF NOT EXISTS birth_date          TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS cedula              TEXT NOT NULL DEFAULT '';   -- normalizada: V-12345678 / E-12345678
ALTER TABLE people ADD COLUMN IF NOT EXISTS address             TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS civil_status        TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS congregation        TEXT NOT NULL DEFAULT '';   -- Niños, Adolescentes, Jóvenes, ...
ALTER TABLE people ADD COLUMN IF NOT EXISTS care_group_name     TEXT NOT NULL DEFAULT '';   -- grupo de cuidado que dijo, en texto
ALTER TABLE people ADD COLUMN IF NOT EXISTS profile_updated_at  TIMESTAMPTZ;                -- cuándo envió sus datos (NULL = aún no)

-- La foto va en su propia tabla para que las consultas de personas (SELECT *) nunca arrastren los bytes.
CREATE TABLE IF NOT EXISTS people_photos (
  person_id   INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  data        BYTEA NOT NULL,                 -- JPEG ya reducido por el teléfono
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada envío es una respuesta: si el teléfono ya está en Personas y no hay datos distintos, se completa sola;
-- si es alguien nuevo o hay datos en conflicto, espera a que la revise quien administra el panel.
CREATE TABLE IF NOT EXISTS member_submissions (
  id               SERIAL PRIMARY KEY,
  person_id        INTEGER REFERENCES people(id) ON DELETE CASCADE,   -- NULL = persona nueva
  status           TEXT NOT NULL DEFAULT 'pendiente',                 -- pendiente | aplicada | descartada
  auto_applied     BOOLEAN NOT NULL DEFAULT FALSE,
  full_name        TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  birth_date       TEXT NOT NULL DEFAULT '',
  cedula           TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  civil_status     TEXT NOT NULL DEFAULT '',
  congregation     TEXT NOT NULL DEFAULT '',
  care_group_name  TEXT NOT NULL DEFAULT '',
  wants_messages   BOOLEAN NOT NULL DEFAULT FALSE,   -- marcó que quiere recibir recordatorios: NO cambia opt_in por sí solo
  photo            BYTEA,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS member_submissions_status_idx ON member_submissions (status, created_at);
