-- 010: el resto del libro de formatos de los grupos de cuidado:
--  Planificador mensual, Desarrollo de liderazgo (ruta de crecimiento) y F.O.D.A.
-- El Reporte trimestral no tiene tabla: se calcula con los reportes semanales (care_group_reports).
-- La gente del grupo es texto (sin FK a people), igual que el líder: unir o borrar personas no rompe nada.

CREATE TABLE IF NOT EXISTS care_group_people (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES care_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  milestones  TEXT[] NOT NULL DEFAULT '{}',   -- hitos logrados: NV, B, tPE, VL, 2D, DRT, dLC, LCa, CC
  other       TEXT NOT NULL DEFAULT '',       -- columna "Otros"
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_group_people_group_idx ON care_group_people (group_id, sort);

CREATE TABLE IF NOT EXISTS care_group_plans (
  id          SERIAL PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES care_groups(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,                  -- 'YYYY-MM'
  stage       TEXT NOT NULL DEFAULT '',
  weeks       JSONB NOT NULL DEFAULT '[]',    -- 4 objetos { snack, dynamics, key_element, support }
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, month)
);

CREATE TABLE IF NOT EXISTS care_group_foda (
  id             SERIAL PRIMARY KEY,
  group_id       INTEGER NOT NULL REFERENCES care_groups(id) ON DELETE CASCADE,
  quarter        TEXT NOT NULL,               -- 'YYYY-Qn'
  strengths      TEXT NOT NULL DEFAULT '',
  opportunities  TEXT NOT NULL DEFAULT '',
  weaknesses     TEXT NOT NULL DEFAULT '',
  threats        TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, quarter)
);
