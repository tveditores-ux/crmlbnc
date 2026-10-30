-- 015: registro de bautizados (pestaña Bautizados).
-- Lista independiente, como nueva_vida: sin FK a people, para que unir o borrar personas nunca la rompa.
-- No crea personas ni toca opt_in.

CREATE TABLE IF NOT EXISTS bautizados (
  id            SERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  phone         TEXT,                                   -- solo dígitos con código de país, como people.phone
  baptism_date  DATE,
  sede          TEXT NOT NULL DEFAULT '',
  minister      TEXT NOT NULL DEFAULT '',               -- quién bautizó
  note          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'Registro manual',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bautizados_phone_idx ON bautizados (phone);
CREATE INDEX IF NOT EXISTS bautizados_date_idx ON bautizados (baptism_date DESC);
