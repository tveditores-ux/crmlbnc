-- 036: registro pastoral por enlace común (/pastores/<token>): los pastores y pastores asistentes
-- envían ellos mismos su ficha (la misma de los líderes de grupo de cuidado, más el estado civil),
-- igual que "Mis datos" (022) pero con su función, que al aplicarse queda como rol de la persona.
-- Lo sensible (cédula, dirección, nacimiento) solo se ve en el panel con sesión y se borra de la
-- respuesta cuando se atiende. Las fechas van como texto 'YYYY-MM-DD'.

CREATE TABLE IF NOT EXISTS pastor_submissions (
  id               SERIAL PRIMARY KEY,
  person_id        INTEGER REFERENCES people(id) ON DELETE CASCADE,   -- NULL = persona nueva
  status           TEXT NOT NULL DEFAULT 'pendiente',                 -- pendiente | aplicada | descartada
  auto_applied     BOOLEAN NOT NULL DEFAULT FALSE,
  funcion          TEXT NOT NULL DEFAULT '',                          -- Pastor | Pastor asistente
  full_name        TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  birth_date       TEXT NOT NULL DEFAULT '',
  cedula           TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  civil_status     TEXT NOT NULL DEFAULT '',
  congregation     TEXT NOT NULL DEFAULT '',
  wants_messages   BOOLEAN NOT NULL DEFAULT FALSE,   -- pidió recibir recordatorios: NO cambia opt_in por sí solo
  photo            BYTEA,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pastor_submissions_status_idx ON pastor_submissions (status, created_at);
