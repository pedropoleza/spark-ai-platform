-- 00057: Padroniza modelo padrão dos agents pra Claude Sonnet 4.6
-- Pedro 2026-05-05: unificar com SparkBot (que já usa Sonnet primary).
-- User mantém liberdade de mudar via UI (sales/recruitment-config-content
-- têm seletor AI_MODELS); só estamos mudando o DEFAULT pra novos agents
-- e migrando os existentes em modelos OpenAI pra Sonnet (qualidade > custo).
--
-- Justificativa:
-- - Stress tests anteriores mostraram Sonnet seguindo prompt MUITO melhor
--   que GPT (review 2026-04-28: 6 de 7 falhas em GPT, 0 em Claude).
-- - SparkBot já roda Sonnet em prod sem problemas.
-- - Custo: Sonnet $3/$15 vs gpt-4o $2.5/$10 (delta marginal pra qualidade
--   muito maior). Pedro priorizou qualidade > custo aqui.
-- - Fallback Haiku mantido pra anti-quota outage (já era default).

-- 1. Default da coluna pra novos agents
ALTER TABLE agent_configs ALTER COLUMN ai_model SET DEFAULT 'claude-sonnet-4-6';

-- 2. Migrar agents sales/recruitment ATIVOS que estão em modelos OpenAI
-- pra Sonnet. Mantém quem já está em claude-* (não toca recruitment_agent
-- que escolheu claude-sonnet-4-6 explicitamente).
-- account_assistant não é tocado (já usa Sonnet via ENV var STRICT_CLAUDE_ONLY).
-- Inactive agents também não — se reativarem, admin revisa config primeiro.
UPDATE agent_configs ac
SET ai_model = 'claude-sonnet-4-6'
FROM agents a
WHERE ac.agent_id = a.id
  AND a.type IN ('sales_agent', 'recruitment_agent')
  AND a.status = 'active'
  AND ac.ai_model NOT LIKE 'claude-%';

-- 3. Garante fallback é Haiku (anti-quota outage). Já é default mas vai
-- que algum agent tem NULL (ex: criado antes da coluna fallback_model existir).
UPDATE agent_configs ac
SET fallback_model = 'claude-haiku-4-5-20251001'
FROM agents a
WHERE ac.agent_id = a.id
  AND a.type IN ('sales_agent', 'recruitment_agent')
  AND ac.fallback_model IS NULL;
