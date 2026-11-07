-- 031: libretica del REDIL por enlace común (sin grupo): cada teléfono es un "device_id" y manda una fila por punto.
ALTER TABLE redil_questions ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS redil_questions_one_per_device_point_uq
  ON redil_questions (libreta, device_id, COALESCE(point, 0)) WHERE device_id <> '';

-- La libretica ganó una sección al inicio ("Compartiendo", 3 puntos): los puntos de antes pasan de n a n+3 para que cada
-- pregunta ya enviada siga pegada a su mismo punto. Dos pasos para no chocar con el índice único a mitad del cambio.
UPDATE redil_questions SET point = point + 1000 WHERE libreta = 'redil-extraordinario-2026-11-07' AND point IS NOT NULL;
UPDATE redil_questions SET point = point - 997 WHERE libreta = 'redil-extraordinario-2026-11-07' AND point >= 1000;
