-- 046: Co-líder del grupo de cuidado. Las parejas de Matrimonios lideran juntas un mismo grupo,
-- pero el grupo guardaba un solo nombre de líder: si quedaba el del esposo, la esposa no
-- aparecía como líder en ninguna parte (caso Fernando y Livia Paredes, 2026-11-19).
-- El co-líder es solo un nombre que acompaña al líder donde el grupo se muestra; el enlace
-- del grupo y los datos de contacto siguen siendo los del líder.
ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS co_leader_name TEXT NOT NULL DEFAULT '';
