-- 009: Grupos de cuidado (GdC) y los reportes semanales que envían sus líderes desde el teléfono.
-- El líder no se enlaza con la tabla people a propósito: así unir duplicados o borrar una ficha nunca rompe un grupo.

CREATE TABLE IF NOT EXISTS care_groups (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  leader_name   TEXT NOT NULL DEFAULT '',
  leader_phone  TEXT NOT NULL DEFAULT '',
  leader_email  TEXT NOT NULL DEFAULT '',
  advisor_name  TEXT NOT NULL DEFAULT '',   -- Líder asesor
  belongs_to    TEXT NOT NULL DEFAULT '',   -- "Pertenece a"
  congregation  TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  place         TEXT NOT NULL DEFAULT '',   -- lugar de reunión
  meeting_day   TEXT NOT NULL DEFAULT '',
  meeting_time  TEXT NOT NULL DEFAULT '',
  stage         TEXT NOT NULL DEFAULT '',   -- Equipo / Conquista / Consolidación / Multiplicación
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  token         TEXT NOT NULL UNIQUE,       -- enlace secreto del líder (/g/<token>)
  link_active   BOOLEAN NOT NULL DEFAULT TRUE,
  uses          INTEGER NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS care_group_reports (
  id             SERIAL PRIMARY KEY,
  group_id       INTEGER NOT NULL REFERENCES care_groups(id) ON DELETE CASCADE,
  meeting_date   DATE NOT NULL,
  members_count  INTEGER,
  guests_count   INTEGER,
  attendance     INTEGER,
  offering       NUMERIC(12,2),
  snack          TEXT NOT NULL DEFAULT '',   -- refrigerio
  dynamics       TEXT NOT NULL DEFAULT '',
  testimonies    TEXT NOT NULL DEFAULT '',
  songs          TEXT NOT NULL DEFAULT '',
  key_element    TEXT NOT NULL DEFAULT '',   -- elemento clave
  notes          TEXT NOT NULL DEFAULT '',
  followup       TEXT NOT NULL DEFAULT '',   -- seguimiento
  advisor_visit  BOOLEAN NOT NULL DEFAULT FALSE,
  source         TEXT NOT NULL DEFAULT 'telefono',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, meeting_date)
);

CREATE INDEX IF NOT EXISTS care_group_reports_date_idx ON care_group_reports (meeting_date);
