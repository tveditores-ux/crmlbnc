-- 004: asistencia a los servicios de celebración

CREATE TABLE IF NOT EXISTS service_attendance (
  id            SERIAL PRIMARY KEY,
  service_date  DATE NOT NULL,
  sede          TEXT NOT NULL,
  day_name      TEXT NOT NULL DEFAULT '',
  horario       TEXT NOT NULL DEFAULT '',
  att_start     INTEGER,
  att_mid       INTEGER,
  att_end       INTEGER,
  guests        INTEGER NOT NULL DEFAULT 0,
  conversions   INTEGER NOT NULL DEFAULT 0,
  servers       INTEGER NOT NULL DEFAULT 0,
  pastors       INTEGER NOT NULL DEFAULT 0,
  kids          INTEGER NOT NULL DEFAULT 0,
  preteens      INTEGER NOT NULL DEFAULT 0,
  teens         INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_attendance_uq ON service_attendance (service_date, lower(sede), horario);
CREATE INDEX IF NOT EXISTS service_attendance_date_idx ON service_attendance (service_date DESC);
