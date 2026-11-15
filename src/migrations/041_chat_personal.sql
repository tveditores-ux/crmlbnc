-- 041: chat de líderes (/chat/<token>): una sala donde los líderes y servidores conversan ENTRE ELLOS,
-- como un grupo de WhatsApp, y pueden preguntarle a Grace con un límite de preguntas por día y persona.
-- El enlace NO es común: es personal (uno por persona, desde su ficha), porque identifica quién escribe
-- en la sala y a quién le llegan las notificaciones. Las notificaciones son de la propia app (Web Push,
-- con las claves VAPID que el CRM genera y guarda en care_settings): no usan WhatsApp ni plantillas.
-- Grace responde en modo normal (el contexto de quien pregunta: su grupo, sus ministerios, sus eventos),
-- nunca con datos de otras personas; sus respuestas quedan en la sala como un mensaje más.

CREATE TABLE IF NOT EXISTS person_chat_links (
  person_id  INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_room_messages (
  id          SERIAL PRIMARY KEY,
  person_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,  -- autor (NULL cuando escribe Grace)
  author_name TEXT NOT NULL DEFAULT '',                            -- nombre visible en la sala (foto del momento)
  kind        TEXT NOT NULL DEFAULT 'persona' CHECK (kind IN ('persona', 'grace')),
  pregunta_de INTEGER REFERENCES people(id) ON DELETE SET NULL,    -- si es de Grace, quién le preguntó (para el límite diario)
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_room_messages_id ON chat_room_messages (id);

CREATE TABLE IF NOT EXISTS chat_room_reads (
  person_id        INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  last_read_id     INTEGER NOT NULL DEFAULT 0,
  last_notified_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           SERIAL PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_push_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_person ON push_subscriptions (person_id);
