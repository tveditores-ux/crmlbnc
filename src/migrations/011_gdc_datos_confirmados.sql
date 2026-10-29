-- 011: cuándo confirmó el líder los datos de su grupo desde el formulario del teléfono (NULL = aún no).
ALTER TABLE care_groups ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;
