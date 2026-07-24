-- 00127_entry_by_automation.sql
--
-- Silêncio na entrada quando a conta usa AUTOMAÇÃO pra receber o lead
-- (healthcheck five star ricos 2026-07-23, caso Kayla/Márcia).
--
-- Contexto: a location jA6uzx6tONyTeocxw4Cj tem uma automação (GHL) que, no 1º
-- contato, já manda saudação + áudio explicando o produto + a lista de dados. O
-- agente de vendas respondia a MESMA primeira mensagem do lead (explicando de
-- novo + pedindo os mesmos dados) = duplicação da recepção. Decisão (Pedro +
-- suporte): a automação é dona da entrada; a IA entra só a partir da RESPOSTA
-- real do lead pra concluir (coletar o que falta + agendar).
--
-- Duas colunas aditivas, ambas com default seguro (comportamento idêntico ao de
-- hoje quando a flag está OFF):
--   agent_configs.entry_by_automation  — liga o modo por-agente.
--   conversation_state.entry_suppressed_at — marca que a entrada já foi
--     silenciada, pra a IA assumir a PARTIR da 2ª mensagem do lead (sem esse
--     marcador, todo inbold seria tratado como "entrada" e a IA nunca entraria).

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS entry_by_automation boolean NOT NULL DEFAULT false;

ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS entry_suppressed_at timestamptz;

COMMENT ON COLUMN agent_configs.entry_by_automation IS
  'Quando true, uma automação externa faz a entrada (saudação+áudio+pedido de dados); a IA não responde a 1ª mensagem do lead e nunca cumprimenta/explica. Healthcheck five star ricos 2026-07-23.';
COMMENT ON COLUMN conversation_state.entry_suppressed_at IS
  'Timestamp em que a IA silenciou a entrada (entry_by_automation). Após setado, a IA assume o atendimento a partir da próxima mensagem do lead.';
