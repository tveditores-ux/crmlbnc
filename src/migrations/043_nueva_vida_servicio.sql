-- 043: en qué servicio se convirtió cada nuevo creyente (pedido del pastor, 2026-11-15):
-- Domingo 1, Domingo 2, Domingo 3 o Miércoles. Lo llena el registro del día de conversión.
ALTER TABLE nueva_vida ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT '';
