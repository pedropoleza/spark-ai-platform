-- Rolling summarization de histórico longo.
-- Quando a conversa passa de N turns, as mensagens antigas são condensadas
-- num resumo breve cacheado aqui. Só regera quando novos turns são absorvidos
-- pelo summary window.
ALTER TABLE conversation_state
  ADD COLUMN IF NOT EXISTS history_summary TEXT,
  ADD COLUMN IF NOT EXISTS history_summary_covers_count INTEGER DEFAULT 0;
