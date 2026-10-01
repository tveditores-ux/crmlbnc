-- 001: estructura inicial de la fase 1

CREATE TABLE IF NOT EXISTS people (
  id                SERIAL PRIMARY KEY,
  full_name         TEXT NOT NULL,
  phone             TEXT,
  email             TEXT,
  role              TEXT NOT NULL DEFAULT '',
  preferred_channel TEXT NOT NULL DEFAULT 'whatsapp'
                    CHECK (preferred_channel IN ('whatsapp', 'email', 'ambos')),
  opt_in            BOOLEAN NOT NULL DEFAULT FALSE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS people_phone_uq ON people (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS people_email_uq ON people (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS ministries (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  coordinator_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ministries_name_uq ON ministries (lower(name));

CREATE TABLE IF NOT EXISTS person_ministries (
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ministry_id INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, ministry_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  starts_at   TIMESTAMPTZ NOT NULL,
  cancelled   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_starts_idx ON events (starts_at);

CREATE TABLE IF NOT EXISTS event_ministries (
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ministry_id INTEGER NOT NULL REFERENCES ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, ministry_id)
);

CREATE TABLE IF NOT EXISTS event_participants (
  id               SERIAL PRIMARY KEY,
  event_id         INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id        INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente', 'confirmado', 'no_puede')),
  token            TEXT NOT NULL UNIQUE,
  responded_at     TIMESTAMPTZ,
  response_channel TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, person_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id                  SERIAL PRIMARY KEY,
  participant_id      INTEGER NOT NULL REFERENCES event_participants(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,              -- 1m | 1w | 1d | manual
  channel             TEXT NOT NULL,              -- whatsapp | email
  status              TEXT NOT NULL,              -- enviando | enviado | simulado | fallido
  delivery_status     TEXT,                       -- sent | delivered | read | failed (WhatsApp)
  provider_message_id TEXT,
  error               TEXT,
  attempts            INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once_uq
  ON notifications (participant_id, kind, channel) WHERE kind <> 'manual';
CREATE INDEX IF NOT EXISTS notifications_provider_idx ON notifications (provider_message_id);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id          SERIAL PRIMARY KEY,
  from_phone  TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  payload     TEXT,
  handled_as  TEXT,
  raw         JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
