-- 048: Quien está en un grupo de cuidado es miembro de la iglesia (lo pidió el pastor el 2026-11-19).
-- Desde ahora el registro "Mis datos" con un grupo y la inscripción del líder lo marcan solos; esto pone al día a
-- quienes ya tenían su grupo: fichas cuyo grupo de cuidado coincide con un grupo que existe, y los líderes de grupos
-- activos (por su teléfono). Solo cambia el tipo a "miembro"; no borra nada.
UPDATE people p SET membership = 'miembro', updated_at = now()
 WHERE p.membership <> 'miembro'
   AND (EXISTS (SELECT 1 FROM care_groups g WHERE lower(btrim(g.name)) = lower(btrim(p.care_group_name)) AND btrim(p.care_group_name) <> '')
        OR EXISTS (SELECT 1 FROM care_groups g WHERE g.active AND g.leader_phone <> '' AND g.leader_phone = p.phone));
