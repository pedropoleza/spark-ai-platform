-- =============================================================================
-- Migration 00114: recurring_campaigns/outreach_runs.agent_id NULLABLE (Pedro 2026-06-18)
-- =============================================================================
-- Fix P0 do review adversarial da feature de campanhas em grupo (00113).
--
-- Campanha de GRUPO é rep-facing (SparkBot) e NÃO tem agente lead-facing — então
-- a recorrência de grupo grava agent_id=null. Mas duas tabelas do pipeline de
-- recorrência ainda exigiam agent_id NOT NULL:
--   - recurring_campaigns.agent_id  → o INSERT da recorrência de grupo falhava
--     (23502) e NENHUMA campanha recorrente de grupo era criada (caso Matheus
--     "2 posts/dia às 7:30" estava morto na chegada).
--   - outreach_runs.agent_id        → mesmo relaxando a 1ª, o audit por ocorrência
--     (writeAfterRun) falhava silenciosamente, quebrando o ciclo.
--
-- bulk_message_jobs.agent_id JÁ é nullable (00050, ON DELETE SET NULL) — o
-- one-shot de grupo sempre funcionou. Esta migration alinha as duas tabelas de
-- recorrência ao mesmo desenho ("disparo sem agente é válido"). Puramente
-- aditiva/relaxante: NÃO quebra nenhuma recorrência/run existente (que continuam
-- com agent_id preenchido). Aplicado em prod via MCP — arquivo sempre criado.
-- =============================================================================

ALTER TABLE public.recurring_campaigns ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE public.outreach_runs       ALTER COLUMN agent_id DROP NOT NULL;

COMMENT ON COLUMN public.recurring_campaigns.agent_id IS
  'Agente lead-facing dono da recorrência. NULL pra campanha de grupo (rep-facing, sem agente). Demais recorrências preenchem normalmente.';
COMMENT ON COLUMN public.outreach_runs.agent_id IS
  'Agente da ocorrência. NULL pra audit de recorrência de grupo (sem agente).';
