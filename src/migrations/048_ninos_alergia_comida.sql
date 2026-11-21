-- Alergias o alimentos que el niño no puede comer (pedido del pastor, 2026-11-21): un campo opcional y
-- acotado a la comida en el registro de niños — nada de diagnósticos ni medicamentos — que viaja en la
-- respuesta y al aplicarse queda en la ficha del niño, visible solo para el equipo en el panel.
ALTER TABLE child_submissions ADD COLUMN IF NOT EXISTS food_allergy TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS food_allergy TEXT NOT NULL DEFAULT '';
