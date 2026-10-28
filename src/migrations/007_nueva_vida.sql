-- 007: registro de Nueva Vida (lista de nuevos creyentes) y marca de "histórica" en consolidación
-- El registro es independiente: desde él se conecta cada persona a consolidación cuando se quiera seguirla.

CREATE TABLE IF NOT EXISTS nueva_vida (
  id               SERIAL PRIMARY KEY,
  full_name        TEXT NOT NULL,
  phone            TEXT,                                   -- solo dígitos con código de país, como people.phone
  email            TEXT,
  decision_date    DATE,
  date_note        TEXT NOT NULL DEFAULT '',               -- por ejemplo: "el año se dedujo"
  sede             TEXT NOT NULL DEFAULT '',
  age              INTEGER CHECK (age IS NULL OR (age BETWEEN 0 AND 120)),
  civil_status     TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',               -- dato sensible: solo en la ficha, nunca en la lista
  how_arrived      TEXT NOT NULL DEFAULT '',
  followup         TEXT NOT NULL DEFAULT '',               -- texto de "seguimiento" de las listas originales
  note             TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'Registro manual',
  needs_review     BOOLEAN NOT NULL DEFAULT FALSE,
  review_note      TEXT NOT NULL DEFAULT '',
  raw_text         TEXT NOT NULL DEFAULT '',               -- texto original de la lista, para corregir a mano
  person_id        INTEGER REFERENCES people(id) ON DELETE SET NULL,
  consolidation_id INTEGER REFERENCES consolidation(id) ON DELETE SET NULL,
  connected_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nueva_vida_phone_idx ON nueva_vida (phone);
CREATE INDEX IF NOT EXISTS nueva_vida_date_idx ON nueva_vida (decision_date DESC);
CREATE INDEX IF NOT EXISTS nueva_vida_review_idx ON nueva_vida (needs_review) WHERE needs_review;

-- Las personas conectadas desde listas viejas no tienen etapas confiables: se marcan como históricas
-- y no cuentan en el embudo ni en la retención salvo que se pida.
ALTER TABLE consolidation ADD COLUMN IF NOT EXISTS historical BOOLEAN NOT NULL DEFAULT FALSE;
