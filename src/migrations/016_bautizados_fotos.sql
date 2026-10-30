-- 016: foto de cada bautizado (una por persona), subida desde su ficha o en lote desde /bautizados/fotos.
-- Tabla aparte para que las consultas de la lista nunca arrastren los bytes. Solo se sirve con sesión del panel.

CREATE TABLE IF NOT EXISTS bautizados_fotos (
  bautizado_id  INTEGER PRIMARY KEY REFERENCES bautizados(id) ON DELETE CASCADE,
  data          BYTEA NOT NULL,                 -- JPEG ya reducido en el navegador (sin datos de ubicación)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
