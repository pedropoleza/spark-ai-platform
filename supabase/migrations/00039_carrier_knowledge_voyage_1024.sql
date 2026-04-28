-- Migra carrier_knowledge embedding de 1536 (OpenAI text-embedding-3-small)
-- pra 1024 (Voyage AI voyage-3-large).
--
-- Razão: OpenAI billing zerou. Voyage AI tem free tier generoso (200M tokens),
-- qualidade superior em multilingual benchmarks (especialmente PT-BR), e
-- contrato/SLA mais previsível pra workload steady-state.
--
-- Estratégia:
--   1. DROP index ivfflat (vinculado a vector(1536))
--   2. ALTER COLUMN embedding TYPE vector(1024) USING NULL — apaga embeddings,
--      será re-populado via npm run ingest-kb -- --force-embed
--   3. Recreate index com nova dim
--   4. Atualiza embedding_model default
--
-- Não-destrutivo pros chunks: só limpa embeddings; conteúdo (content_hash,
-- title, metadata) continua. Re-embed é idempotente via content_hash.

-- 1. Drop index dependente da column type
DROP INDEX IF EXISTS idx_carrier_knowledge_embedding;

-- 2. Altera coluna pra 1024 dims. Apaga dados existentes (vão ser
-- re-embedded via Voyage no ingest --force-embed).
ALTER TABLE carrier_knowledge
  ALTER COLUMN embedding TYPE vector(1024) USING NULL;

-- Limpa flags de embedding pra forçar re-embed em ingest seguinte
UPDATE carrier_knowledge SET embedded_at = NULL;

-- 3. Recreate index com mesma config (ivfflat lists=50)
CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_embedding
  ON carrier_knowledge USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- 4. Atualiza default do model column
ALTER TABLE carrier_knowledge
  ALTER COLUMN embedding_model SET DEFAULT 'voyage-3-large';

COMMENT ON COLUMN carrier_knowledge.embedding IS
  'Voyage AI voyage-3-large (1024 dims). Migrado de OpenAI text-embedding-3-small (1536) em 04/2026 por OpenAI quota issues.';

-- 5. Recreate search function pra aceitar vector(1024)
CREATE OR REPLACE FUNCTION search_carrier_knowledge(
  p_query_embedding vector(1024),
  p_carrier TEXT DEFAULT 'national_life_group',
  p_category TEXT DEFAULT NULL,
  p_state TEXT DEFAULT NULL,
  p_top_k INT DEFAULT 5,
  p_min_similarity FLOAT DEFAULT 0.4
)
RETURNS TABLE (
  id UUID,
  category TEXT,
  subcategory TEXT,
  title TEXT,
  content TEXT,
  similarity FLOAT,
  source_doc_cat TEXT,
  last_verified_at TIMESTAMPTZ,
  state_specific TEXT[],
  tags TEXT[]
)
LANGUAGE sql STABLE
AS $$
  SELECT
    ck.id,
    ck.category,
    ck.subcategory,
    ck.title,
    ck.content,
    1 - (ck.embedding <=> p_query_embedding) AS similarity,
    ck.source_doc_cat,
    ck.last_verified_at,
    ck.state_specific,
    ck.tags
  FROM carrier_knowledge ck
  WHERE ck.carrier = p_carrier
    AND ck.embedding IS NOT NULL
    AND (p_category IS NULL OR ck.category = p_category)
    AND (
      p_state IS NULL
      OR ck.state_specific IS NULL
      OR p_state = ANY(ck.state_specific)
    )
    AND (1 - (ck.embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY ck.embedding <=> p_query_embedding ASC
  LIMIT p_top_k;
$$;

GRANT EXECUTE ON FUNCTION search_carrier_knowledge(
  vector(1024), TEXT, TEXT, TEXT, INT, FLOAT
) TO authenticated, service_role;

COMMENT ON FUNCTION search_carrier_knowledge IS
  'Similarity search via Voyage AI voyage-3-large embeddings (1024 dims). Threshold 0.4 anti-alucinação.';
