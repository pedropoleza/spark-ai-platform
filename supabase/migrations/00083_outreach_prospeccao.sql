-- 00083 — Prospecção (agente de lead INICIA conversas) + realinhar bulk
--
-- Review de lógica (Pedro 2026-05-26): "disparo em massa" não é o agente puxando
-- conversa — é ferramenta do SparkBot (rep). O conceito certo no agente de lead é
-- PROSPECÇÃO: ele inicia conversas com uma lista (por tag), no ritmo certo, e
-- depois CONDUZ a conversa (não é broadcast).
--
-- 1) agent_configs.outreach_config (jsonb) — config da prospecção por agente:
--    { enabled, tag_filter:{tags[],match}, rate_per_hour, daily_cap,
--      respect_working_hours, opening_message }
-- 2) catálogo: módulo `outreach` (lead). `bulk` passa a rep (é do SparkBot).
--
-- Aditivo/idempotente. A prospecção nasce DESLIGADA (opt-in) e o disparo real
-- fica atrás de env flag OUTREACH_ENABLED (default OFF) até go-live supervisionado.

BEGIN;

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS outreach_config jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO public.agent_modules (key, name, category, audience_scope, is_seed)
  VALUES ('outreach', 'Prospecção (iniciar conversas)', 'bulk', 'lead', true)
  ON CONFLICT (key, version) DO UPDATE SET name = EXCLUDED.name, audience_scope = EXCLUDED.audience_scope;

-- bulk é ferramenta do SparkBot (rep), não capacidade de agente de lead.
UPDATE public.agent_modules SET audience_scope = 'rep' WHERE key = 'bulk';

COMMIT;
