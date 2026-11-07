-- 030: en la libretica del REDIL cada líder tiene UNA caja por punto (más una general): reenviar corrige, no duplica.
-- Si hubiera filas repetidas de antes, se conserva la más reciente de cada punto.
DELETE FROM redil_questions a USING redil_questions b
 WHERE a.group_id IS NOT NULL AND a.group_id = b.group_id AND a.libreta = b.libreta
   AND COALESCE(a.point, 0) = COALESCE(b.point, 0) AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS redil_questions_one_per_point_uq
  ON redil_questions (libreta, group_id, COALESCE(point, 0)) WHERE group_id IS NOT NULL;
