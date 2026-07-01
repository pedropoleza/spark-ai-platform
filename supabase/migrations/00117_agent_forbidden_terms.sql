-- 00117_agent_forbidden_terms.sql
--
-- Caso Marina Couto (áudio da cliente 2026-07-01): TOLERÂNCIA ZERO a citar o nome
-- da seguradora ("National Life"/"National Life Group"/"Five Rings") ou "empresa
-- com X anos de mercado" na saída lead-facing — implicaria que a agência trabalha
-- PARA a seguradora (risco de compliance). O ban no prompt reduziu ~99% mas o LLM
-- ainda vazava ~0.3%; a cliente pediu explicitamente uma "palavra proibida"
-- (garantia determinística). O sanitizador `src/lib/ai/outbound-sanitizer.ts` roda
-- no último passo antes de enviar/logar e redige cirurgicamente.
--
-- Esta coluna é a fonte config-driven (por agente). ENQUANTO não aplicada em prod,
-- o code-map `FORBIDDEN_BY_AGENT` no sanitizador é a fonte viva (mesmo padrão do
-- meeting-links.ts). `resolveForbiddenTerms()` dá precedência ao valor do DB.
-- Aplicar via MCP em prod e popular a Marina:
--   UPDATE agent_configs SET forbidden_terms =
--     '["National Life Group","National Life","Five Rings Financial","Five Rings"]'::jsonb
--   WHERE agent_id = '3976b4b6-0345-4f25-b964-138bb7960058';

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS forbidden_terms jsonb NOT NULL DEFAULT '[]'::jsonb;
