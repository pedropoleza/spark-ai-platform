-- 00125_proactive_pause_source.sql
--
-- H52 review adversarial (2026-07-17): a pausa de proativos setada pelo
-- loop-guard (bot-a-bot, caso Fabiana) era APAGADA pelo silence-reset de
-- qualquer inbound — e o rep-fantasma sempre "responde", então o loop
-- re-acendia todo dia. Esta coluna registra a ORIGEM da pausa:
--   NULL         → pausa do silence-gate (comportamento antigo; inbound limpa)
--   'loop_guard' → pausa do detector bot-a-bot (inbound NÃO limpa; só admin)
ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS proactive_pause_source text;

COMMENT ON COLUMN rep_identities.proactive_pause_source IS
  'Origem de proactive_paused_at: NULL=silence-gate (inbound limpa), loop_guard=detector bot-a-bot (persistente; limpar via admin). Ver loop-guard.ts';
