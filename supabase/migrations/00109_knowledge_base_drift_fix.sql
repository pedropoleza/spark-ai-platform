-- =============================================
-- 00109_knowledge_base_drift_fix (Pedro 2026-06-15)
--
-- DRIFT REAL achado pela trava (scripts/check-migration-drift.ts) no 1º run:
-- knowledge_base.description e knowledge_base.usage_instructions estavam
-- DECLARADAS (00010 ALTER ADD + 00017 inline no CREATE TABLE) mas AUSENTES em
-- prod. Causa: trap do `CREATE TABLE IF NOT EXISTS` — a knowledge_base já existia
-- quando a 00017 rodou, então o IF NOT EXISTS virou no-op e as colunas inline
-- nunca foram adicionadas; e a 00010 (ALTER ADD) também não pegou em prod.
--
-- IMPACTO (estava quebrando AGORA): o código referencia as duas direto —
--   - src/app/api/agents/test/route.ts:326  → SELECT "...description, usage_instructions"
--     (SELECT com coluna inexistente ERRA → load de KB no test chat quebrado)
--   - src/app/api/knowledge-base/route.ts    → INSERT/UPDATE usage_instructions/description
--   - src/components/agents/sales/knowledge-base-editor.tsx (UI)
--
-- Aditivo, idempotente, nullable (sem default destrutivo) — só destrava.
-- =============================================
ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS usage_instructions TEXT;
