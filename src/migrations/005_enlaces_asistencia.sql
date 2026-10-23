-- 005: enlaces secretos para registrar asistencia desde el teléfono

CREATE TABLE IF NOT EXISTS attendance_links (
  id           SERIAL PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,
  sede         TEXT,                       -- NULL = la persona elige la sede
  label        TEXT NOT NULL DEFAULT '',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE service_attendance ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'panel';
