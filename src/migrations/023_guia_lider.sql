-- 023: Guía del líder: respuestas aprobadas a las dudas operativas de los líderes (espacios y equipos, grupos,
-- ofrendas, formación, ruta de crecimiento y cómo usar su enlace).
-- Los líderes (en su enlace) y el asistente de WhatsApp solo ven lo "confirmada". Aquí no van datos de personas.

CREATE TABLE IF NOT EXISTS leader_guide (
  id          SERIAL PRIMARY KEY,
  category    TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  contact     TEXT NOT NULL DEFAULT '',          -- a quién escribir para ese tema
  source      TEXT NOT NULL DEFAULT '',          -- de dónde sale (minuta, norma, documento)
  status      TEXT NOT NULL DEFAULT 'por_confirmar' CHECK (status IN ('confirmada', 'por_confirmar')),
  review_by   TEXT NOT NULL DEFAULT '',          -- 'YYYY-MM-DD': fecha para volver a revisarla (vacío = sin fecha)
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leader_guide_status_idx ON leader_guide (status, active, sort);
