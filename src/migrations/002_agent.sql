-- 002: agente de WhatsApp (conversaciones y casos para atención humana)

CREATE TABLE IF NOT EXISTS agent_messages (
  id          SERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  person_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body        TEXT NOT NULL DEFAULT '',
  escalated   BOOLEAN NOT NULL DEFAULT FALSE,
  reason      TEXT,
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_messages_phone_idx ON agent_messages (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_messages_open_idx ON agent_messages (created_at DESC) WHERE escalated AND NOT resolved;
