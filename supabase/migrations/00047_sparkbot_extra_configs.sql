-- =============================================
-- 00047_sparkbot_extra_configs
--
-- Adiciona colunas pras configs novas do Sparkbot que Pedro pediu pra expor
-- na UI (2026-05-03 conversa). Algumas já existiam na tabela base
-- (quiet_hours, allowed_ghl_users, custom_instructions, debounce_seconds,
-- enable_audio_transcription, etc) — esta migration só completa o conjunto
-- com as que faltam:
--
--   1. daily_proactive_limit       — anti-spam: max msgs proativas por rep/dia
--   2. fallback_model              — modelo secundário (hoje hardcoded haiku)
--   3. disabled_tools              — array de tool names pra desabilitar
--   4. enabled_kbs                 — array de KBs habilitadas pro query_carrier_knowledge
--
-- Configs por REP ficam dentro de rep_identities.profile (jsonb existente)
-- pra evitar schema bloat — campos:
--   - profile.preferences.tone, response_style, emoji_usage (já tipados)
--   - profile.quiet_hours_personal (novo: rep-level override do agent)
-- =============================================

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS daily_proactive_limit integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS fallback_model text DEFAULT 'claude-haiku-4-5-20251001',
  ADD COLUMN IF NOT EXISTS disabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS enabled_kbs jsonb NOT NULL DEFAULT '["national_life_group","agency_brazillionaires"]'::jsonb;

COMMENT ON COLUMN agent_configs.daily_proactive_limit IS
  'Limite anti-spam: bot não envia mais que N mensagens proativas pro mesmo rep em 24h. Reminders criados pelo rep (schedule_reminder) NÃO contam — só proativos disparados por regras (briefings, alertas). 0 = desabilita o limite.';

COMMENT ON COLUMN agent_configs.fallback_model IS
  'Modelo secundário quando primário (ai_model) falha. Default: Claude Haiku 4.5 (mesmo provider, capacity pool diferente). Pode ser claude-haiku-*, gpt-4.1, etc. Veja H1 (DECISIONS.md) — fallback agressivo pra OpenAI piora compliance.';

COMMENT ON COLUMN agent_configs.disabled_tools IS
  'Array de nomes de tools (ex: ["delete_contact","send_message_to_contact"]) que o Sparkbot NUNCA usa nesta location, mesmo que o LLM tente. Bypass via getAllToolDefinitions filter. Útil pra modo treinamento ou contas sensíveis.';

COMMENT ON COLUMN agent_configs.enabled_kbs IS
  'Array de KBs habilitadas pro query_carrier_knowledge. Default: ambas (NLG + Brazillionaires). Pode restringir pra ["national_life_group"] em agências sem Brazillionaires content.';

-- Index pra permitir lookup rápido de tools desabilitadas (raro mas pode crescer)
-- Não cria — array curto, scan é trivial.
