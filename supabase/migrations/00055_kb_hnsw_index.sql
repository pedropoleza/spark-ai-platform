-- =============================================
-- 00055_kb_hnsw_index
--
-- Pedro 2026-05-05 (ULTRA-REVIEW Track 9 #5): migra ivfflat lists=50 → HNSW.
-- ivfflat foi dimensionado pra ~85 chunks (NLG only). Após Brazillionaires
-- (+86) e próximas waves, ivfflat fica sub-ótimo. HNSW é mais robusto pra
-- growth e tem latência mais previsível.
--
-- m=16 (default), ef_construction=64. Volume baixo (~170 chunks) permite
-- migração em <5s sem downtime perceptível. Aplicada em prod via MCP.
-- =============================================

DROP INDEX IF EXISTS idx_carrier_knowledge_embedding;

CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_embedding_hnsw
  ON carrier_knowledge USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ANALYZE carrier_knowledge;
