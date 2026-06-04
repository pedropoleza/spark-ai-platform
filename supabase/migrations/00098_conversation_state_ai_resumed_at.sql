-- GU-6 (Pedro 2026-06-04): override "passa a bola pra IA".
--
-- Quando o rep LIGA manualmente o agente (pill na UI do GHL) numa conversa onde
-- um humano respondeu por último, a IA deve assumir mesmo assim ("passa a bola
-- pra IA"). ai_resumed_at marca o instante do "ligar manual"; o gate de
-- auto-pause-on-human (F52, queue-processor) só RE-PAUSA se a resposta humana for
-- MAIS RECENTE que ai_resumed_at — senão o rep já passou a bola depois daquele
-- humano e a IA deve continuar.
--
-- Aditivo. Aplicado via MCP em prod; arquivo pra fresh staging branches.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS ai_resumed_at timestamptz;

COMMENT ON COLUMN conversation_state.ai_resumed_at IS
  'GU-6: instante do "ligar manual" pela UI do GHL. F52 (auto-pause-on-human) ignora respostas humanas anteriores a este timestamp — o rep passou a bola pra IA.';
