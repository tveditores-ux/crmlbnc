-- 032: configuración que se cambia desde el panel (hoy: las claves de WeCall), para no tener que entrar a Railway.
-- Las claves (secret = TRUE) se guardan CIFRADAS por la aplicación; esta tabla nunca guarda una clave en claro.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  secret     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
