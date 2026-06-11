-- 00101 — bulk_message_jobs.daily_cap (F60, Pedro 2026-06-10)
--
-- MOTIVAÇÃO (gap de paridade — config admin que não fazia nada):
-- A UI do agente promete "Aborda até N pessoas/dia" (agent-detail-view linhas
-- 1134/1437, ligada a agent_configs.outreach_config.daily_cap). Esse teto SÓ
-- era enforçado no chat do SparkBot (schedule_bulk_message_v2). Os caminhos
-- AUTOMÁTICOS — prospecção (outreach-runner), campanhas /hub (campaign-populator,
-- acionado no paused→running) e recorrentes (recurring-runner) — calculavam o
-- cap e o IGNORAVAM: enfileiravam TODOS os contatos sem nenhum teto diário.
--
-- Fix F60: o cap RESOLVIDO no momento da criação do job passa a ser PERSISTIDO
-- aqui. O populator/recorrente leem essa coluna e espalham os recipients de modo
-- que nenhum DIA-DE-ENVIO (America/New_York) ultrapasse o teto (overflow rola pro
-- próximo dia). Fonte do valor por caminho:
--   - outreach-runner   → outreach_config.daily_cap  (promessa da UI)
--   - /hub/campaigns    → agent_configs.daily_bulk_message_cap (getDailyCap)
--   - recurring-runner  → agent_configs.daily_bulk_message_cap (getDailyCap)
--
-- NULL = sem teto diário (comportamento linear histórico — zero mudança). Jobs
-- antigos (pré-F60) ficam NULL; o populator faz fallback resolvendo o cap do
-- agente em runtime, então nenhum job legado fica sem proteção.
--
-- Aditivo/idempotente.

BEGIN;

ALTER TABLE public.bulk_message_jobs
  ADD COLUMN IF NOT EXISTS daily_cap integer
    CHECK (daily_cap IS NULL OR daily_cap > 0);

COMMENT ON COLUMN public.bulk_message_jobs.daily_cap IS
  'F60: teto de recipients por dia-de-envio (America/New_York). NULL = sem teto. '
  'Snapshot do cap resolvido na criação do job (outreach_config.daily_cap p/ '
  'prospecção; daily_bulk_message_cap p/ campanhas). Enforçado no populate-time '
  'espalhando scheduled_at entre dias.';

COMMIT;
