-- Marina Lab (2026-08-26): superfície temporária pra Marina Couto testar o agente de
-- pós-atendimento, mandar sugestões e pedir sugestão de resposta a partir de print de
-- conversa real (modo semi-automático — a IA NÃO fala com o lead).
--
-- Separação deliberada: 👍/👎 sobre uma resposta do agente vai pra `agent_feedback`
-- (que o prompt JÁ lê via buildFeedbackSection); esta tabela guarda o resto — recado
-- livre, cenário sugerido e os PARES print→sugestão, que são material de treino.
-- Imagem NÃO é armazenada (PII de terceiros): guardamos só o texto extraído.
CREATE TABLE IF NOT EXISTS marina_lab_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  location_id text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('sugestao', 'print', 'cenario', 'nota')),
  texto text,
  conversa_extraida text,
  resposta_sugerida text,
  rating text CHECK (rating IN ('positive', 'negative')),
  sugestao_dela text,
  imagens_count integer NOT NULL DEFAULT 0,
  session_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marina_lab_agent_created
  ON marina_lab_feedback (agent_id, created_at DESC);

COMMENT ON TABLE marina_lab_feedback IS
  'Marina Lab (temporário, 2026-08): feedback/sugestões da Marina + pares print→sugestão de resposta. Ver _planning/marina-lab/PLANO.md.';
