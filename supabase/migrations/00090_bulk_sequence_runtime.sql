-- Bulk Sequence runtime (Etapa 4.4 — Pedro 2026-05-28).
-- _planning/_gaps-prospeccao-2026-05-28/PLANO.md §6.4
--
-- Migration 00089 criou as TABELAS de sequência (bulk_message_sequences +
-- bulk_message_sequence_state). Esta adiciona o que FALTA pro runner funcionar:
--
-- 1. bulk_message_jobs.has_sequence: flag pra populator detectar sem JOIN.
-- 2. bulk_message_recipients.message_template_override: quando setado, o
--    bulk-message-runner usa ele em vez de job.message_template. Sequence-
--    runner seta esse campo pra recipients de step 2+ (cada step com seu
--    próprio template). NULL = usa template do job (backward compat).
-- 3. bulk_message_recipients.sequence_step: número do step que esse recipient
--    representa (1 pro inicial, 2+ pros toques seguintes). Útil pra UI
--    timeline + stats por step. NULL = não-sequência (jobs antigos).
--
-- Tudo aditivo, NULL default, zero quebra em jobs/recipients existentes.

ALTER TABLE bulk_message_jobs
  ADD COLUMN IF NOT EXISTS has_sequence BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS message_template_override TEXT;

ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS sequence_step INT;

-- Index pra UI timeline querying por step (raro mas barato).
CREATE INDEX IF NOT EXISTS idx_bulk_recipients_sequence_step
  ON bulk_message_recipients(job_id, sequence_step) WHERE sequence_step IS NOT NULL;

COMMENT ON COLUMN bulk_message_jobs.has_sequence IS
  'Pedro 2026-05-28: TRUE se job tem bulk_message_sequences rows. Populator usa pra criar bulk_message_sequence_state quando job vira running.';

COMMENT ON COLUMN bulk_message_recipients.message_template_override IS
  'Pedro 2026-05-28: usado por sequence-runner pra steps 2+ terem template diferente do job. NULL = bulk-message-runner usa job.message_template.';

COMMENT ON COLUMN bulk_message_recipients.sequence_step IS
  'Pedro 2026-05-28: step da sequência que esse recipient representa. NULL = single-shot job (não-sequência).';
