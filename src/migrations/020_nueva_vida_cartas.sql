-- 020: registro de cartas de bienvenida enviadas (a mano, desde el WhatsApp de quien administra).
-- Sirve para ver quién ya recibió su carta y no mandarla dos veces. No es un envío del sistema ni cambia ningún opt_in.

CREATE TABLE IF NOT EXISTS nueva_vida_cartas (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL,                       -- solo dígitos con código de país
  name            TEXT NOT NULL DEFAULT '',
  nueva_vida_id   INTEGER REFERENCES nueva_vida(id) ON DELETE SET NULL,
  letter          TEXT NOT NULL,                       -- id de la carta (ej. 'dama')
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nueva_vida_cartas_phone_idx ON nueva_vida_cartas (phone, letter);
