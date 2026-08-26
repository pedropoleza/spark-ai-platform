-- ============================================================================
-- Handoff: tira o substantivo solto "pessoa" dos gatilhos e põe as frases
-- inequívocas no lugar.
--
-- MOTIVAÇÃO (review de uso 2026-08-25)
-- `custom_keywords_handoff` era casado com `body.includes(keyword)` e o default
-- seeded trazia a palavra solta "pessoa" — presente em 31 dos 32 agent_configs.
-- Em PT, "pessoa" aparece o tempo todo na fala normal do lead. Resultado medido
-- nas 29 interrupções reais registradas em `handoff_notifications`:
--
--   28 de 29 vieram do gatilho "pessoa" e NENHUMA delas era pedido de humano.
--   Eram respostas de triagem de underwriting ("vivo só com uma pessoa",
--   "moro com um pessoa"), perguntas de produto ("quanto por cento que a
--   pessoa recebe"), textos de anúncio e auto-apresentações.
--
-- Ou seja: a IA parava de responder exatamente quando o lead estava
-- preenchendo a triagem — a hora em que ela mais precisa continuar.
--
-- O QUE MUDA AQUI
-- Troca o alvo solto "pessoa" pelas frases que só aparecem em pedido de humano
-- ("falar com uma pessoa", "pessoa de verdade", "pessoa real"). Os alvos que
-- continuam como palavra solta ("humano", "atendente") são seguros porque
-- ninguém os usa casualmente em conversa de lead.
--
-- O matcher também mudou (src/lib/queue/handoff-intent.ts): entrada com espaço
-- casa por substring; entrada de uma palavra exige intenção de pedido em volta.
-- As duas mudanças são complementares — esta corrige o DADO, aquela o CÓDIGO.
--
-- Idempotente e conservadora: só mexe em array que contém 'pessoa', preserva
-- toda keyword customizada da conta (ex: "falar com a marcia") e não duplica
-- as frases se já estiverem lá.
-- ============================================================================

UPDATE agent_configs
SET handoff_policy = jsonb_set(
  handoff_policy,
  '{custom_keywords_handoff}',
  (
    SELECT COALESCE(jsonb_agg(DISTINCT kw), '[]'::jsonb)
    FROM (
      -- tudo que já existia, MENOS o alvo solto 'pessoa'
      SELECT jsonb_array_elements_text(handoff_policy->'custom_keywords_handoff') AS kw
      UNION
      -- as frases que substituem o alcance legítimo dele
      SELECT unnest(ARRAY[
        'falar com uma pessoa',
        'pessoa de verdade',
        'pessoa real',
        'atendimento humano'
      ])
    ) t
    WHERE lower(btrim(kw)) <> 'pessoa'
  )
)
WHERE handoff_policy ? 'custom_keywords_handoff'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(handoff_policy->'custom_keywords_handoff') AS k(v)
    WHERE lower(btrim(v)) = 'pessoa'
  );
