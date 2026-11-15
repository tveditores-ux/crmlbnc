-- 040: el registro de líderes de ministerios de desarrollo permite liderar MÁS DE UN ministerio
-- (pedido de Eliezer, 2026-11-14) y pregunta si la persona sirve en algún ministerio congregacional.
-- `ministerios` guarda la lista completa como JSON (p. ej. ["Alabanza","Medios"]); la columna
-- `ministerio` de 038 queda con el primero, para lo ya hecho. `congregacional` guarda el ministerio
-- congregacional donde sirve (Niños, Jóvenes, Mujeres…), vacío si no sirve en ninguno: al aplicarse,
-- la persona queda sirviendo en ese ministerio (sin quedar como su coordinadora).

ALTER TABLE ministry_leader_submissions ADD COLUMN IF NOT EXISTS ministerios TEXT NOT NULL DEFAULT '';
ALTER TABLE ministry_leader_submissions ADD COLUMN IF NOT EXISTS congregacional TEXT NOT NULL DEFAULT '';
