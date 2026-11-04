-- 027: el reporte semanal del grupo recoge lo que los líderes ya usaban en su formulario de Matrimonios:
-- hora de entrada y de salida (puntualidad), etapa del grupo y semana de la etapa, invitados recientes,
-- ofrenda también en divisas con la referencia del pago (solo los 4 últimos números) y si el líder
-- asistió a los servicios del miércoles y del domingo. Todo es opcional: los reportes que ya existen no cambian.
-- La columna "offering" sigue siendo la ofrenda en bolívares.

ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS start_time    TEXT NOT NULL DEFAULT '';       -- 'HH:MM'
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS end_time      TEXT NOT NULL DEFAULT '';
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS stage         TEXT NOT NULL DEFAULT '';       -- Equipo, Conquista, ...
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS stage_week    INTEGER CHECK (stage_week IS NULL OR stage_week BETWEEN 1 AND 52);
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS recent_guests INTEGER;                        -- invitados de las últimas 3 semanas
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS offering_fx   NUMERIC(12,2);                  -- ofrenda en divisas
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS payment_ref   TEXT NOT NULL DEFAULT '';       -- últimos 4 números del pago móvil o transferencia
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS leader_wed    BOOLEAN;                         -- NULL = no lo dijo
ALTER TABLE care_group_reports ADD COLUMN IF NOT EXISTS leader_sun    BOOLEAN;
