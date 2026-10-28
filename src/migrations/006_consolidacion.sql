-- 006: consolidación de nuevos creyentes
-- Reutiliza la tabla people. Registrar a alguien aquí NO cambia su consentimiento (opt_in).

CREATE TABLE IF NOT EXISTS consolidation (
  id              SERIAL PRIMARY KEY,
  person_id       INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,

  -- 1. Decisión
  decision_date   DATE NOT NULL,
  sede            TEXT NOT NULL DEFAULT '',
  attendance_id   INTEGER REFERENCES service_attendance(id) ON DELETE SET NULL,
  invited_by      TEXT NOT NULL DEFAULT '',
  assigned_to     INTEGER REFERENCES people(id) ON DELETE SET NULL,   -- responsable de Nueva Vida

  -- Estado general
  status          TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'en_pausa', 'perdido')),
  lost_reason     TEXT CHECK (lost_reason IS NULL OR lost_reason IN ('no_contesta', 'se_mudo', 'otra_iglesia', 'otra_ciudad_pais', 'no_interesa')),
  status_since    DATE NOT NULL DEFAULT current_date,
  do_not_call     BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_date  DATE,                                               -- última vez vista en un servicio (opcional)

  -- 2. Llamada de Nueva Vida
  call_date       DATE,
  call_by         INTEGER REFERENCES people(id) ON DELETE SET NULL,
  -- 3. Reunión de Nueva Vida
  meeting_date    DATE,
  meeting_by      INTEGER REFERENCES people(id) ON DELETE SET NULL,
  -- 4. Primeros Pasos (inicio y fin)
  pp_start_date   DATE,
  pp_start_by     INTEGER REFERENCES people(id) ON DELETE SET NULL,
  pp_end_date     DATE,
  pp_end_by       INTEGER REFERENCES people(id) ON DELETE SET NULL,
  -- 5. Bautismo (opcional)
  baptism_date    DATE,
  baptism_by      INTEGER REFERENCES people(id) ON DELETE SET NULL,
  -- 6. Grupo de cuidado
  group_date      DATE,
  group_by        INTEGER REFERENCES people(id) ON DELETE SET NULL,
  group_name      TEXT NOT NULL DEFAULT '',
  -- 7. Riel de capacitación (VIDA y el resto)
  riel_date       DATE,
  riel_by         INTEGER REFERENCES people(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT consolidation_lost_needs_reason CHECK (status <> 'perdido' OR lost_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS consolidation_status_idx ON consolidation (status);
CREATE INDEX IF NOT EXISTS consolidation_decision_idx ON consolidation (decision_date DESC);
CREATE INDEX IF NOT EXISTS consolidation_assigned_idx ON consolidation (assigned_to);

-- Historial de cambios de estado: sin esto no se puede saber si alguien seguía activa a los 30, 90 o 180 días.
CREATE TABLE IF NOT EXISTS consolidation_status_log (
  id               SERIAL PRIMARY KEY,
  consolidation_id INTEGER NOT NULL REFERENCES consolidation(id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('activo', 'en_pausa', 'perdido')),
  reason           TEXT,
  changed_on       DATE NOT NULL DEFAULT current_date,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consolidation_status_log_idx ON consolidation_status_log (consolidation_id, changed_on);

-- Bitácora de llamadas. Las notas pueden ser pastorales: solo las ven el responsable, pastores y administradores.
CREATE TABLE IF NOT EXISTS consolidation_calls (
  id               SERIAL PRIMARY KEY,
  consolidation_id INTEGER NOT NULL REFERENCES consolidation(id) ON DELETE CASCADE,
  called_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_by        INTEGER REFERENCES people(id) ON DELETE SET NULL,
  result           TEXT NOT NULL CHECK (result IN ('contesto', 'no_contesto', 'numero_equivocado', 'no_llamar')),
  note             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS consolidation_calls_idx ON consolidation_calls (consolidation_id, called_at DESC);
