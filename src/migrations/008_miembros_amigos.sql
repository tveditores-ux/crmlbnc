-- 008: miembros y amigos, y pertenencia al grupo oficial de WhatsApp
-- No toca las columnas que ya existen. Estar en el grupo NO es aceptar recordatorios: opt_in no cambia.

ALTER TABLE people ADD COLUMN IF NOT EXISTS membership TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS whatsapp_name TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS in_official_group BOOLEAN NOT NULL DEFAULT FALSE;

-- '' significa "Por clasificar".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_membership_chk') THEN
    ALTER TABLE people ADD CONSTRAINT people_membership_chk CHECK (membership IN ('', 'miembro', 'amigo'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS people_membership_idx ON people (membership);
