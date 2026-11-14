-- 039: el remoto de líderes de ministerios de desarrollo (038) deja de pedir el cargo (pedido de
-- Eliezer, 2026-11-14): el enlace es solo para líderes, así que el cargo sobra. En su lugar la
-- planilla pregunta a qué grupo de cuidado pertenece o asiste la persona: elige uno de los grupos
-- activos (se guardan su nombre y su id) o marca que no asiste a ninguno. Al aplicarse la respuesta,
-- el nombre de la persona entra en la lista de gente de ese grupo (care_group_people), que es como
-- este CRM lleva quién está en cada grupo (texto, sin FK a people).

ALTER TABLE ministry_leader_submissions DROP COLUMN IF EXISTS cargo;
ALTER TABLE ministry_leader_submissions ADD COLUMN IF NOT EXISTS grupo_cuidado TEXT NOT NULL DEFAULT '';
ALTER TABLE ministry_leader_submissions ADD COLUMN IF NOT EXISTS grupo_cuidado_id INTEGER;
