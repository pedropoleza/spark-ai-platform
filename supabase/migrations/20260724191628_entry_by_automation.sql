-- 20260724191628_entry_by_automation.sql
--
-- RECUPERADA DO LEDGER em 2026-08-06, não reescrita à mão. Esta migration foi
-- aplicada em produção em 2026-07-24 e o arquivo nunca chegou ao repo — o mesmo
-- vazamento que a auditoria do H70 mapeou (`_planning/auditoria-trabalho-perdido-2026-08-05.md`).
--
-- O SQL abaixo é VERBATIM o que rodou: veio de
-- `supabase_migrations.schema_migrations.statements` do projeto de produção, a
-- coluna onde o Supabase guarda o texto executado. Nada foi inferido a partir do
-- schema atual, então um staging novo reproduz prod na ordem certa.
--
-- Nome em TIMESTAMP porque é a `version` que já está no ledger de produção:
-- mudar o nome faria o `db push` tentar reaplicar. Não editar este arquivo —
-- correção vira migration NOVA.
--
-- `agent_configs.entry_by_automation` + `conversation_state.entry_suppressed_at`
-- — quando uma automação externa faz a entrada (saudação/áudio/pedido de dados),
-- a IA cala na 1ª mensagem do lead e assume da segunda em diante. Saiu do
-- healthcheck da Five Star Ricos em 2026-07-23.

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS entry_by_automation boolean NOT NULL DEFAULT false;

ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS entry_suppressed_at timestamptz;

COMMENT ON COLUMN agent_configs.entry_by_automation IS
  'Quando true, uma automação externa faz a entrada (saudação+áudio+pedido de dados); a IA não responde a 1ª mensagem do lead e nunca cumprimenta/explica. Healthcheck five star ricos 2026-07-23.';
COMMENT ON COLUMN conversation_state.entry_suppressed_at IS
  'Timestamp em que a IA silenciou a entrada (entry_by_automation). Após setado, a IA assume o atendimento a partir da próxima mensagem do lead.';
