-- 025: las tres categorías de REDIL en la Guía del líder (ordinario, extraordinario y extendido) y dos respuestas de arranque,
-- tomadas de la definición que la iglesia ya usa. Quedan "por confirmar". No se inventa nada sobre el ordinario ni el extraordinario:
-- esas respuestas las escribe la iglesia en /guia.

INSERT INTO leader_guide (status, category, question, answer, contact, source, sort)
SELECT 'por_confirmar', 'REDIL ordinario', '¿Qué es el REDIL?', 'Es la reunión de empoderamiento, dirección e instrucción para el liderazgo.', '', 'Glosario de la iglesia', 100
WHERE NOT EXISTS (SELECT 1 FROM leader_guide WHERE question = '¿Qué es el REDIL?');

INSERT INTO leader_guide (status, category, question, answer, contact, source, sort)
SELECT 'por_confirmar', 'REDIL extendido', '¿Quiénes están convocados al REDIL extendido?', 'Todos los líderes: pastores, coordinadores, líderes asesores y líderes.', '', 'Glosario de la iglesia', 101
WHERE NOT EXISTS (SELECT 1 FROM leader_guide WHERE question = '¿Quiénes están convocados al REDIL extendido?');
