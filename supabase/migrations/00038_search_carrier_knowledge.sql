-- Sparkbot V3 — Função SQL pra similarity search com filtros estruturados.
--
-- Encapsula a query pra tool query_carrier_knowledge no Sparkbot não ter
-- que montar SQL com vector ops. Idêntico em padrão à função
-- try_claim_dispatch_slot da migration 00033 (também SQL function pra
-- centralizar lógica fora do client TS).
--
-- Filtros:
--   p_carrier — sempre obrigatório, default 'national_life_group'
--   p_category — opcional, restringe a uma categoria
--   p_state — se fornecido, inclui chunks state_specific=NULL OU contém o estado
--   p_min_similarity — chunks abaixo disso NÃO retornam (anti-alucinação)
--
-- Idempotente — CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION search_carrier_knowledge(
  p_query_embedding vector(1536),
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
      -- Sem filtro de estado: passa tudo.
      p_state IS NULL
      -- Filtro de estado: chunk vale em todos os estados (state_specific NULL)
      -- OU vale especificamente no estado consultado.
      OR ck.state_specific IS NULL
      OR p_state = ANY(ck.state_specific)
    )
    AND (1 - (ck.embedding <=> p_query_embedding)) >= p_min_similarity
  ORDER BY ck.embedding <=> p_query_embedding ASC
  LIMIT p_top_k;
$$;

GRANT EXECUTE ON FUNCTION search_carrier_knowledge(
  vector(1536), TEXT, TEXT, TEXT, INT, FLOAT
) TO authenticated, service_role;

COMMENT ON FUNCTION search_carrier_knowledge IS
  'Similarity search com filtros estruturados pra Sparkbot. Threshold p_min_similarity (default 0.6) é gate anti-alucinação — abaixo disso, chunk não retorna e LLM tem que dizer "sem info".';
