-- 00112 — Alinha o CHECK de scheduled_followups.status com a REALIDADE de prod
-- e com o que o código escreve. (Review 2026-06-18, "buscar a perfeição".)
--
-- Drift histórico (ver MEMORY.md migration-drift-mcp): o arquivo 00040 definiu
-- CHECK (status IN ('pending','processing','completed','cancelled','failed')) —
-- SEM 'sent'. Prod foi corrigido à mão pra incluir 'sent'. O runner SEMPRE escreve
-- status='sent' (follow-up-scheduler.ts) e, desde hoje, status='cancelled' no gate
-- de decisão da IA (followup_skipped). Uma branch de staging criada a partir dos
-- ARQUIVOS de migration teria a constraint do 00040 (sem 'sent') → todo
-- UPDATE status='sent' estouraria check violation; como supabase-js NÃO lança
-- (devolve {error}), o runner seguiria sem marcar 'sent' e o follow-up seria
-- reprocessado em loop. Esta migration ADITIVA (não reescreve a 00040 já aplicada)
-- deixa arquivo↔prod idênticos e protege fresh-staging.
--
-- Conjunto canônico = exatamente os status que o código usa:
--   pending → processing → (sent | cancelled | failed)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'scheduled_followups'
      AND constraint_name = 'scheduled_followups_status_check'
  ) THEN
    ALTER TABLE scheduled_followups DROP CONSTRAINT scheduled_followups_status_check;
  END IF;

  ALTER TABLE scheduled_followups
    ADD CONSTRAINT scheduled_followups_status_check
    CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed'));
END $$;
