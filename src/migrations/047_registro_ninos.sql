-- Registro de niños y adolescentes (pedido del pastor, 2026-11-21): un enlace para que el papá, la mamá
-- o el representante registre a su hijo de 3 a 17 años. Cada envío espera la revisión del panel y al
-- aplicarse crea o completa la ficha del niño en Personas; las dos fotos (del niño y del representante)
-- viajan en la respuesta, y la del niño pasa a la ficha al aplicarse.
CREATE TABLE IF NOT EXISTS child_submissions (
  id SERIAL PRIMARY KEY,
  child_name TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  congregation TEXT NOT NULL DEFAULT '',
  parent_name TEXT NOT NULL DEFAULT '',
  parent_relation TEXT NOT NULL DEFAULT '',
  parent_phone TEXT NOT NULL DEFAULT '',
  photo_child BYTEA,
  photo_parent BYTEA,
  status TEXT NOT NULL DEFAULT 'pendiente',
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  auto_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
