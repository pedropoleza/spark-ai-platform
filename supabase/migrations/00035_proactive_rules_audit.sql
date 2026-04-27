-- Sparkbot V2.2 — Audit columns em assistant_proactive_rules.
--
-- Quando admin edita uma regra (mexe em prompt_instruction, cooldown, tools_allowed),
-- precisa ser auditável: quem mudou e quando. updated_at já existe; falta saber QUEM.
--
-- created_by_user_id e last_modified_by_user_id armazenam GHL user IDs (TEXT).
-- Não viramos foreign key porque a tabela de admins do GHL não vive no nosso DB —
-- a SSO valida em runtime via API. TEXT puro é suficiente pra rastreabilidade.
--
-- Idempotente — usa IF NOT EXISTS.

ALTER TABLE assistant_proactive_rules
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS last_modified_by_user_id TEXT;

-- Não adiciona índice — busca por created_by/modified_by raríssima
-- (debug pontual). Custo de manter índice não compensa.

COMMENT ON COLUMN assistant_proactive_rules.created_by_user_id IS
  'GHL user ID do admin que criou a regra. NULL pra system rules e regras criadas antes da migration 00035.';

COMMENT ON COLUMN assistant_proactive_rules.last_modified_by_user_id IS
  'GHL user ID do admin que editou por último. NULL se nunca foi editada após criação.';
