-- 00123_activation_mode.sql
-- H51 (Pedro 2026-07-16) — Modelo de Ativação V2: separa GATILHO de ativação
-- de GATE contínuo. Ver _planning/activation-model-v2/PLANO.md.
--
-- Motivação: o targeting (`agent_configs.targeting_rules`) era SEMPRE re-checado
-- a cada mensagem (gate contínuo). Pra ativação por tag/mensagem isso quebra:
--   - tag adicionada por automação → corrida (webhook lê o contato antes da tag);
--   - remover a tag no meio da conversa → IA emudece silenciosamente (D3);
--   - ativação por conteúdo de mensagem → follow-up (corpo ≠ gatilho) dropava.
-- `trigger_once` faz o targeting valer só no 1º contato; depois o dono é o
-- membership (conversation_state) até pausa/handoff. Default `gate_ongoing`
-- preserva o comportamento legado (zero regressão pros agentes existentes).
--
-- Aditivo/reversível: coluna nullable com default. NULL/'gate_ongoing' = legado.

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS activation_mode text NOT NULL DEFAULT 'gate_ongoing';

-- Trava os valores válidos (defesa; a app só escreve os dois).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_configs_activation_mode_chk'
  ) THEN
    ALTER TABLE agent_configs
      ADD CONSTRAINT agent_configs_activation_mode_chk
      CHECK (activation_mode IN ('gate_ongoing', 'trigger_once'));
  END IF;
END $$;

COMMENT ON COLUMN agent_configs.activation_mode IS
  'H51: gate_ongoing (default/legado, re-checa targeting todo turno) | trigger_once (targeting só ativa no 1º contato; depois o dono é o membership).';
