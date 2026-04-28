-- Sparkbot V3 — Carrier Knowledge Base com RAG (pgvector).
--
-- Estrutura cross-tenant (não scope por agent/location) porque conhecimento
-- sobre uma carrier (NLG, Foresters, etc) não muda entre admins. Manter
-- separado de knowledge_base (que é product/empresa-scoped por tenant)
-- evita dupla manutenção.
--
-- pgvector pra similarity search. NLG sozinha gera ~85 chunks de ~2KB.
-- Tier 1 (priority='always') entra inline no prompt do Sparkbot
-- (limite 5KB total — verificado em runtime); Tier 2 (priority='on_demand')
-- só vem via tool call query_carrier_knowledge.
--
-- Idempotente — drop+recreate dos objetos não-críticos seguros.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS carrier_knowledge (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação. (carrier, category, subcategory, slug) é a chave lógica
  -- pro upsert do ingestion script — se admin reroda script com mesmo MD,
  -- precisa atualizar o existente, não duplicar.
  carrier         TEXT NOT NULL,         -- 'national_life_group', 'foresters', etc
  category        TEXT NOT NULL CHECK (category IN (
                    'overview', 'product', 'rider', 'underwriting',
                    'compliance', 'process', 'pitfall', 'resource',
                    'commission', 'workflow'
                  )),
  subcategory     TEXT,                  -- 'iul', 'term', 'foreign_national',
                                         -- 'medical:diabetes', 'state:NY'
  slug            TEXT NOT NULL,         -- kebab-case unique within (carrier,category,subcategory)
  title           TEXT NOT NULL,         -- exibição amigável
  content         TEXT NOT NULL,         -- markdown chunk, idealmente <3KB

  -- Tier de injeção. 'always' = injeta no system prompt sempre (Tier 1, ~5KB total).
  -- 'on_demand' = só vem via tool query_carrier_knowledge (Tier 2, RAG).
  priority        TEXT NOT NULL DEFAULT 'on_demand'
                  CHECK (priority IN ('always', 'on_demand')),

  -- Metadata estruturada (filtros + scoping).
  product_refs    TEXT[],                -- ['flexlife', 'peaklife'] — slugs de produto referenciados
  state_specific  TEXT[],                -- ['NY'] se chunk só vale em estados específicos
  tags            TEXT[],                -- ['libr', '60+', 'income-rider']
  applies_to_companies TEXT[],           -- ['NLIC', 'LSW'] — qual subsidiária

  -- RAG fields.
  embedding       vector(1536),          -- OpenAI text-embedding-3-small
  embedding_model TEXT DEFAULT 'text-embedding-3-small',
  embedded_at     TIMESTAMPTZ,
  content_hash    TEXT NOT NULL,         -- sha256 do content — dedup no upsert

  -- Sourcing & audit.
  source          TEXT NOT NULL DEFAULT 'official'
                  CHECK (source IN ('official', 'imo', 'community', 'synthetic')),
  source_url      TEXT,                  -- link pra documento original (PDF cat, blog post)
  source_doc_cat  TEXT,                  -- '62797(0126)', '104736(0725)' etc — pra rastreabilidade
  last_verified_at TIMESTAMPTZ,          -- quando admin validou pela última vez (chunk freshness)
  verified_by_user_id TEXT,              -- GHL user_id de quem validou
  created_by_user_id TEXT,
  last_modified_by_user_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (carrier, category, subcategory, slug)
);

-- Index pra similarity search. ivfflat é leve (lists=50 ok pra ~85 chunks);
-- migrar pra hnsw quando passar de 5K chunks.
CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_embedding
  ON carrier_knowledge USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- Lookup hot: filtro por carrier + tier (sempre vs on_demand) — usado pelo
-- prompt-builder do Sparkbot na renderização de Tier 1 inline.
CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_carrier_priority
  ON carrier_knowledge(carrier, priority);

CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_carrier_category
  ON carrier_knowledge(carrier, category);

-- Pra synthetic test "qual chunk inclui esse produto?" + admin queries.
CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_product_refs
  ON carrier_knowledge USING GIN (product_refs);

-- RLS — segue padrão do projeto (sales/recruitment + sparkbot tabelas).
-- Acesso só via service_role (admin client) — sem necessidade de policies
-- additivas pra authenticated, porque consumo é server-side.
ALTER TABLE carrier_knowledge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON carrier_knowledge;
CREATE POLICY deny_anon_all ON carrier_knowledge AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- Trigger pra manter updated_at atualizado em UPDATE.
CREATE OR REPLACE FUNCTION update_carrier_knowledge_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_carrier_knowledge_updated_at ON carrier_knowledge;
CREATE TRIGGER trg_carrier_knowledge_updated_at
  BEFORE UPDATE ON carrier_knowledge
  FOR EACH ROW EXECUTE FUNCTION update_carrier_knowledge_updated_at();

COMMENT ON TABLE carrier_knowledge IS
  'Conhecimento estruturado sobre carriers (NLG, Foresters, etc) consumido pelo Sparkbot via tool query_carrier_knowledge. Tier 1 (priority=always, ~5KB total) entra sempre no prompt; Tier 2 (priority=on_demand) vem via RAG. Ingerido por scripts/ingest-carrier-kb.ts a partir de _planning/carriers/{carrier}/**/*.md.';

COMMENT ON COLUMN carrier_knowledge.priority IS
  'always = inline no system prompt SEMPRE (limite 5KB total — verificado runtime). on_demand = só via tool query_carrier_knowledge (RAG sob demanda).';

COMMENT ON COLUMN carrier_knowledge.last_verified_at IS
  'Quando admin abriu o chunk pra validar manualmente. Sparkbot alerta rep se chunk tem >180 dias sem validação (cap rates etc mudam anualmente).';

COMMENT ON COLUMN carrier_knowledge.content_hash IS
  'sha256 do content. Ingestion script pula re-embed se hash igual — economiza tempo e custo OpenAI.';
