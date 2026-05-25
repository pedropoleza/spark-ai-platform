-- ============================================================================
-- 00079_drop_dead_last_channel.sql — remove coluna morta (Pedro 2026-05-25).
--
-- conversation_state.last_channel tinha default 'SMS' e NADA no código lê ou
-- escreve nela (confirmado por grep em src/). Mostrava "SMS" de forma enganosa
-- até em conversas de IG. O canal REAL da resposta é derivado por-mensagem em
-- channelToMessageType(ctx.channel) — não vem daqui. Dropar limpa a confusão.
-- Reversível: re-adicionar com população correta se um dia for útil.
-- ============================================================================
ALTER TABLE conversation_state DROP COLUMN IF EXISTS last_channel;
