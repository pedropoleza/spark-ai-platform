-- 00082 — Permitir MÚLTIPLOS agentes custom por location (Pedro 2026-05-25)
--
-- Motivação: o builder com IA (Plataforma Modular Fase 3/F) cria agentes
-- "personalizados" (eventos, feirões, nichos, temporários). Uma agência pode
-- querer mais de um ao mesmo tempo (ex.: "Feirão Petrópolis" + "Expo Auto").
-- O UNIQUE(location_id, type) original travava o 2º custom_agent (23505).
--
-- Solução: troca o UNIQUE por um índice único PARCIAL que mantém a regra
-- "1 por tipo" pros não-custom (account_assistant/sales_agent/recruitment_agent
-- — faz sentido ter só 1 de cada por location) mas LIBERA N custom_agent.
--
-- Seguro/aditivo: como o constraint antigo impedia duplicatas, não existem
-- linhas que violem o índice parcial novo. Idempotente.

BEGIN;

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_location_id_type_key;

CREATE UNIQUE INDEX IF NOT EXISTS agents_location_type_noncustom_uniq
  ON public.agents (location_id, type)
  WHERE type <> 'custom_agent';

COMMIT;
