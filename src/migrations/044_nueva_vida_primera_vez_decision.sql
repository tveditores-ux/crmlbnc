-- Nuevos creyentes: si es la primera vez en la iglesia (o ya había venido) y si la decisión fue conversión o reconciliación.
-- Lo pidió el pastor el 2026-11-15 para el registro del día de conversión.
ALTER TABLE nueva_vida ADD COLUMN IF NOT EXISTS first_time TEXT NOT NULL DEFAULT '';
ALTER TABLE nueva_vida ADD COLUMN IF NOT EXISTS decision_type TEXT NOT NULL DEFAULT '';
