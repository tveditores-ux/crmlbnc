-- 003: acceso al panel con cuenta de Google

ALTER TABLE people ADD COLUMN IF NOT EXISTS google_email TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'ninguno';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_access_level_chk') THEN
    ALTER TABLE people ADD CONSTRAINT people_access_level_chk CHECK (access_level IN ('ninguno', 'admin', 'coordinador'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS people_google_email_uq ON people (lower(google_email)) WHERE google_email IS NOT NULL;
