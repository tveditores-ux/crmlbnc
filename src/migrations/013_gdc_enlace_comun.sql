-- 013: un solo enlace para todos los líderes (/registro/<token>). Cada envío queda como "respuesta":
--  - si el teléfono coincide con el del líder registrado, se aplica sola;
--  - si no, queda pendiente para que la revise quien administra el panel.
-- Una respuesta puede ser de un grupo que aún no existe (new_group_name), que se crea al aplicarla.

CREATE TABLE IF NOT EXISTS care_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS care_group_submissions (
  id                    SERIAL PRIMARY KEY,
  group_id              INTEGER REFERENCES care_groups(id) ON DELETE CASCADE,
  new_group_name        TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | aplicada | descartada
  auto_applied          BOOLEAN NOT NULL DEFAULT FALSE,
  leader_name           TEXT NOT NULL DEFAULT '',
  leader_phone          TEXT NOT NULL DEFAULT '',
  leader_email          TEXT NOT NULL DEFAULT '',
  advisor_name          TEXT NOT NULL DEFAULT '',
  belongs_to            TEXT NOT NULL DEFAULT '',
  congregation          TEXT NOT NULL DEFAULT '',
  address               TEXT NOT NULL DEFAULT '',
  place                 TEXT NOT NULL DEFAULT '',
  meeting_day           TEXT NOT NULL DEFAULT '',
  meeting_time          TEXT NOT NULL DEFAULT '',
  stage                 TEXT NOT NULL DEFAULT '',
  leader_birth_date     TEXT NOT NULL DEFAULT '',
  co_leader_name        TEXT NOT NULL DEFAULT '',
  co_leader_birth_date  TEXT NOT NULL DEFAULT '',
  photo                 BYTEA,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS care_group_submissions_status_idx ON care_group_submissions (status, created_at);
