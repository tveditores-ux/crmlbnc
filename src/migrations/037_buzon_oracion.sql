-- 034: Buzón de oración. Peticiones de oración (o información) que llegan por Grace o se escriben en el panel y que el
-- pastor envía por WhatsApp al líder del grupo de cuidado o al pastor de la congregación.
-- Sin FK a people ni a care_groups a propósito: unir o borrar personas, o borrar un grupo, nunca rompe ni borra el buzón
-- (si el grupo ya no existe, la petición queda "sin grupo").
CREATE TABLE IF NOT EXISTS prayer_requests (
  id              SERIAL PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'oracion' CHECK (kind IN ('oracion', 'informacion')),
  requester_name  TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL,
  care_group_id   INTEGER,
  congregation    TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'panel' CHECK (source IN ('panel', 'whatsapp')),
  status          TEXT NOT NULL DEFAULT 'nueva' CHECK (status IN ('nueva', 'enviada', 'archivada')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prayer_requests_status_idx ON prayer_requests (status, created_at DESC);

-- Cada envío (sin guardar el teléfono): a quién, si llegó o por qué no.
CREATE TABLE IF NOT EXISTS prayer_sends (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES prayer_requests(id) ON DELETE CASCADE,
  to_kind     TEXT NOT NULL CHECK (to_kind IN ('lider', 'pastor')),
  to_name     TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL CHECK (result IN ('enviado', 'fallido')),
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pastor de cada congregación (Niños, Jóvenes, Matrimonios...): a quién se le manda lo de esa congregación.
CREATE TABLE IF NOT EXISTS congregation_pastors (
  congregation  TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
