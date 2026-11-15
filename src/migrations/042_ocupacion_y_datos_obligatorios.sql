-- 042: ocupación en la ficha y en los formularios de registro (pedido de Eliezer, 2026-11-14:
-- «A los formularios de registro ponle ocupación y todos los datos obligatorios»).
-- La columna en cada tabla de respuestas guarda lo que la persona escribió; al aplicarse la
-- respuesta, la ocupación pasa a la ficha (people.occupation). En la tabla de líderes de grupo
-- de cuidado la columna sigue el prefijo de esa tabla: leader_occupation.

ALTER TABLE people ADD COLUMN IF NOT EXISTS occupation TEXT NOT NULL DEFAULT '';
ALTER TABLE member_submissions ADD COLUMN IF NOT EXISTS occupation TEXT NOT NULL DEFAULT '';
ALTER TABLE pastor_submissions ADD COLUMN IF NOT EXISTS occupation TEXT NOT NULL DEFAULT '';
ALTER TABLE ministry_leader_submissions ADD COLUMN IF NOT EXISTS occupation TEXT NOT NULL DEFAULT '';
ALTER TABLE care_group_submissions ADD COLUMN IF NOT EXISTS leader_occupation TEXT NOT NULL DEFAULT '';
-- En los grupos de cuidado la ficha del líder vive en el propio grupo (como leader_cedula o leader_address).
ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS leader_occupation TEXT NOT NULL DEFAULT '';
