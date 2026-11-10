-- Control remoto de Grace dentro del CRM: la conversación de quien administra con Grace (modo pastoral)
-- y el avatar que se le pone a Grace en esa pantalla.
CREATE TABLE IF NOT EXISTS remote_chat (
  id          SERIAL PRIMARY KEY,
  user_key    TEXT NOT NULL,                 -- 'admin' (clave de emergencia) o 'p:<id de la persona>' (acceso de Google)
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remote_chat_user_idx ON remote_chat (user_key, id);

CREATE TABLE IF NOT EXISTS remote_avatar (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
