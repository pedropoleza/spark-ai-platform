-- 00084 — adiciona agent_configs.conversation_examples (drift)
--
-- Bug observado em prod 2026-05-26: salvar config no /hub falha com
-- "Could not find the 'conversation_examples' column of 'agent_configs'".
-- O tipo (types/agent.ts), o schema do PUT (validation.ts) e o sales-prompt-builder
-- já referenciam `conversation_examples`, mas a COLUNA nunca foi criada — drift.
-- Aditivo, idempotente.

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS conversation_examples text NOT NULL DEFAULT '';
