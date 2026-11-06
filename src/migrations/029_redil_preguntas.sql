-- 029: preguntas y comentarios que los líderes escriben en la libretica digital del REDIL.
-- Cada una queda con el nombre de quien la escribió (y su grupo y teléfono, tal como estaban ese día), el punto de la
-- libretica al que se refiere (NULL = pregunta general) y, cuando alguien del equipo contesta, la respuesta.
-- Sin claves foráneas a propósito: la pregunta se conserva aunque después se borre el grupo o la persona.

CREATE TABLE IF NOT EXISTS redil_questions (
  id          SERIAL PRIMARY KEY,
  libreta     TEXT    NOT NULL,                 -- cuál libretica (ej. redil-extraordinario-2026-11-07)
  point       INTEGER,                          -- número del punto; NULL = pregunta general
  asker_name  TEXT    NOT NULL,
  asker_phone TEXT    NOT NULL DEFAULT '',
  group_name  TEXT    NOT NULL DEFAULT '',
  group_id    INTEGER,
  question    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta', 'atendida')),
  answer      TEXT    NOT NULL DEFAULT '',
  answered_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redil_questions_libreta_idx ON redil_questions (libreta, point, created_at);
CREATE INDEX IF NOT EXISTS redil_questions_group_idx ON redil_questions (group_id);
