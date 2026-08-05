-- 00119 — rep_notes: memória/nota PESSOAL do rep (segundo cérebro)
--
-- Motivação (plano "SparkBot Assistente Humano", F1, 2026-07-01):
-- Hoje TODA nota do SparkBot é presa a um contato (tools/notes.ts exige
-- contact_id). Não há onde o rep guardar um pensamento/to-do/ideia sobre SI
-- MESMO ("lembra que tenho que ligar pro contador", "ideia pra campanha X").
-- O rep já usa o bot como caderno (Luana pediu "me lembra de tudo que anotei"
-- e o bot reconstruiu DA CONVERSA — some quando a janela rola). Esta tabela dá
-- o "lugar" persistente, desacoplado de contato, com busca semântica.
--
-- SEGURANÇA / LGPD (decisão D1 do Pedro, 2026-07-01):
--   - Dado SENSÍVEL (seguros + LGPD; o projeto já teve vazamento de token).
--   - Retenção: 12 meses. O rep pode APAGAR (soft-delete via deleted_at); a
--     função purge_old_rep_notes() faz o hard-delete (soft-deleted antigas +
--     ativas > 12 meses). Aviso discreto no 1º uso fica na camada de tool/prompt.
--   - Isolamento por-rep: acesso é SEMPRE server-side (admin client / service_role)
--     e a tool trava o rep_id (padrão anti-IDOR do H41). Reps NÃO têm auth
--     Supabase (são identificados por telefone) → não há RLS por auth.uid();
--     a RPC de busca EXIGE p_rep_id e filtra por ele.
--
-- Reusa a stack do carrier-kb: pgvector + Voyage voyage-3-large (1024d), cosine.
-- Tudo atrás da flag REP_NOTES_ENABLED na camada de tools — o schema é inerte
-- até as tools serem registradas.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rep_notes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id            UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,

  body              TEXT NOT NULL,                 -- o texto da nota (do rep)
  tags              TEXT[] DEFAULT '{}',           -- categorização opcional
  linked_contact_id TEXT,                          -- opcional: nota tem a ver com um contato do Spark Leads

  source            TEXT NOT NULL DEFAULT 'chat'
                    CHECK (source IN ('chat', 'proactive', 'consolidation')),

  -- RAG (mesmo modelo/dim do carrier-kb pra reusar infra)
  embedding         vector(1024),
  embedding_model   TEXT DEFAULT 'voyage-3-large',
  embedded_at       TIMESTAMPTZ,

  -- lifecycle / LGPD
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ                     -- soft-delete (rep apaga); purge >12m por cron
);

-- Hot path: listar notas recentes de um rep (exclui apagadas).
CREATE INDEX IF NOT EXISTS idx_rep_notes_rep_recent
  ON rep_notes(rep_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Similarity search por embedding (ivfflat cosine, igual carrier-kb).
CREATE INDEX IF NOT EXISTS idx_rep_notes_embedding
  ON rep_notes USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- RLS — mesmo padrão das tabelas do SparkBot: nega anon, consumo só server-side.
ALTER TABLE rep_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON rep_notes;
CREATE POLICY deny_anon_all ON rep_notes AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- updated_at automático.
CREATE OR REPLACE FUNCTION update_rep_notes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rep_notes_updated_at ON rep_notes;
CREATE TRIGGER trg_rep_notes_updated_at
  BEFORE UPDATE ON rep_notes
  FOR EACH ROW EXECUTE FUNCTION update_rep_notes_updated_at();

-- Busca semântica SCOPED por rep (anti-IDOR: exige p_rep_id e filtra por ele).
-- Threshold 0.3 (mais baixo que o 0.4 do carrier-kb): notas são curtas/variadas.
CREATE OR REPLACE FUNCTION search_rep_notes(
  p_rep_id UUID,
  p_query_embedding vector(1024),
  p_top_k INT DEFAULT 5,
  p_min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  body TEXT,
  tags TEXT[],
  linked_contact_id TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    rn.id,
    rn.body,
    rn.tags,
    rn.linked_contact_id,
    rn.created_at,
    1 - (rn.embedding <=> p_query_embedding) AS similarity
  FROM rep_notes rn
  WHERE rn.rep_id = p_rep_id
    AND rn.deleted_at IS NULL
    AND rn.embedding IS NOT NULL
    AND (1 - (rn.embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY rn.embedding <=> p_query_embedding ASC
  LIMIT p_top_k;
$$;

GRANT EXECUTE ON FUNCTION search_rep_notes(UUID, vector(1024), INT, FLOAT)
  TO service_role;

-- Retenção 12 meses (D1). Hard-delete: (a) soft-deletadas há > 30 dias e
-- (b) ativas há > 12 meses. Idempotente; será plugada no cleanup-cron (00034).
CREATE OR REPLACE FUNCTION purge_old_rep_notes()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER;
BEGIN
  WITH del AS (
    DELETE FROM rep_notes
    WHERE (deleted_at IS NOT NULL AND deleted_at < now() - INTERVAL '30 days')
       OR (created_at < now() - INTERVAL '12 months')
    RETURNING 1
  )
  SELECT count(*) INTO n FROM del;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE rep_notes IS
  'F1 (assistente-humano): nota/memória PESSOAL do rep, desacoplada de contato. Busca semântica via Voyage 1024d. Sensível/LGPD: retenção 12m (purge_old_rep_notes), soft-delete via deleted_at, isolamento por-rep no código (anti-IDOR). Consumo só server-side. Gated por REP_NOTES_ENABLED na camada de tools.';
