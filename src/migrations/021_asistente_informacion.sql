-- 021: información general de la iglesia que el asistente de WhatsApp puede compartir con quien le escribe
-- (horarios, sedes, direcciones, cómo bautizarse, contactos oficiales...). La escribe y la corrige quien administra el panel.
-- Es información pública de la iglesia: aquí no va ningún dato de personas.

CREATE TABLE IF NOT EXISTS agent_knowledge (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
