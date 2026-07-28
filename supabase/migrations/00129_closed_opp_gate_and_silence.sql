-- 00129_closed_opp_gate_and_silence.sql
--
-- Onda 2 do review Marcia (MC-8 + MC-9, 2026-07-28). Aditiva.
--
-- closed_opp_gate (MC-8): config por agente do gate "negócio fechado → IA para".
--   Shape: {enabled?: bool (default true), terminal_stage_ids?: string[],
--           terminal_pipeline_ids?: string[]}.
--   NULL = gate ativo só por status won/lost/abandoned (universal seguro).
--   Necessário porque contas como a Five Star Ricos fecham por ESTÁGIO
--   (3.119 opps 'open', 0 won/lost) — sem os stage IDs o gate nunca dispara.
--
-- allow_silent_turns (MC-9): opt-in por agente do gate de silêncio no inbound.
--   false (default) = comportamento idêntico ao de hoje (IA responde 100% dos
--   turnos). true = o modelo PODE calar com sinal explícito
--   (should_send_message:false ou [[NAO_ENVIAR]]), com overrides determinísticos
--   fail-open-pra-falar (1º turno e pergunta sempre respondem).
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS closed_opp_gate jsonb,
  ADD COLUMN IF NOT EXISTS allow_silent_turns boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN agent_configs.closed_opp_gate IS
  'MC-8: config do closed-opp gate {enabled, terminal_stage_ids[], terminal_pipeline_ids[]}. NULL = só status won/lost/abandoned.';
COMMENT ON COLUMN agent_configs.allow_silent_turns IS
  'MC-9: opt-in do gate de silêncio no inbound lead-facing. false = IA responde todo turno (comportamento legado).';
