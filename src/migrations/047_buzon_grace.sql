-- 047: Buzón de oración conectado a Grace. La petición recuerda de quién es (sin FK a propósito, como el resto del
-- buzón: unir o borrar personas nunca lo rompe) para enlazar su ficha y para que varios mensajes seguidos de la misma
-- persona se junten en una sola petición en vez de repetirse.
ALTER TABLE prayer_requests ADD COLUMN IF NOT EXISTS person_id INTEGER;
CREATE INDEX IF NOT EXISTS prayer_requests_person_idx ON prayer_requests (person_id, created_at DESC);
-- Y un tercer origen: "pastor", la que el pastor le dicta a Grace en modo pastoral (no la escribió en el panel).
ALTER TABLE prayer_requests DROP CONSTRAINT IF EXISTS prayer_requests_source_check;
ALTER TABLE prayer_requests ADD CONSTRAINT prayer_requests_source_check CHECK (source IN ('panel', 'whatsapp', 'pastor'));
