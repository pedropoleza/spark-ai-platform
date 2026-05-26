-- ============================================================================
-- 00085 — Re-assert as colunas de pausa em conversation_state (fix de DRIFT)
-- ============================================================================
-- CONTEXTO (descoberto verificando a prod 2026-05-26):
--   conversation_state (tabela dos agentes de LEAD) NÃO tem ai_paused_at /
--   ai_paused_reason em produção — embora a migration 00009 as declare. Ou seja,
--   00009 nunca foi aplicada à prod (ambientes fresh/staging têm as colunas;
--   só a prod ficou pra trás). A coluna ai_paused_at que EXISTE é a de
--   assistant_conversations (SparkBot, migration 00029) — outra tabela.
--
-- IMPACTO DO DRIFT (pausa de lead quebrada ponta a ponta):
--   • WRITE  webhook inbound (opt-out + handoff humano) faz upsert com
--     ai_paused_at/ai_paused_reason → PGRST204 "column not found" → o upsert
--     INTEIRO falha → status='disqualified'/'handed_off' também NÃO persiste.
--     => opt-out de lead ("parar"/"stop") não para o agente (risco de compliance).
--   • WRITE  queue-processor (ai_parse_failure_loop) idem.
--   • READ   queue-processor checa `convState.ai_paused_at` antes de responder →
--     sempre undefined → a IA NUNCA respeita a pausa.
--
-- FIX: trazer a prod pra forma já declarada (idempotente — mesmo pattern do
-- 00009). Aditivo, colunas nullable, sem lock relevante (tabela pequena). Depois
-- de aplicado, todo o mecanismo de pausa/handoff/opt-out de lead passa a
-- funcionar SEM nenhuma mudança de código (o código já escreve/lê essas colunas).
-- ============================================================================

ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_conversation_state_ai_paused
  ON conversation_state(ai_paused_at)
  WHERE ai_paused_at IS NOT NULL;
