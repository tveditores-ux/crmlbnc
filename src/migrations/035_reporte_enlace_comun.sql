-- 035: remoto de reporte APARTE y con un solo enlace para todos los líderes (/reportes/<token>).
-- El enlace vive en care_settings ('reporte_token' / 'reporte_active'), como el de la libretica y el de /registro.
-- El líder solo escribe su nombre: si coincide con el leader_name de UN solo grupo activo, el reporte entra
-- directo a ese grupo (care_group_reports, source='enlace_comun'); si no se reconoce o hay dos grupos con el
-- mismo líder, el reporte queda aquí, pendiente, para que el panel lo asigne a su grupo (no se pierde nada).

CREATE TABLE IF NOT EXISTS care_group_report_submissions (
  id            SERIAL PRIMARY KEY,
  leader_name   TEXT NOT NULL DEFAULT '',               -- el nombre tal como lo escribió el líder
  status        TEXT NOT NULL DEFAULT 'pendiente',      -- pendiente | aplicada | descartada
  group_id      INTEGER REFERENCES care_groups(id) ON DELETE SET NULL,
  meeting_date  DATE NOT NULL,
  members_count INTEGER CHECK (members_count IS NULL OR members_count >= 0),
  guests_count  INTEGER CHECK (guests_count IS NULL OR guests_count >= 0),
  attendance    INTEGER CHECK (attendance IS NULL OR attendance >= 0),
  offering      NUMERIC(12,2),
  offering_fx   NUMERIC(12,2),
  payment_ref   TEXT NOT NULL DEFAULT '',
  snack         TEXT NOT NULL DEFAULT '',
  dynamics      TEXT NOT NULL DEFAULT '',
  testimonies   TEXT NOT NULL DEFAULT '',
  songs         TEXT NOT NULL DEFAULT '',
  key_element   TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  followup      TEXT NOT NULL DEFAULT '',
  advisor_visit BOOLEAN NOT NULL DEFAULT FALSE,
  start_time    TEXT NOT NULL DEFAULT '',
  end_time      TEXT NOT NULL DEFAULT '',
  stage         TEXT NOT NULL DEFAULT '',
  stage_week    INTEGER CHECK (stage_week IS NULL OR stage_week BETWEEN 1 AND 52),
  recent_guests INTEGER,
  leader_wed    BOOLEAN,
  leader_sun    BOOLEAN,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS care_group_report_submissions_status_idx ON care_group_report_submissions (status, created_at);
