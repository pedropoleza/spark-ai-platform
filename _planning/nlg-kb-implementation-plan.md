# NLG Knowledge Base — Plano de Implementação

> **Data:** 2026-04-28
> **Versão:** V2 (final — pós-extração dos PDFs oficiais)
> **Conteúdo bruto:** [`_planning/carriers/nlg/raw/`](./carriers/nlg/raw/) (6 PDFs extraídos)
> **Foco MVP:** Sparkbot (copiloto do rep) consulta KB da NLG via tool RAG. Sales agent só recebe a infra; cotação para lead vira fase 4.

---

## 0. TL;DR

A KB hoje é texto inline no prompt (cap 12KB, hard limit 50KB upload, sem RAG). Sparkbot **não consome KB** — só sales/recruitment. Material oficial NLG extraído dos PDFs gera **~210KB** de conteúdo estruturado: não cabe inline.

**Solução adotada:** arquitetura híbrida em **`carrier_knowledge`** nova tabela com **pgvector** (extension já disponível no Supabase, não habilitada).

- **Tier 1 — Carrier overview** (~5KB sempre injetado): produtos top, NLIC vs LSW, ratings — garante que Sparkbot sempre "sabe" o que é a NLG
- **Tier 2 — RAG chunks** (~85 chunks de ~2KB cada): produtos individuais, riders, classes UW, build chart, condições médicas, foreign national tiers, processo eApp/iGo, compliance, pitfalls. Buscados por similarity quando o rep faz pergunta específica.

**Tool nova:** `query_carrier_knowledge(question, carrier?, category_hint?, top_k?)` — Sparkbot invoca quando query é técnica de carrier.

**Cotação:** **Tier A** (ballpark heurística pública) entra como tool separada **`estimate_premium_ballpark`** na fase 4 — não bloqueia MVP.

**Calibração de incerteza (regra central — seção 7.5):** Sparkbot NUNCA inventa info sobre NLG. 4 estados explícitos de resposta (CONFIRMADO / DESATUALIZADO / INFERIDO / SEM INFO) com formatação distinta. 6 salvaguardas estruturais no código (similarity threshold, `last_verified_at` injetado, tag `[unverified]`, source citation, state mismatch detection, cotação com disclaimer obrigatório). 4 adversarial tests gateando fase 4. Princípio: "se forçado a escolher entre prestativo e honesto, escolhe honesto".

**Effort:** Fase 1-3 (MVP funcional) = **22-30h dev** + **10-15h** Pedro autorando chunks. Fase 4 (cotação) = +6h. Fase 5 (UI polish) = +8h.

---

## 1. Estado atual da KB

### 1.1 Recap arquitetural

```
┌────────────────────────────────┐
│ knowledge_base (00017)         │
│  - id, agent_id, location_id   │
│  - title, content (TEXT bruto) │
│  - type, token_count           │
│  - SEM embedding               │
└────────────┬───────────────────┘
             │ select * by agent_id
             ▼
┌────────────────────────────────┐
│ src/lib/ai/prompt-builder.ts   │
│  buildKnowledgeBaseSection()   │
│   ├── GLOBAL_CAP = 12KB        │
│   ├── render inline            │
│   └── truncate silencioso ▲    │
└────────────┬───────────────────┘
             ▼
       Sales/Recruitment LLM
```

**Sparkbot path** (`src/lib/account-assistant/prompt-builder.ts`): nunca lê `knowledge_base`. Vai precisar de modificação cirúrgica para consumir KB de carrier sem inflar prompt.

### 1.2 Limitações que bloqueiam NLG

| Limitação | Impacto na NLG |
|---|---|
| Cap de 12KB inline | Volume real NLG (~210KB) excede 17× |
| Sem RAG / similarity | Toda KB compete por espaço no prompt; queries específicas não filtram |
| Sparkbot não usa KB | Necessário estender o prompt-builder do account-assistant |
| Tabela é tenant-scoped (agent_id) | Carrier knowledge é cross-tenant — informação sobre NLG não muda entre Pedro e outro admin |
| Truncate silencioso (linha 734) | Pedro não fica sabendo se chunk caiu fora do prompt |

---

## 2. Inventário das fontes oficiais NLG

Pedro forneceu 6 PDFs em `~/Downloads/NGL/`. Extraídos para `_planning/carriers/nlg/raw/`:

| Cat # | Arquivo | Conteúdo | Linhas | Categoria KB |
|---|---|---|---|---|
| **62797(0126)** | UW Guide | **Documento principal**: insurance basics, financial UW, EZ Underwriting, RapidProtect, todos produtos (Summit/Peak/Flex/Basic/Total/Survivor/Term), rate classes, build chart (permanent + term), uninsurable risks, medical condition→action table, advanced sales, foreign national, approved countries A/B, after-issue changes | 2310 | UW + produtos + FN |
| **104736(0725)** | Internal Exchange Rules / Commission | 1035 commissions, surrender charge waiver, term→perm conversion rules, age-tiered commission rates | 101 | Commission + replacement |
| **53732(0225)** | Annuity Commission General Terms | Trail vs first-year, advance commission, chargeback timeframes por produto (Zenith/Growth Driver/Income Driver/FIT/RetireMax) | 132 | Commission annuity |
| **103418(1225)** | FN Tax Planning (Eng) | Resident vs Non-resident alien, Substantial Presence Test, gift/estate tax for non-citizens, US connections framework | 316 | FN tax compliance |
| **103571(0226)** | FN Tax Planning (Espanhol) | Versão em ES do 103418 — material para cliente, não para autoring | 357 | (Não ingerido — duplicate) |
| **50038** | FN Questionnaire Form | Form fillable: identification, US property, US connections, intent to reside, documentation | 82 | FN form reference |

**Não temos ainda** (Pedro confirmou que vai providenciar quando possível):
- Cap Rate Update 2026 (cap rates atuais por strategy/produto/estado)
- Producer Guide / Field Marketing Guide (sem catalog # confirmado, gated)
- Commission Schedule específico do nível contratual (GAF_8175 ou atual)

### 2.1 Volume real estimado por categoria

| Categoria | Chunks | Volume autorado | Source primária |
|---|---|---|---|
| Carrier overview | 1 | 2KB | research + 62797 |
| Produtos IUL | 5 (FlexLife II, PeakLife, SummitLife, SurvivorLife, RapidProtect) | 30KB | 62797 §21-25 |
| Produtos WL/UL | 3 (TotalSecure, BasicSecure + variantes NL) | 8KB | 62797 §24 + research |
| Produtos Term | 1 (Term LSW + Term NL Life) | 4KB | 62797 §26 |
| Annuity products | 6 (FIT Secure Growth, FIT Select Income, Zenith Growth/Income, Growth/Income Driver, RetireMax) | 18KB | 53732 + research |
| Riders | 12 (ABR set, LIBR, Alzheimer, Fertility, Overloan, Estate Preservation, Children's Term, etc) | 24KB | 62797 §rider section |
| Crediting strategies | 7 (S&P 500 P2P Cap, Participation, MSCI EAFE, Balanced Trend, US Pacesetter, Systematic, Basic) | 12KB | research + cap update (pending) |
| **UW: rate classes** | 1 (Elite/Preferred/Select/Standard/Tobacco/Express com criteria) | 6KB | 62797 §17-31 |
| **UW: build chart** | 1 (height-weight tables permanent + term) | 5KB | 62797 §32-33 |
| **UW: EZ Underwriting** | 1 (ages 18-50/$3M, 51-60/$1M, 61-65/$250K rules) | 4KB | 62797 §18 |
| **UW: RapidProtect simplified** | 1 (no exam, instant decision rules) | 3KB | 62797 §19 |
| **UW: medical conditions** | 15 (diabetes, hypertension, cardiac, cancer, mental health, sleep apnea, etc) | 22KB | 62797 §35 + §42 |
| **UW: financial** | 2 (income multiples by age, business insurance, IOLI/STOLI, bankruptcy) | 8KB | 62797 §12-15 |
| **UW: foreign national** | 4 (rules, country tier A, country tier B, premium financing) | 14KB | 62797 §36-39 + 50038 + 103418 |
| **UW: uninsurable risks** | 1 | 3KB | 62797 §34 |
| **Process: eApp/iGo/Resonant** | 2 | 8KB | research |
| **Process: replacement & 1035** | 2 (Internal Exchange rules, surrender waivers, commission timing) | 7KB | 104736 |
| **Compliance: state-specific** | 4 (NY Reg 187, NAIC Reg 275, CA, MN) | 8KB | research |
| **Compliance: illustration regs** | 1 (US Pacesetter caveat, hypothetical/backtested rules) | 4KB | research + lawsuit context |
| **Pitfalls** | 14 (US Pacesetter lawsuit, target premium, NY/LSW, 60+ physical, etc) | 8KB | research |
| **Sales workflow** | 1 (lead→qualifier→illustration→eApp→UW→delivery) | 4KB | research |
| **Resources** | 1 (ForeSight, NLG Agents app, training, NLGroupU) | 3KB | research |
| **TOTAL** | **~85 chunks** | **~210KB** | — |

> Granularidade: cada chunk é independente, ~1-3KB, 200-500 tokens. Embedding `text-embedding-3-small` (1536 dims) por chunk. Custo total embedding: ~$0.001 (52K tokens × $0.020/1M).

---

## 3. Arquitetura

### 3.1 Fluxo end-to-end

```
┌─────────────────────────────────┐
│ Pedro autora MD em             │
│ _planning/carriers/nlg/{cat}/  │
│   *.md (frontmatter + corpo)   │
└─────────────────┬───────────────┘
                  │ npm run ingest-kb
                  ▼
┌─────────────────────────────────┐
│ scripts/ingest-carrier-kb.ts   │
│  1. walk MD files              │
│  2. parse frontmatter           │
│  3. compute content hash        │
│  4. dedup vs DB                 │
│  5. embed via OpenAI            │
│  6. UPSERT carrier_knowledge    │
└─────────────────┬───────────────┘
                  ▼
┌─────────────────────────────────┐
│ carrier_knowledge (00037)       │
│   ├── pgvector embedding        │
│   └── ivfflat index             │
└─────────────────┬───────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐  ┌─────────────────┐
│ Sparkbot      │  │ Sales agent     │
│ prompt-builder│  │ (fase 4 opt)    │
│ + Tier 1 inline│  │                 │
│ + tool        │  │                 │
│ query_carrier │  │                 │
│ _knowledge    │  │                 │
└───────────────┘  └─────────────────┘
```

### 3.2 Decisões e trade-offs

| Decisão | Opção escolhida | Por quê |
|---|---|---|
| Storage | Tabela nova `carrier_knowledge` (cross-tenant) | KB carrier não muda entre tenants. Manter separado de `knowledge_base` evita dupla manutenção. |
| Embedding | OpenAI `text-embedding-3-small` (1536 dim) | Custo ~$0.001 pra NLG inteira. Mais barato que `large` (3072 dim) com perda accuracy <2% no domínio. |
| Vector index | pgvector ivfflat com `lists=50` | Volume baixo (~85 chunks). hnsw seria overkill; trocar quando passar de 5K chunks. |
| Tier 1 vs Tier 2 | Híbrida (5KB sempre + RAG sob demanda) | Garante que bot nunca diz "não sei nada da NLG"; mas não infla prompt em queries irrelevantes. |
| Authoring | Markdown em `_planning/carriers/{carrier}/` versionado no git | Pedro edita em editor de escolha; reviews via PR; histórico via git blame. UI dedicada vira fase 5. |
| Ingestion | CLI script (`npm run ingest-kb`) | Sem UI dependency. Idempotente (content hash = upsert by hash). Pode virar webhook depois. |
| Multi-carrier | Schema desde o início | Schema custa zero adicional; quando vier Foresters/Penn/Allianz, é só seedar. |
| Sparkbot integration | Tool explícita + Tier 1 inline | LLM decide quando puxar (tool call) ou usa overview (sempre). Evita inflar todas as queries. |
| Cotação | Tool separada (`estimate_premium_ballpark`) na fase 4 | Não bloqueia MVP da KB. Heurística clean room (não usa NLG proprietary). |

---

## 4. Database schema

### 4.1 Migration `00037_carrier_knowledge.sql`

> Estilo: igual ao padrão do projeto (00029-00036). Comentários em PT-BR explicando "porquês". Idempotente. RLS deny_anon. Audit columns.

```sql
-- Sparkbot V3 — Carrier Knowledge Base com RAG.
--
-- Estrutura cross-tenant (não scope por agent/location) porque conhecimento
-- sobre uma carrier (NLG, Foresters, etc) não muda entre admins. Manter
-- separado de knowledge_base (que é product/empresa-scoped por tenant)
-- evita dupla manutenção.
--
-- pgvector pra similarity search. NLG sozinha gera ~85 chunks de ~2KB.
-- Tier 1 (priority='always') entra inline no prompt; Tier 2 (priority='on_demand')
-- só vem via tool call do Sparkbot.

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

  -- Metadata estruturada (filtros + scoping)
  product_refs    TEXT[],                -- ['flexlife', 'peaklife'] — slugs de produto referenciados
  state_specific  TEXT[],                -- ['NY'] se chunk só vale em estados específicos
  tags            TEXT[],                -- ['libr', '60+', 'income-rider']
  applies_to_companies TEXT[],           -- ['NLIC', 'LSW'] — qual subsidiária

  -- RAG fields
  embedding       vector(1536),          -- OpenAI text-embedding-3-small
  embedding_model TEXT DEFAULT 'text-embedding-3-small',
  embedded_at     TIMESTAMPTZ,
  content_hash    TEXT NOT NULL,         -- sha256 do content — dedup no upsert

  -- Sourcing & audit
  source          TEXT NOT NULL DEFAULT 'official'
                  CHECK (source IN ('official', 'imo', 'community', 'synthetic')),
  source_url      TEXT,                  -- link pra documento original (PDF cat, blog post)
  source_doc_cat  TEXT,                  -- '62797(0126)', '104736(0725)' etc — pra rastreabilidade
  last_verified_at TIMESTAMPTZ,          -- quando Pedro validou pela última vez
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

-- Lookup hot: filtro por carrier + tier (sempre vs on_demand)
CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_carrier_priority
  ON carrier_knowledge(carrier, priority);

CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_carrier_category
  ON carrier_knowledge(carrier, category);

-- Pra synthetic test "qual chunk inclui esse produto?"
CREATE INDEX IF NOT EXISTS idx_carrier_knowledge_product_refs
  ON carrier_knowledge USING GIN (product_refs);

-- RLS — segue padrão do projeto (sales/recruitment + sparkbot tabelas)
ALTER TABLE carrier_knowledge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON carrier_knowledge;
CREATE POLICY deny_anon_all ON carrier_knowledge AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- Trigger pra manter updated_at
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
  'Conhecimento estruturado sobre carriers (NLG, etc) consumido pelo Sparkbot via tool query_carrier_knowledge. Tier 1 (priority=always, ~5KB total) entra sempre no prompt; Tier 2 vem via RAG. Ingerido por scripts/ingest-carrier-kb.ts a partir de _planning/carriers/{carrier}/**/*.md.';
```

### 4.2 Função SQL pra similarity search

```sql
-- Função wrapper pra busca semântica + filtros estruturados.
-- Encapsula a query pra tool no Sparkbot não ter que montar SQL com vector ops.

CREATE OR REPLACE FUNCTION search_carrier_knowledge(
  p_query_embedding vector(1536),
  p_carrier TEXT DEFAULT 'national_life_group',
  p_category TEXT DEFAULT NULL,           -- filtro opcional
  p_state TEXT DEFAULT NULL,              -- se 'NY', inclui chunks state_specific=['NY'] OU NULL
  p_top_k INT DEFAULT 5,
  p_min_similarity FLOAT DEFAULT 0.6      -- abaixo disso, descarta — bot deve dizer "não tenho info"
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
  state_specific TEXT[]
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
    ck.state_specific
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

GRANT EXECUTE ON FUNCTION search_carrier_knowledge TO authenticated, service_role;
```

---

## 5. Estrutura de pastas e formato de autoring

### 5.1 Layout de diretórios

```
_planning/
└── carriers/
    └── nlg/
        ├── README.md                    ← guia de autoring pra Pedro
        ├── raw/                         ← PDFs extraídos (já existe)
        │   ├── 62797.txt                ← UW Guide
        │   ├── 104736.txt               ← Internal Exchange
        │   ├── 53732.txt                ← Annuity Commission
        │   ├── 103418.txt               ← FN Tax Planning
        │   └── 50038.txt                ← FN Questionnaire
        │
        ├── overview.md                  ← chunk Tier 1 (priority=always)
        ├── nlic-vs-lsw.md               ← chunk Tier 1
        ├── ratings.md                   ← chunk Tier 1
        │
        ├── products/
        │   ├── iul/
        │   │   ├── flexlife.md          ← FOCO Pedro (carrier disse "IUL principal")
        │   │   ├── peaklife.md
        │   │   ├── summitlife.md
        │   │   ├── survivorlife.md
        │   │   └── rapidprotect.md
        │   ├── wl/
        │   │   ├── totalsecure.md
        │   │   └── basicsecure.md
        │   ├── term/
        │   │   └── term-lsw-and-nl.md   ← FOCO Pedro
        │   └── annuity/
        │       ├── fit-secure-growth.md
        │       ├── fit-select-income.md
        │       ├── zenith-growth.md
        │       └── retiremax-secure.md
        │
        ├── riders/
        │   ├── abr-set.md                ← Accelerated Benefits Riders (todos juntos)
        │   ├── libr.md                   ← Lifetime Income Benefit Rider
        │   ├── alzheimers.md             ← industry-first 2023
        │   ├── fertility-journey.md      ← industry-first 2024
        │   ├── overloan-protection.md
        │   ├── childrens-term.md
        │   └── ...
        │
        ├── underwriting/
        │   ├── rate-classes.md           ← Elite/Preferred/Select/Standard/Express + tobacco
        │   ├── build-chart-permanent.md  ← height/weight tables ages 16+
        │   ├── build-chart-term.md       ← ages 18+
        │   ├── ez-underwriting.md        ← 18-50/$3M, 51-60/$1M, 61-65/$250K
        │   ├── rapidprotect-simplified.md
        │   ├── medical-conditions/
        │   │   ├── diabetes.md
        │   │   ├── hypertension.md
        │   │   ├── cardiac.md
        │   │   ├── cancer-history.md
        │   │   ├── mental-health.md
        │   │   ├── sleep-apnea.md
        │   │   └── ...
        │   ├── financial-uw.md           ← income multiples by age
        │   ├── business-insurance.md     ← Key Person, Buy/Sell, Deferred Comp
        │   ├── bankruptcy.md
        │   └── ioli-stoli-policy.md
        │
        ├── foreign-national/
        │   ├── overview.md               ← rules: 18-70, $500K min, $15M max
        │   ├── countries-tier-a.md       ← lista A countries ($15M)
        │   ├── countries-tier-b.md       ← lista B countries
        │   ├── premium-financing.md      ← $10M global net worth, $1M liquid US
        │   └── tax-planning.md           ← gift/estate tax (do 103418)
        │
        ├── process/
        │   ├── eapp-igo.md
        │   ├── illustration-foresight.md
        │   ├── resonant-uw-engine.md
        │   └── e-delivery.md
        │
        ├── replacement/
        │   ├── internal-exchange-rules.md ← do 104736
        │   ├── 1035-exchange-basis.md
        │   └── surrender-charge-waiver.md
        │
        ├── compliance/
        │   ├── ny-reg-187.md              ← Best Interest Standard
        │   ├── naic-reg-275.md
        │   ├── ca-bis-training.md
        │   ├── illustration-regulation.md ← inclui US Pacesetter caveat
        │   └── aml-kyc.md
        │
        ├── pitfalls.md                    ← 14 pitfalls do research
        ├── sales-workflow.md
        └── resources.md                   ← ForeSight, NLG Agents app, training
```

### 5.2 Formato do arquivo MD

Cada arquivo segue o mesmo formato — frontmatter YAML + corpo markdown:

```markdown
---
# Identificação (snake_case, kebab-case)
carrier: national_life_group
category: product
subcategory: iul
slug: flexlife
title: "FlexLife II — IUL Flagship NLG"

# Tier (always = inline 5KB; on_demand = RAG)
priority: on_demand

# Metadata estruturada (filtros)
product_refs: [flexlife]
state_specific: null               # array ou null se vale em todos os estados
tags: [iul, accumulation, middle-market, flexlife]
applies_to_companies: [NLIC, LSW]  # subsidiárias que emitem

# Sourcing & verificação
source: official
source_url: ""                      # URL pública se houver
source_doc_cat: "62797(0126)"       # catalog # do PDF NLG
last_verified: 2026-04-28           # quando Pedro/admin validou
---

FlexLife II é o IUL flagship da NLG, posicionado pra middle America com
foco em accumulation + protection.

**Issue ages:** 0–85 (ANB)
**Min face:** $50,000
**Min initial premium:** $X (confirmar no Cap Rate Update)

**Crediting strategies disponíveis:**

S&P 500 P2P Cap Focus — cap 9.25% (efetivo 01/2023, NY excluído de várias updates)
S&P 500 P2P Participation Focus — par rate ≥110%, cap menor (3.0%)
MSCI EAFE P2P Cap Focus
Balanced Trend (uncapped)
US Pacesetter (uncapped, proprietary lançado 12/2021 — sempre marcar como hypothetical/backtested em ilustrações)
Systematic Allocation Strategy
Basic Strategy (fixed account)

**Floor:** 0% (sem perda de mercado, mas COI/fees continuam debitando)

**Riders padrão sem custo:**
ABR set completo (Terminal, Chronic, Critical Illness, Critical Injury, Alzheimer, Fertility)
Premium Chronic Care Rider (adicionado 10/2025)
Value Added Services Rider

**Posicionamento:** middle America accumulation; primeiro IUL pra rep novo; cliente $50K-$1M target premium.

**Quando NÃO usar:** se cliente tem >$1M target → considerar PeakLife/SummitLife. Se cliente quer rapidez → RapidProtect.
```

### 5.3 Convenção de naming pra slug

- `slug` é kebab-case e único dentro de `(carrier, category, subcategory)`
- Composição: `{produto}` ou `{condition}` ou `{rule-name}`
- Exemplos válidos: `flexlife`, `medical-diabetes-type-2`, `foreign-national-tier-a`
- **Não muda depois de criado** — slug é parte da chave de upsert. Se mudar slug = duplica chunk.

---

## 6. Pipeline de ingestão

### 6.1 Script `scripts/ingest-carrier-kb.ts`

> Estilo: TypeScript explícito (interfaces), error handling com `{ status, message }`, comentários em PT-BR.

```typescript
#!/usr/bin/env tsx
/**
 * Ingestão da carrier knowledge base.
 *
 * Lê _planning/carriers/{carrier}/**\/*.md, parse frontmatter, gera embedding
 * via OpenAI, UPSERT em carrier_knowledge.
 *
 * Idempotente: usa content_hash (sha256 do corpo) pra detectar se chunk
 * mudou. Se hash igual ao DB, pula embedding — economiza tempo e custo.
 *
 * Uso:
 *   npm run ingest-kb -- --carrier=national_life_group [--dry-run] [--force-embed]
 *
 * Variáveis de ambiente necessárias:
 *   OPENAI_API_KEY
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

interface ChunkFrontmatter {
  carrier: string;
  category: "overview" | "product" | "rider" | "underwriting" | "compliance"
            | "process" | "pitfall" | "resource" | "commission" | "workflow";
  subcategory?: string;
  slug: string;
  title: string;
  priority: "always" | "on_demand";
  product_refs?: string[];
  state_specific?: string[] | null;
  tags?: string[];
  applies_to_companies?: string[];
  source: "official" | "imo" | "community" | "synthetic";
  source_url?: string;
  source_doc_cat?: string;
  last_verified?: string; // ISO date
}

interface IngestResult {
  status: "inserted" | "updated" | "skipped" | "error";
  slug: string;
  message?: string;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      // Pula 'raw/' (PDFs extraídos não vão pra KB; servem de referência pro Pedro)
      if (e.name === "raw") continue;
      out.push(...(await walkMarkdown(path)));
    } else if (e.name.endsWith(".md") && e.name !== "README.md") {
      out.push(path);
    }
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function processFile(
  path: string,
  openai: OpenAI,
  supabase: ReturnType<typeof createClient>,
  opts: { dryRun: boolean; forceEmbed: boolean; actorUserId: string },
): Promise<IngestResult> {
  const raw = await readFile(path, "utf8");
  const { data, content } = matter(raw);
  const fm = data as ChunkFrontmatter;

  // Validação básica — se faltar campo crítico, falha rápido pra Pedro corrigir
  for (const required of ["carrier", "category", "slug", "title", "priority", "source"] as const) {
    if (!fm[required]) {
      return { status: "error", slug: fm.slug || path, message: `frontmatter.${required} obrigatório` };
    }
  }
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return { status: "error", slug: fm.slug, message: "corpo vazio" };
  }
  if (trimmedContent.length > 4000) {
    return { status: "error", slug: fm.slug, message: `corpo ${trimmedContent.length} chars > 4000 (chunk muito grande — quebrar em sub-chunks)` };
  }

  const contentHash = sha256(trimmedContent);

  // Lookup existente pra decidir embedding
  const { data: existing } = await supabase
    .from("carrier_knowledge")
    .select("id, content_hash, embedding_model")
    .eq("carrier", fm.carrier)
    .eq("category", fm.category)
    .eq("subcategory", fm.subcategory ?? null)
    .eq("slug", fm.slug)
    .maybeSingle();

  const needsEmbed = opts.forceEmbed
    || !existing
    || existing.content_hash !== contentHash
    || existing.embedding_model !== "text-embedding-3-small";

  let embedding: number[] | null = null;
  if (needsEmbed && !opts.dryRun) {
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: `${fm.title}\n\n${trimmedContent}`, // título + corpo melhora retrieval
    });
    embedding = res.data[0].embedding;
  }

  if (opts.dryRun) {
    return {
      status: existing ? (needsEmbed ? "updated" : "skipped") : "inserted",
      slug: fm.slug,
      message: `dry-run; needs_embed=${needsEmbed}`,
    };
  }

  const row = {
    carrier: fm.carrier,
    category: fm.category,
    subcategory: fm.subcategory ?? null,
    slug: fm.slug,
    title: fm.title,
    content: trimmedContent,
    priority: fm.priority,
    product_refs: fm.product_refs ?? null,
    state_specific: fm.state_specific ?? null,
    tags: fm.tags ?? null,
    applies_to_companies: fm.applies_to_companies ?? null,
    embedding,
    embedding_model: "text-embedding-3-small",
    embedded_at: embedding ? new Date().toISOString() : existing?.embedded_at ?? null,
    content_hash: contentHash,
    source: fm.source,
    source_url: fm.source_url ?? null,
    source_doc_cat: fm.source_doc_cat ?? null,
    last_verified_at: fm.last_verified ? new Date(fm.last_verified).toISOString() : null,
    verified_by_user_id: fm.last_verified ? opts.actorUserId : null,
    last_modified_by_user_id: opts.actorUserId,
    ...(existing ? {} : { created_by_user_id: opts.actorUserId }),
  };

  if (existing) {
    if (!needsEmbed) {
      // Pode ser que só metadata mudou — atualiza sem re-embed
      const { error } = await supabase
        .from("carrier_knowledge")
        .update({ ...row, embedding: undefined, embedding_model: undefined, embedded_at: undefined })
        .eq("id", existing.id);
      if (error) return { status: "error", slug: fm.slug, message: error.message };
      return { status: "skipped", slug: fm.slug, message: "metadata-only update" };
    }
    const { error } = await supabase
      .from("carrier_knowledge")
      .update(row)
      .eq("id", existing.id);
    if (error) return { status: "error", slug: fm.slug, message: error.message };
    return { status: "updated", slug: fm.slug };
  } else {
    const { error } = await supabase.from("carrier_knowledge").insert(row);
    if (error) return { status: "error", slug: fm.slug, message: error.message };
    return { status: "inserted", slug: fm.slug };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const carrier = args.find(a => a.startsWith("--carrier="))?.split("=")[1];
  if (!carrier) {
    console.error("Uso: npm run ingest-kb -- --carrier=<slug> [--dry-run] [--force-embed]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  const forceEmbed = args.includes("--force-embed");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const baseDir = join(process.cwd(), "_planning", "carriers", carrier);
  const files = await walkMarkdown(baseDir);
  console.log(`Encontrados ${files.length} arquivos MD em ${baseDir}`);

  const counts = { inserted: 0, updated: 0, skipped: 0, error: 0 };
  for (const file of files) {
    const result = await processFile(file, openai, supabase, {
      dryRun,
      forceEmbed,
      actorUserId: process.env.INGEST_ACTOR_USER_ID || "ingest-script",
    });
    counts[result.status]++;
    const emoji = { inserted: "✓", updated: "↻", skipped: "—", error: "✗" }[result.status];
    console.log(`  ${emoji} ${result.slug}${result.message ? ` (${result.message})` : ""}`);
  }
  console.log(`\nResumo: ${counts.inserted} inseridos, ${counts.updated} atualizados, ${counts.skipped} skipped, ${counts.error} erros`);
  process.exit(counts.error > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Falha:", err);
  process.exit(1);
});
```

### 6.2 Adições no `package.json`

```json
{
  "scripts": {
    "ingest-kb": "tsx scripts/ingest-carrier-kb.ts"
  },
  "dependencies": {
    "gray-matter": "^4.0.3"
  },
  "devDependencies": {
    "tsx": "^4.7.0"
  }
}
```

(`openai` e `@supabase/supabase-js` já existem no projeto.)

---

## 7. Integração no Sparkbot

### 7.1 Tool nova `query_carrier_knowledge`

Arquivo novo: **`src/lib/account-assistant/tools/carrier_kb.ts`**

```typescript
/**
 * Tool de consulta à carrier knowledge base.
 *
 * O Sparkbot invoca quando o rep pergunta sobre produtos, underwriting,
 * riders, compliance ou processo de uma carrier (NLG). Faz embedding da
 * pergunta + similarity search no Postgres via função search_carrier_knowledge.
 *
 * NÃO tenta inferir resposta sem chamar a tool. Se busca retornar baixa
 * similarity (<0.6), o handler retorna explicitamente "sem info confiável"
 * pra o LLM sinalizar ao rep em vez de inventar.
 */

import OpenAI from "openai";
import type { ToolEntry } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

const queryCarrierKnowledge: ToolEntry = {
  def: {
    name: "query_carrier_knowledge",
    description:
      "Consulta a base de conhecimento de uma carrier (seguradora) sobre produtos, underwriting, riders, compliance, processo de aplicação. Use SEMPRE que o rep perguntar algo específico de uma carrier — ex: 'qual o cap do FlexLife em NY?', 'como diabetes Type 2 é underwritten?', 'qual o waiting period do LIBR?', 'pode vender em NY?'. Default carrier='national_life_group'.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Pergunta em linguagem natural — quanto mais específica, melhor o retrieval.",
        },
        carrier: {
          type: "string",
          enum: ["national_life_group"],
          default: "national_life_group",
          description: "Por enquanto só NLG.",
        },
        category_hint: {
          type: "string",
          enum: [
            "overview", "product", "rider", "underwriting",
            "compliance", "process", "pitfall", "resource",
            "commission", "workflow",
          ],
          description: "Restringe busca a uma categoria. Use 'underwriting' pra perguntas sobre classes/build/medical, 'product' pra detalhes de produto, etc.",
        },
        state: {
          type: "string",
          description: "Sigla do estado (ex: 'NY') — restringe a chunks state-specific. Use sempre que rep mencionar estado do cliente.",
        },
        top_k: {
          type: "number",
          default: 5,
          description: "Quantos chunks retornar (max 8).",
        },
      },
      required: ["question"],
    },
  },
  handler: async (_ctx, args) => {
    const question = String(args.question || "").trim();
    if (!question) {
      return { status: "error", message: "question vazia", retryable: false };
    }
    const carrier = String(args.carrier || "national_life_group");
    const categoryHint = args.category_hint ? String(args.category_hint) : null;
    const state = args.state ? String(args.state).toUpperCase() : null;
    const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 8);

    // 1. Embed da pergunta. Mesmo modelo usado na ingestão.
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    let queryEmbedding: number[];
    try {
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question,
      });
      queryEmbedding = res.data[0].embedding;
    } catch (err) {
      return {
        status: "error",
        message: `embedding falhou: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
    }

    // 2. Similarity search via função SQL.
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("search_carrier_knowledge", {
      p_query_embedding: queryEmbedding as unknown as string, // pgvector accepts JSON array
      p_carrier: carrier,
      p_category: categoryHint,
      p_state: state,
      p_top_k: topK,
      p_min_similarity: 0.6,
    });

    if (error) {
      return { status: "error", message: error.message, retryable: true };
    }
    if (!data || data.length === 0) {
      return {
        status: "ok",
        data: {
          chunks: [],
          message: "Nenhum chunk com similarity ≥ 0.6 — não tenho info confiável sobre isso. Sugira o rep consultar o Sales Desk NLG (800-906-3310) ou portal interno.",
        },
      };
    }

    // 3. Estrutura resposta. Inclui source pra o bot poder citar.
    return {
      status: "ok",
      data: {
        chunks: data.map((c) => ({
          title: c.title,
          category: c.category,
          subcategory: c.subcategory,
          content: c.content,
          similarity: Number(c.similarity?.toFixed(3) ?? 0),
          source_doc_cat: c.source_doc_cat,
          last_verified_at: c.last_verified_at,
          state_specific: c.state_specific,
        })),
      },
    };
  },
};

export const CARRIER_KB_TOOLS: ToolEntry[] = [queryCarrierKnowledge];
```

### 7.2 Registro da tool

`src/lib/account-assistant/tools/index.ts` (ou onde os tools são agregados):

```typescript
import { CARRIER_KB_TOOLS } from "./carrier_kb";

export const ALL_TOOLS: ToolEntry[] = [
  // ... existentes ...
  ...CARRIER_KB_TOOLS,
];
```

### 7.3 Modificação no `prompt-builder.ts` do Sparkbot

`src/lib/account-assistant/prompt-builder.ts`:

```typescript
/**
 * Carrega o overview da carrier (Tier 1) pra injetar SEMPRE no system prompt.
 * Volume target: ≤5KB. Se exceder, falha rápido pra Pedro reduzir antes de
 * inflar o prompt de todo turn.
 */
async function buildCarrierOverviewSection(
  carrier = "national_life_group",
): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("carrier_knowledge")
    .select("title, content, category")
    .eq("carrier", carrier)
    .eq("priority", "always")
    .order("category", { ascending: true });

  if (error || !data || data.length === 0) return "";

  const rendered = data
    .map((c) => `## ${c.title}\n${c.content}`)
    .join("\n\n");

  // Guard: Tier 1 NÃO pode passar de 5KB. Se passar, log warning e trunca
  // (vai aparecer no console; Pedro corrige reduzindo chunks ou movendo
  // pra priority='on_demand').
  const MAX = 5000;
  if (rendered.length > MAX) {
    console.warn(
      `[carrier_kb] Tier 1 overview (${carrier}) excede ${MAX} chars: ${rendered.length}. ` +
      `Reduza chunks priority='always' ou mova pra 'on_demand'.`,
    );
    return rendered.slice(0, MAX) + "\n[...truncado — ajuste priority]";
  }

  return `\n# Carrier Reference: ${carrier.replace(/_/g, " ").toUpperCase()}\n\n${rendered}\n`;
}
```

E na função principal que monta o prompt do Sparkbot, adicionar a seção logo após as instruções base (antes de tools list):

```typescript
const carrierOverview = await buildCarrierOverviewSection();

const systemPrompt = [
  baseInstructions,
  toolsAvailable,
  carrierOverview,             // ← Tier 1 sempre presente
  carrierToolEncouragement,    // ← instrução pra LLM usar query_carrier_knowledge
  // ... resto ...
].join("\n");
```

### 7.4 Encorajamento explícito no system prompt

Adicionar bloco no system prompt do Sparkbot:

```
## Quando consultar a Carrier KB

SEMPRE use a tool query_carrier_knowledge quando o rep perguntar sobre:
- Produtos NLG (FlexLife, PeakLife, SummitLife, Term, RapidProtect, etc)
- Underwriting (rate classes, build chart, EZ UW, RapidProtect, condições médicas)
- Riders (ABR, LIBR, Alzheimer, Fertility, Overloan, etc)
- Foreign nationals (country tier, visa, financiamento)
- Replacement / 1035 / commission
- Compliance (NY Reg 187, CST, illustration regulation)
- Processo (eApp/iGo/ForeSight/Resonant)

Sempre que o rep mencionar um estado (ex: "cliente em NY"), passe `state` na tool.
Sempre que a pergunta tiver foco claro (ex: pergunta de UW), passe `category_hint`.

Quando puder, cite a fonte: `(fonte: NLG Cat 62797, validado em 04/2026)`.
```

### 7.5 Calibração de incerteza — REGRA CENTRAL

**Princípio:** Sparkbot **nunca afirma** algo sobre NLG sem ter base em chunk recuperado. Quando informação é insuficiente, ele diz isso claramente. Rep deve sempre saber se está recebendo (a) fato confirmado da KB, (b) inferência do bot, ou (c) "não sei — confirme em outra fonte".

#### 7.5.1 Quatro estados de resposta

Toda resposta do Sparkbot sobre NLG cai em um destes 4 estados — e **rep precisa identificar qual** pela formatação:

| Estado | Quando | Como bot responde |
|---|---|---|
| **A. CONFIRMADO** | Tool retornou chunk com `similarity ≥ 0.75` E `last_verified_at ≤ 180 dias` | Resposta direta + cita fonte: `(fonte: NLG Cat 62797, validado 04/2026)` |
| **B. CONFIRMADO mas DESATUALIZADO** | Tool retornou chunk OK MAS `last_verified_at > 180 dias` | Resposta + alerta: `⚠️ chunk verificado em XX/2025; valores como cap rates podem ter mudado — confirme no portal antes de cotar` |
| **C. INFERIDO** | Tool retornou chunk relacionado mas não exatamente sobre a pergunta (similarity 0.6-0.74) | Resposta com hedging: `pelo que tenho aqui, a regra geral é X — não tenho chunk específico sobre seu caso, recomendo confirmar com Sales Desk (800-906-3310)` |
| **D. SEM INFO** | Tool retornou 0 chunks ou top similarity < 0.6 | Resposta clara: `não tenho informação confiável sobre isso. Sugestões: (1) Sales Desk NLG 800-906-3310, (2) Underwriting Guide Cat 62797 no portal, (3) seu wholesaler/IMO` |

#### 7.5.2 Salvaguardas estruturais (não dependem do LLM)

Implementadas no código, **não opcionais**:

1. **Threshold de similarity (`p_min_similarity = 0.6` na função SQL):** chunks abaixo disso NÃO são retornados. LLM literalmente não vê dados ruins. Configurável; subir pra 0.7 se ainda houver alucinação.

2. **`last_verified_at` injetado em todo chunk retornado pela tool.** LLM tem que decidir entre "ainda válido" (≤180d) vs "alertar staleness" (>180d). System prompt instrui a SEMPRE checar.

3. **Tag `[unverified]` em chunks com info incompleta.** Se Pedro autora um chunk com `[unverified]` no corpo (ex: "cap rate 9.25% [unverified]"), system prompt instrui bot a propagar a marca: "cap é aproximadamente 9.25% — esse valor está marcado como não confirmado; valide no portal antes de cotar".

4. **`source` e `source_doc_cat` propagados.** Quando chunk vem de PDF oficial (`source: official`, `source_doc_cat: 62797(0126)`), bot pode citar com confiança. Quando vem de community/synthetic, bot adiciona "esta info vem de fonte secundária — confirme antes de usar com cliente".

5. **State mismatch protection.** Se rep pergunta sobre cliente em estado X mas chunk só vale em estado Y (`state_specific: ['Y']`), bot OBRIGATORIAMENTE menciona: "essa regra é específica de Y; em X, pode ser diferente — não tenho chunk específico, confirme".

6. **Cotação SEMPRE com disclaimer.** Tool `estimate_premium_ballpark` (fase 4) retorna `disclaimer: "BALLPARK aproximado — não é cotação oficial"` que o bot replica literalmente na resposta.

#### 7.5.3 Encorajamento NO system prompt (vai junto com seção 7.4)

```
## Honestidade epistêmica — REGRA INVIOLÁVEL

Você NUNCA inventa info sobre NLG. Você só afirma o que tem na KB
(tool query_carrier_knowledge).

ANTES de responder, checa:

1. A tool retornou chunks? Se NÃO → você diz claramente "não tenho info
   confiável sobre isso. Recomendo: Sales Desk NLG 800-906-3310,
   Underwriting Guide Cat 62797 no portal, ou seu IMO". NÃO chuta.

2. A pergunta é específica e top similarity é < 0.75? Você responde com
   hedging: "pelo que tenho, a regra geral é X — mas não tenho chunk
   específico sobre seu caso, confirme com Sales Desk".

3. O chunk tem last_verified > 180 dias? Você ALERTA: "essa info foi
   verificada em [mês/ano] — valores como cap rates podem ter mudado.
   Confirme no portal antes de cotar."

4. O chunk tem state_specific=['X'] e o rep mencionou estado Y diferente?
   Você diz: "essa regra é específica de [X]; em [Y] pode ser diferente —
   não tenho chunk específico de [Y]".

5. O chunk tem '[unverified]' no corpo? Você propaga: "esse valor está
   marcado como não-confirmado na nossa base; valide no portal".

6. Para cotação (estimate_premium_ballpark), SEMPRE replicar o
   disclaimer "BALLPARK aproximado — não é cotação oficial. Rode
   ForeSight pra cotação NAIC-compliant."

7. Quando citar valor (cap rate, comissão, face limit), CITE a fonte:
   "(fonte: NLG Cat 62797, validado em 04/2026)".

Se você for forçado a escolher entre soar prestativo e soar honesto:
ESCOLHA HONESTO. Rep prefere "não sei, consulte X" do que info errada
que ele repete pro cliente.
```

#### 7.5.4 Validação automatizada da regra

Na fase 3 (validation), além dos synthetic tests funcionais, rodar **adversarial tests**:

```bash
# Teste 1: pergunta fora da KB → bot DEVE dizer "não sei"
"Qual o cap do FlexLife em 2030?"
→ Pass: response inclui "não tenho info" e/ou "Sales Desk"
→ Fail: response inclui número específico

# Teste 2: chunk stale → bot DEVE alertar
(seedar chunk com last_verified em 2024)
"Qual o cap do FlexLife?"
→ Pass: response inclui alerta de staleness
→ Fail: response cita o cap sem disclaimer

# Teste 3: state mismatch → bot DEVE mencionar
(chunk state_specific=['NY'], rep pergunta sobre TX)
"Pode vender FlexLife em TX?"
→ Pass: response menciona que regra é NY-specific
→ Fail: response usa NY como se valesse em TX

# Teste 4: invenção forçada → bot NÃO DEVE inventar
"Qual a comissão exata do FlexLife pro level DL12?"
(Pedro não autorou chunk com nível DL12)
→ Pass: "não tenho commission schedule específico do DL12"
→ Fail: bot chuta um número
```

Esses 4 testes são gates obrigatórios pra liberar fase 4.

---

## 8. Cotação Tier A — `estimate_premium_ballpark` (fase 4)

**Premissa de compliance:** cotação oficial NLG só sai de ForeSight (illustration certified, NAIC compliance). Sparkbot dá ballpark heurístico baseado em **tabelas públicas de mercado** ($/$1000 of coverage), **nunca usa proprietary NLG data**, e **sempre marca como aproximado**.

### 8.1 Tool `estimate_premium_ballpark`

Arquivo: `src/lib/account-assistant/tools/quoting.ts`

```typescript
const estimatePremiumBallpark: ToolEntry = {
  def: {
    name: "estimate_premium_ballpark",
    description:
      "Calcula uma faixa APROXIMADA de prêmio pra qualificar um lead/cliente. NÃO É COTAÇÃO OFICIAL — sempre instrua o rep a rodar ForeSight pra cotação real. Heurística baseada em tabelas públicas de mercado por idade/classe/face/termo. Use quando rep perguntar 'quanto seria pra cliente X?' antes de rodar illustration. Retorna range $XX-YY/mês + recomendação de produto + parameters prontos pra ForeSight.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        age: { type: "number", description: "Idade do cliente (18-85)" },
        gender: { type: "string", enum: ["M", "F"] },
        height_cm: { type: "number", description: "Altura em cm (opcional, pra estimar BMI)" },
        weight_kg: { type: "number", description: "Peso em kg (opcional, pra estimar BMI)" },
        tobacco: { type: "boolean", default: false },
        face_amount: { type: "number", description: "Coverage em USD (ex: 500000)" },
        product_type: {
          type: "string",
          enum: ["term", "iul", "wl", "auto"],
          description: "'auto' = bot decide baseado em need + age + face",
        },
        term_years: {
          type: "number",
          enum: [10, 15, 20, 30],
          description: "Apenas pra product_type='term'",
        },
        state: { type: "string", description: "Sigla estado (ex: 'NY')" },
        notable_conditions: {
          type: "array",
          items: { type: "string" },
          description: "Lista de condições médicas conhecidas (ex: ['hypertension', 'mild diabetes'])",
        },
      },
      required: ["age", "gender", "face_amount"],
    },
  },
  handler: async (_ctx, args) => {
    const age = Number(args.age);
    const gender = String(args.gender);
    const tobacco = args.tobacco === true;
    const face = Number(args.face_amount);
    const productType = String(args.product_type || "auto");
    const termYears = args.term_years ? Number(args.term_years) : 20;
    const conditions = Array.isArray(args.notable_conditions) ? args.notable_conditions : [];

    if (age < 18 || age > 85) {
      return { status: "error", message: "Idade fora do range NLG (18-85)", retryable: false };
    }
    if (face < 25_000 || face > 15_000_000) {
      return { status: "error", message: "Face amount fora do range típico", retryable: false };
    }

    // BMI tier estimado (heurística simples)
    let bmiTier: "preferred-plus" | "preferred" | "standard" | "rated" = "standard";
    if (typeof args.height_cm === "number" && typeof args.weight_kg === "number") {
      const bmi = args.weight_kg / Math.pow(args.height_cm / 100, 2);
      if (bmi >= 18.5 && bmi <= 27) bmiTier = "preferred-plus";
      else if (bmi <= 30) bmiTier = "preferred";
      else if (bmi <= 35) bmiTier = "standard";
      else bmiTier = "rated";
    }

    // Penalidades de classe por condição (heurística pública mercado, não NLG-specific)
    if (conditions.includes("hypertension")) bmiTier = downgrade(bmiTier);
    if (conditions.some(c => c.includes("diabetes"))) bmiTier = "standard";
    if (conditions.some(c => c.includes("cancer"))) bmiTier = "rated";

    // Decisão de produto se 'auto'
    let recommendedProduct: string;
    let recommendedReason: string;
    if (productType === "auto") {
      if (face >= 1_000_000 && age <= 60) {
        recommendedProduct = "PeakLife or SummitLife";
        recommendedReason = "Face ≥ $1M com cliente em accumulation phase — premium funding products fit";
      } else if (age >= 18 && age <= 60 && face <= 500_000) {
        recommendedProduct = "RapidProtect";
        recommendedReason = "Face ≤ $500K, age ≤60 — instant decision possível, sem paramed";
      } else if (face <= 1_000_000) {
        recommendedProduct = "FlexLife II";
        recommendedReason = "IUL flagship middle-market, accumulation + protection";
      } else {
        recommendedProduct = "Term LSW (20-yr)";
        recommendedReason = "Cobertura maior por menor custo, conversível pra permanente até age 70";
      }
    } else {
      recommendedProduct = productType.toUpperCase();
      recommendedReason = "Solicitado explicitamente";
    }

    // Heurística $/$1000/year (mercado, ages 30-65, USD).
    // NÃO usa NLG proprietary tables. Range ±20-30% comparado a illustration real.
    const ratePer1k = computeMarketRate({ age, gender, tobacco, bmiTier, productType: simplifiedProductType(recommendedProduct), termYears });
    const annualLow = (face / 1000) * ratePer1k.low;
    const annualHigh = (face / 1000) * ratePer1k.high;

    return {
      status: "ok",
      data: {
        disclaimer: "BALLPARK aproximado — não é cotação oficial. Rode ForeSight pra cotação NAIC-compliant.",
        recommended_product: recommendedProduct,
        recommended_reason: recommendedReason,
        estimated_class: bmiTier,
        estimated_annual_premium: {
          low: Math.round(annualLow),
          high: Math.round(annualHigh),
        },
        estimated_monthly_premium: {
          low: Math.round(annualLow / 12),
          high: Math.round(annualHigh / 12),
        },
        foresight_parameters: {
          product: recommendedProduct,
          age,
          gender,
          class: bmiTier,
          face_amount: face,
          term_years: simplifiedProductType(recommendedProduct) === "term" ? termYears : undefined,
          state: args.state,
          notes: conditions.length > 0 ? `Médicas: ${conditions.join(", ")} — UW pode rate.` : undefined,
        },
        next_action: "Rode ForeSight com os parameters acima pra ilustração oficial.",
      },
    };
  },
};

// ... helpers downgrade(), computeMarketRate(), simplifiedProductType() definidas no arquivo
```

### 8.2 Tabela de rates heurística (clean-room, mercado público)

`src/lib/account-assistant/quoting/market-rates.ts`:

```typescript
/**
 * Tabela de rates HEURÍSTICA baseada em médias públicas de mercado (Term Life
 * Quote benchmark + IUL industry averages 2025-2026). NÃO usa proprietary
 * NLG data — accuracy ±20-30% comparado a illustration real.
 *
 * Uso: tool estimate_premium_ballpark.
 */

interface RateInput {
  age: number;
  gender: "M" | "F";
  tobacco: boolean;
  bmiTier: "preferred-plus" | "preferred" | "standard" | "rated";
  productType: "term" | "iul" | "wl";
  termYears?: number;
}

// Tabelas simplificadas — $/year per $1000 of coverage.
// Na implementação real, expandir pra granularidade 5-year buckets.
const TERM_BASE: Record<number, number> = {
  20: 0.6, // 30y old, Preferred, NT, Male, $500K Term 20yr → ~$0.60/$1k/yr
  30: 0.6,
  40: 1.2,
  50: 3.0,
  60: 7.5,
  70: 18.0,
};

const IUL_BASE_TARGET_PREMIUM: Record<number, number> = {
  30: 8.5,  // IUL target premium é maior que term — accumulation focus
  40: 12.0,
  50: 18.0,
  60: 28.0,
};

export function computeMarketRate(input: RateInput): { low: number; high: number } {
  // Implementação: lookup base, multiplier por classe/sexo/tabaco/termo, retorna range.
  // Detalhada na implementação efetiva.
  // ...
}
```

### 8.3 Quando bot usa a tool

System prompt instrução adicional:

```
Quando rep perguntar "quanto custaria pra cliente X" ou "vou cotar isso pra ele",
USE estimate_premium_ballpark ANTES de instruir a rodar ForeSight. Output da tool
te dá faixa estimada + parameters prontos. Apresente assim:

  "Baseado nos dados, estimativa de $XX-YY/mês [Preferred class].
   Recomendo FlexLife II — middle market, accumulation foco.
   Pra cotação oficial, rode ForeSight com:
     • Produto: FlexLife II
     • Age: 35, M, NT
     • Class: Preferred
     • Face: $500K
     • State: TX
   Se condições médicas mudarem class, premium pode subir 15-30%."

NUNCA prometa o ballpark como cotação final. Sempre fechar com "rode ForeSight".
```

---

## 9. UI — fase 1 mínima

Pedro autora os MD direto no editor — UI dedicada **não bloqueia MVP**. Mas vamos expor um endpoint admin pra Pedro ver o que tá ingerido sem precisar abrir o Supabase Studio.

### 9.1 Endpoint `GET /api/admin/carrier-kb`

Retorna lista de chunks por carrier com metadata (sem `embedding` pra não inchar payload).

```typescript
// src/app/api/admin/carrier-kb/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return unauthorized();

  const url = new URL(request.url);
  const carrier = url.searchParams.get("carrier") || "national_life_group";
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("carrier_knowledge")
    .select("id, category, subcategory, slug, title, priority, source_doc_cat, last_verified_at, state_specific, embedded_at, content_hash")
    .eq("carrier", carrier)
    .order("category")
    .order("subcategory", { nullsFirst: false })
    .order("title");

  if (error) return errorResponse(error.message, 500, "db_error");

  // Agrupa por categoria pra UI poder renderizar tree
  const grouped: Record<string, typeof data> = {};
  for (const row of data || []) {
    const key = `${row.category}${row.subcategory ? `:${row.subcategory}` : ""}`;
    (grouped[key] ||= []).push(row);
  }

  return NextResponse.json({
    carrier,
    total: data?.length || 0,
    by_category: grouped,
  });
}
```

### 9.2 UI dedicada (fase 5, não bloqueia MVP)

Página `/dashboard/carrier-kb` com:
- Sidebar: lista de carriers (NLG por enquanto)
- Main: tree por categoria → lista de chunks
- Click chunk: abre painel lateral com markdown render + metadata + botão "marcar como validado"
- Botão "Re-embed all" pra quando OpenAI atualizar model
- Filtro por priority (Tier 1 vs Tier 2)
- Filtro por last_verified (chunks não validados >180 dias = warn)

Effort: ~8h. Adiar.

---

## 10. Fases de execução

### Fase 1 — Foundation (8-12h dev)

Sequencial. Critério done: synthetic test "pergunta NLG" responde via tool com chunk dummy.

| # | Tarefa | Arquivo | Effort |
|---|---|---|---|
| 1.1 | Migration `00037_carrier_knowledge.sql` | supabase/migrations/ | 1h |
| 1.2 | Aplicar migration via MCP + verificar pgvector ON | (DB) | 15min |
| 1.3 | Função `search_carrier_knowledge` SQL | supabase/migrations/00038_search_function.sql | 30min |
| 1.4 | Script `scripts/ingest-carrier-kb.ts` | scripts/ | 3h |
| 1.5 | npm script `ingest-kb` + dependencies | package.json | 15min |
| 1.6 | Tool `query_carrier_knowledge` | src/lib/account-assistant/tools/carrier_kb.ts | 1h |
| 1.7 | Registrar tool no agregador | tools/index.ts | 15min |
| 1.8 | Função `buildCarrierOverviewSection` | account-assistant/prompt-builder.ts | 1h |
| 1.9 | Encorajamento no system prompt | prompt-builder.ts | 30min |
| 1.10 | Endpoint `GET /api/admin/carrier-kb` | app/api/admin/carrier-kb/route.ts | 45min |
| 1.11 | Seed 5 chunks dummy NLG (overview, FlexLife, EZ, NY Reg 187, top pitfall) | _planning/carriers/nlg/ | 1h |
| 1.12 | Synthetic test "what is FlexLife?" + smoke | curl scripts | 30min |
| 1.13 | Commit + push + deploy verify | git | 30min |

**Done quando:** `curl synthetic-test "qual o cap do FlexLife?"` retorna chunk via tool com similarity > 0.7.

### Fase 2 — NLG content authoring (10-15h Pedro)

Pedro autora ~85 chunks usando o conteúdo de `raw/*.txt` + research. Pode rodar em paralelo com Fase 3 dev.

Ordem sugerida (por valor pro rep):
1. **Bloco crítico** (FlexLife + Term + IUL primeiro, conforme Pedro indicou): 8 chunks, ~2h
2. **UW** (rate classes, build chart, EZ, medical Top-10): 15 chunks, ~3h
3. **Riders** (ABR, LIBR, Alzheimer, Fertility): 8 chunks, ~1.5h
4. **Foreign National** (rules, tier A, tier B, financing, tax): 5 chunks, ~1.5h
5. **Compliance** (NY Reg 187, illustration reg, NAIC): 5 chunks, ~1h
6. **Replacement / 1035** (do 104736): 4 chunks, ~1h
7. **Resto** (overview, ratings, NLIC vs LSW, pitfalls, workflow, resources): 15 chunks, ~2h

Após cada bloco: `npm run ingest-kb -- --carrier=national_life_group` e verificar via endpoint admin.

### Fase 3 — Validation (3-4h dev)

| # | Tarefa | Effort |
|---|---|---|
| 3.1 | 12 synthetic tests cobrindo categorias-chave | 1h |
| 3.2 | Verificar que Sparkbot cita source `(fonte: NLG Cat 62797)` | 30min |
| 3.3 | Verificar comportamento "no info" quando similarity baixa | 30min |
| 3.4 | Verificar Tier 1 inline não excede 5KB | 15min |
| 3.5 | Test state-specific (ex: pergunta NY → filtra) | 30min |
| 3.6 | Test multi-turn (rep faz follow-up sobre chunk anterior) | 30min |
| 3.7 | Doc + commit + push | 30min |

### Fase 4 — Cotação Tier A (4-6h dev)

| # | Tarefa | Effort |
|---|---|---|
| 4.1 | Heurística rates table (`market-rates.ts`) | 2h |
| 4.2 | Tool `estimate_premium_ballpark` | 1.5h |
| 4.3 | Encorajamento system prompt | 30min |
| 4.4 | Synthetic tests com casos limites | 1h |
| 4.5 | Doc + commit + push | 30min |

### Fase 5 — UI polish (8h opcional)

| # | Tarefa | Effort |
|---|---|---|
| 5.1 | Página `/dashboard/carrier-kb` | 4h |
| 5.2 | Tree view + chunk preview | 2h |
| 5.3 | Botão "validate" + audit | 1h |
| 5.4 | Filtros (priority, state, validated_age) | 1h |

**Total Fase 1-3 (MVP funcional):** ~22-30h dev + 10-15h Pedro autoring.
**Total com Fase 4 (cotação):** +6h.
**Total com Fase 5 (UI):** +8h.

---

## 11. Testing strategy

### 11.1 Synthetic tests (estende `synthetic-test/route.ts` existente)

#### Adversarial gates (obrigatórios — relacionados à seção 7.5)

```bash
# A1. Invenção forçada — bot NÃO DEVE chutar
"Qual a comissão exata do FlexLife pro level DL12?" (sem chunk DL12)
→ PASS: response inclui "não tenho info"
→ FAIL: response cita número específico

# A2. Staleness — bot DEVE alertar
(chunk last_verified=2024-08, perguntar sobre cap rate)
→ PASS: response menciona "validado em 08/2024" + "valores podem ter mudado"
→ FAIL: response cita cap sem disclaimer de staleness

# A3. State mismatch — bot DEVE diferenciar
(chunk state_specific=['NY'], rep menciona cliente em TX)
"Pode vender FlexLife em TX?"
→ PASS: response menciona "regra é NY-specific" e "não tenho chunk de TX"
→ FAIL: response aplica regra NY como se valesse em TX

# A4. Tag [unverified] — bot DEVE propagar
(seedar chunk com "cap 9.25% [unverified]")
"Qual o cap do FlexLife?"
→ PASS: response inclui "esse valor está marcado como não-confirmado"
→ FAIL: response cita 9.25% como definitivo
```

#### Cenários funcionais

```bash
# Smoke
"O que é FlexLife?"
→ tool query_carrier_knowledge(question="O que é FlexLife", category_hint="product")
→ chunk 'flexlife' retornado, similarity ≥ 0.85

# UW médica
"Cliente diabético Type 2 controlado, dá pra fechar?"
→ tool query_carrier_knowledge(question="diabetes Type 2", category_hint="underwriting")
→ chunk 'medical-diabetes-type-2' retornado

# State-specific
"Pode vender FlexLife em NY?"
→ tool com state="NY"
→ chunk inclui state_specific=['NY'] OU mostra distinção NLIC vs LSW

# Foreign national
"Cliente brasileiro com green card, qual face máximo?"
→ tool category_hint="underwriting", subcategory hint via question
→ chunk 'foreign-national-tier-b' (Brasil é tier B)

# Replacement
"Cliente tem Term de 5 anos, quer trocar pra FlexLife — comissão?"
→ chunk do 104736 (Internal Exchange)
→ resposta: "term em 5 anos = full conversion; mas troca pra perm < 8 anos = redução"

# Tier 1 fallback (sem tool call)
"Quem é a National Life?"
→ Sparkbot responde do Tier 1 inline, sem tool call (overview já no prompt)

# No info
"Qual o cap do FlexLife em 2027?"
→ tool retorna 0 chunks (sem dado futuro)
→ Sparkbot: "não tenho info confiável; consulte Sales Desk 800-906-3310"

# Pitfall
"Posso usar US Pacesetter histórico na ilustração?"
→ chunk 'illustration-regulation' ou 'pitfalls'
→ resposta sinaliza lawsuit Virani + obriga "hypothetical/backtested"
```

### 11.2 Verificação de qualidade

Pra cada chunk autorado:
- ✅ `last_verified` ≤ 180 dias no momento da ingestão
- ✅ `source_doc_cat` preenchido se chunk veio de PDF
- ✅ `state_specific` preenchido se regra é state-specific
- ✅ corpo ≤ 4000 chars (validado no script)

### 11.3 Smoke test pós-deploy

Script `scripts/smoke-carrier-kb.sh` que:
1. Confere que `carrier_knowledge` tem ≥ 80 rows pra `national_life_group`
2. Confere que ≥ 95% têm `embedding NOT NULL`
3. Confere que `priority='always'` chunks somam ≤ 5KB
4. Faz 1 query via endpoint admin e verifica response shape

---

## 12. Rollback

Se ingestão estourar embedding budget OpenAI ou retornar respostas ruins em prod:

| Sintoma | Rollback |
|---|---|
| Sparkbot responde lentamente (>5s) | Disable Tier 1 injection (`carrierOverview = ""`); manter só tool. Reduz prompt size. |
| Tool retorna chunks irrelevantes | Subir `p_min_similarity` de 0.6 → 0.75 na função SQL. Bot vai dizer "no info" mais, mas evita alucinação. |
| Embedding budget estourou | Disable script ingestão; rodar manual com `--dry-run` pra contar custos. |
| Migração quebrou prod | `DROP TABLE carrier_knowledge`; remover tool do agregador via revert do commit. Sparkbot funciona sem KB. |

Migration é idempotente e isolada — `DROP TABLE` é safe (sem foreign keys de outras tabelas).

---

## 13. Observabilidade

Adições mínimas pra debugging:

### 13.1 Log estruturado em `query_carrier_knowledge`

Cada call loga:
```json
{
  "tool": "query_carrier_knowledge",
  "carrier": "national_life_group",
  "question_chars": 87,
  "category_hint": "underwriting",
  "state": "NY",
  "chunks_returned": 3,
  "top_similarity": 0.823,
  "duration_ms": 142
}
```

### 13.2 Métricas semanais

Job pg_cron weekly que loga em `assistant_alert_state` ou tabela nova `carrier_kb_metrics`:
- Top 10 queries do período (pra Pedro ver o que rep mais pergunta)
- Queries com 0 chunks (gaps no KB autoring)
- Queries com top_similarity < 0.7 (sinal de chunk fraco)

---

## 14. Anexos

### 14.1 Template de chunk MD

Salvar em `_planning/carriers/nlg/_template.md`:

```markdown
---
carrier: national_life_group
category: <overview|product|rider|underwriting|compliance|process|pitfall|resource|commission|workflow>
subcategory: <slug ou null>
slug: <kebab-case-único>
title: "Título amigável"
priority: <always|on_demand>
product_refs: []
state_specific: null
tags: []
applies_to_companies: [NLIC, LSW]
source: <official|imo|community|synthetic>
source_url: ""
source_doc_cat: ""
last_verified: 2026-04-28
---

Corpo do chunk em markdown — texto corrido, listas curtas com - prefixo
ou parágrafos. Idealmente <2KB, máximo 4KB. Foco no que rep precisa pra
responder ao cliente, não em prosa de marketing.

**Pontos críticos:**
- Item 1
- Item 2

**Quando NÃO usar:** ...
```

### 14.2 README pra autoring

`_planning/carriers/nlg/README.md`:

```markdown
# NLG Knowledge Base — Authoring Guide

## Como adicionar/editar chunks

1. Crie arquivo MD em `_planning/carriers/nlg/<categoria>/<slug>.md`
2. Use [_template.md](./_template.md) como base
3. Frontmatter obrigatório: carrier, category, slug, title, priority, source
4. Corpo: ≤4KB, markdown. Foco no que rep precisa.
5. Verifique `last_verified` é hoje (campo crítico — chunks >180d sem
   re-validação aparecem como "stale" no admin endpoint).
6. Rode `npm run ingest-kb -- --carrier=national_life_group --dry-run`
   pra ver se vai inserir/atualizar/skip
7. Quando OK, rode sem `--dry-run`. Output mostra ✓ inseridos.

## Convenções

- **slug**: kebab-case, único dentro de (category, subcategory). NÃO mude
  depois de criar — slug é parte da chave.
- **state_specific**: array com siglas se chunk só vale em certos estados;
  null se vale em todos.
- **product_refs**: slugs dos produtos referenciados (ex: ["flexlife"]).
- **last_verified**: ISO date YYYY-MM-DD. Quando você reabre o chunk pra
  validar, ATUALIZE essa data.
- **source_doc_cat**: catalog # do PDF NLG, ex: "62797(0126)".

## Tier 1 vs Tier 2

- **priority: always** — entra inline no system prompt do Sparkbot SEMPRE.
  Limite total: 5KB. Use SÓ pra:
    - Carrier overview (1 chunk)
    - NLIC vs LSW resumo (1 chunk)
    - Ratings + posição mercado (1 chunk)
    - Top-3 pitfalls críticos (1 chunk)
- **priority: on_demand** — vem só via tool query_carrier_knowledge. Use
  pra TODO o resto. Não tem limite de volume agregado.

Se Tier 1 passar de 5KB, ingestion warn no log e trunca — ajuste.

## Verificando o que tá no DB

```bash
curl -H "Cookie: <admin-session>" \
  https://spark-ai-platform.vercel.app/api/admin/carrier-kb?carrier=national_life_group
```
```

### 14.3 Checklist pré-deploy

```
[ ] Migration 00037 aplicada no Supabase
[ ] Migration 00038 (search function) aplicada
[ ] pgvector ON (CREATE EXTENSION ran successfully)
[ ] OPENAI_API_KEY presente em prod
[ ] Script ingest-kb roda sem erros em dry-run
[ ] Pelo menos 5 chunks NLG ingeridos (overview, FlexLife, EZ, NY Reg 187, pitfall)
[ ] Tool query_carrier_knowledge registrada no agregador
[ ] buildCarrierOverviewSection chamada no prompt-builder
[ ] System prompt inclui encorajamento de uso da tool
[ ] Synthetic test "o que é FlexLife" retorna chunk
[ ] Tier 1 inline ≤ 5KB
[ ] Endpoint admin acessível autenticado
[ ] Documentação em _planning/carriers/nlg/README.md
```

---

## 15. Open questions resolvidas (recap)

| Q | Resposta Pedro |
|---|---|
| 1. Multi-carrier ou só NLG? | Só NLG por enquanto (schema multi-carrier mantido) |
| 2. Sales agent agora? | Só Sparkbot. Cotação Tier A vira fase 4. |
| 3. Cotação automática? | Tier A heurística — fase 4. Tier C ForeSight não. |
| 4. PDFs gated? | Pedro forneceu 6 PDFs em ~/Downloads/NGL/ ✅ |
| 5. OpenAI key? | Mesma `OPENAI_API_KEY` ✅ |
| 6. pgvector? | Disponível, não habilitado — `CREATE EXTENSION` na migration ✅ |
| 7. Paralelizar fases? | Sequencial (Fase 1 dev → Fase 2 Pedro → Fase 3 dev) |
| 8. Foco IUL/Term/FlexLife? | Sim — ordem de autoring dá prioridade ✅ |

---

## 16. Próximos passos

Ordem proposta:

1. **Pedro aprova este plano** (revisão final).
2. **Eu** começo Fase 1: migrations + ingestion script + tool + integration. ~10h.
3. **Pedro** começa Fase 2 em paralelo: autora chunks IUL/Term/FlexLife primeiro (vou criar `_template.md` e README durante Fase 1).
4. Quando Fase 1 deploy estiver verde + 5 chunks dummy ingeridos, faz primeiros synthetic tests.
5. Pedro continua autorando; eu verifico cada batch via endpoint admin.
6. Fase 3: validação completa quando Pedro entregar ~50+ chunks.
7. Fase 4: cotação Tier A.
8. Fase 5 (opcional): UI polish.
