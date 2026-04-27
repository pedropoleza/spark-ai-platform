-- Sparkbot V2.2 — Documenta assistant_conversations como placeholder V3+.
--
-- Em V2 (modo simulated), ninguém escreve na assistant_conversations: as sessões
-- de teste usam agent_test_sessions/agent_test_messages (mesma stack do sales).
-- A tabela existe pra ter o schema pronto pro V3 (WhatsApp real) — quando
-- ligarmos o webhook GHL, cada rep vai ter 1 row com debounce buffer, pending
-- action, ai_paused state etc.
--
-- Mantida vazia em V2 e sem foreign key cascade impacto (já tem RLS deny_anon).

COMMENT ON TABLE assistant_conversations IS
  'Sparkbot V3+ placeholder. Em V2 (simulated/test) ainda não populamos esta tabela — sessões de teste vivem em agent_test_sessions/messages. Quando V3 ativar (WhatsApp real), esta tabela vira o estado canônico do diálogo rep↔assistente: 1 row por rep com pending_action, debounce buffer, ghl_conversation_id, ai_paused_state. Mantida vazia em V2 pra forma do schema já estar pronta no dia do switch.';

COMMENT ON COLUMN assistant_conversations.pending_action IS
  'Ação confirmatória pendente. Schema: { type: "confirm_action"|"clarify_entity"|"choose_location", tool?, args?, options?, expires_at }. Permite reps responderem "sim/não" sem o LLM precisar replanejar do zero.';

COMMENT ON COLUMN assistant_conversations.pending_messages IS
  'Buffer de rajada (debounce). Quando rep manda 3 áudios em 30s, são empilhados aqui e processados juntos quando debounce_expires_at vence. Evita o LLM responder cada msg isoladamente perdendo contexto.';

COMMENT ON COLUMN assistant_conversations.ai_paused_at IS
  'Quando rep pediu "pausa Sparkbot" (V3+). Bot fica mute por X tempo ou até "volta sparkbot". Em V2 não usado — V2 sempre responde.';
