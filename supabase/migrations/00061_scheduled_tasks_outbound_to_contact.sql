-- 00061: Estende check constraint de task_type pra suportar
-- outbound_to_contact (msg agendada pra contato — schedule_message_to_contact)
-- + outbound_to_contact_recurring (cron-based).
-- Pedro 2026-05-06: nova capability "manda mensagem pra Maria amanhã 10h".

ALTER TABLE assistant_scheduled_tasks
DROP CONSTRAINT IF EXISTS assistant_scheduled_tasks_task_type_check;

ALTER TABLE assistant_scheduled_tasks
ADD CONSTRAINT assistant_scheduled_tasks_task_type_check
CHECK (task_type = ANY (ARRAY[
  'reminder'::text,
  'recurring_reminder'::text,
  'outbound_to_contact'::text,
  'outbound_to_contact_recurring'::text
]));
