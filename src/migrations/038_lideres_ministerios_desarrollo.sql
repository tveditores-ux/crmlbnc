-- 038: líderes de ministerios de desarrollo por enlace común (/desarrollo/<token>): los líderes de los
-- ministerios de desarrollo (Alabanza, Diaconado, Nueva Vida, Anfitriones, Medios…) envían ellos mismos
-- su ficha (la misma de los líderes de grupo de cuidado, más el estado civil), igual que el registro
-- ministerial (036) pero solo para ellos, con su ministerio y su cargo. Los ministerios congregacionales
-- (Niños, Jóvenes, Matrimonios, Mujeres, Hombres…) ya van como congregación en todas las planillas.
-- Lo sensible (cédula, dirección, nacimiento) solo se ve en el panel con sesión y se borra de la
-- respuesta cuando se atiende. Las fechas van como texto 'YYYY-MM-DD'.

CREATE TABLE IF NOT EXISTS ministry_leader_submissions (
  id               SERIAL PRIMARY KEY,
  person_id        INTEGER REFERENCES people(id) ON DELETE CASCADE,   -- NULL = persona nueva
  status           TEXT NOT NULL DEFAULT 'pendiente',                 -- pendiente | aplicada | descartada
  auto_applied     BOOLEAN NOT NULL DEFAULT FALSE,
  ministerio       TEXT NOT NULL DEFAULT '',                          -- ministerio de desarrollo que lidera
  cargo            TEXT NOT NULL DEFAULT '',                          -- Líder del ministerio | Sublíder / asistente
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
CREATE INDEX IF NOT EXISTS ministry_leader_submissions_status_idx ON ministry_leader_submissions (status, created_at);
