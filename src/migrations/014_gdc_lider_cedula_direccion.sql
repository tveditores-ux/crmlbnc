-- 014: cédula de identidad (C.I.) y dirección de residencia del líder, enviadas desde la planilla del líder.
-- La cédula va normalizada como 'V-12345678' / 'E-12345678'. Es un dato sensible: solo se muestra en el panel con sesión.

ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS leader_cedula   TEXT NOT NULL DEFAULT '';
ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS leader_address  TEXT NOT NULL DEFAULT '';

ALTER TABLE care_group_submissions ADD COLUMN IF NOT EXISTS leader_cedula   TEXT NOT NULL DEFAULT '';
ALTER TABLE care_group_submissions ADD COLUMN IF NOT EXISTS leader_address  TEXT NOT NULL DEFAULT '';
