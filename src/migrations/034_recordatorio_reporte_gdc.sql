-- 034: Registro de los recordatorios de reporte semanal enviados a los líderes de GdC
-- (src/report-reminders.js). Una fila por grupo, reunión y canal: así el mismo recordatorio
-- no se envía dos veces y un envío fallido se puede reintentar (máx. 3 intentos, cada 30 min),
-- con el mismo criterio que la tabla notifications de los recordatorios de eventos.
-- No guarda el texto del mensaje ni datos de la persona: solo a qué grupo y reunión se recordó.

CREATE TABLE IF NOT EXISTS care_report_reminders (
  id                  SERIAL PRIMARY KEY,
  group_id            INTEGER NOT NULL REFERENCES care_groups(id) ON DELETE CASCADE,
  meeting_date        DATE NOT NULL,             -- la fecha de la reunión cuyo reporte falta
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  status              TEXT NOT NULL DEFAULT 'enviando',  -- enviando | enviado | fallido
  attempts            INTEGER NOT NULL DEFAULT 1,
  provider_message_id TEXT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, meeting_date, channel)
);

CREATE INDEX IF NOT EXISTS care_report_reminders_date_idx ON care_report_reminders (meeting_date);
