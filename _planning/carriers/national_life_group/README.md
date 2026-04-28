# NLG Knowledge Base — Authoring Guide

Conhecimento estruturado sobre a National Life Group consumido pelo Sparkbot
via tool `query_carrier_knowledge` (RAG com pgvector). Plano completo em
[`../../nlg-kb-implementation-plan.md`](../../nlg-kb-implementation-plan.md).

---

## Como adicionar / editar chunks

1. Crie arquivo `<categoria>/<slug>.md` (ou direto na raiz pra Tier 1).
2. Use [`_template.md`](./_template.md) como base — copie e renomeie.
3. **Frontmatter obrigatório:** `carrier`, `category`, `slug`, `title`,
   `priority`, `source`. Validados pelo script — falha rápido se faltar.
4. Corpo: ≤4KB, markdown. Foco no que rep precisa, não prosa.
5. Atualize `last_verified` (ISO date YYYY-MM-DD) sempre que reabrir pra revisar.
6. Dry-run primeiro:
   ```bash
   npm run ingest-kb -- --carrier=national_life_group --dry-run
   ```
7. Quando OK, sem `--dry-run`. Output mostra ✓ inseridos / ↻ atualizados /
   ≡ só metadata / — skipped (dry-run) / ✗ erros.

## Re-embed forçado

Se OpenAI atualizar embedding model:

```bash
npm run ingest-kb -- --carrier=national_life_group --force-embed
```

## Convenções de naming

- **`slug`**: kebab-case, único dentro de `(category, subcategory)`. **NÃO
  mude depois de criar** — slug é parte da chave de upsert. Se mudar slug =
  duplica chunk no DB.
- **`category`**: uma das 10 enumeradas no schema:
  - `overview` — chunks Tier 1 (priority='always')
  - `product` — produtos (FlexLife, PeakLife, Term, etc)
  - `rider` — riders (ABR, LIBR, Alzheimer, etc)
  - `underwriting` — UW guidelines (rate classes, build, medical)
  - `compliance` — Reg 187, illustration regs, AML
  - `process` — eApp, iGo, ForeSight, e-delivery
  - `pitfall` — erros comuns / lawsuit context
  - `resource` — agent portal, training, mobile app
  - `commission` — internal exchange rules, commission policy
  - `workflow` — sales workflow geral
- **`subcategory`**: opcional, kebab-case. Use pra distinguir variantes:
  `iul`, `term`, `wl`, `medical:diabetes`, `state:NY`.
- **`product_refs`**: lista de slugs de produto que o chunk referencia. Permite
  consultas tipo "quais chunks falam de FlexLife?".
- **`state_specific`**: array com siglas se chunk só vale em certos estados
  (`['NY']`); null se vale em todos. Sparkbot identifica state mismatch.
- **`source_doc_cat`**: catalog # do PDF NLG (ex: `62797(0126)`). Sparkbot
  cita: "fonte: NLG Cat 62797, validado em 04/2026".

## Tier 1 vs Tier 2 — REGRA DE OURO

- **`priority: always` (Tier 1)** — chunk entra inline no system prompt do
  Sparkbot **SEMPRE**. Limite total agregado: **5KB**. Use SÓ para:
  1. Carrier overview (NLIC vs LSW + lista de produtos top)
  2. Ratings + posição mercado (curto)
  3. Pitfalls críticos (US Pacesetter lawsuit, NY/LSW)
  4. Companies summary (1 chunk descrevendo as duas subsidiárias)

  Se Tier 1 passar de 5KB, ingestion warn no log e **trunca**. Reduza
  conteúdo ou mova chunks pra `on_demand`.

- **`priority: on_demand` (Tier 2)** — chunk só vem via tool
  `query_carrier_knowledge`. Use pra **TODO o resto** (95% dos chunks).
  Sem limite agregado.

## Marcadores de incerteza — CRÍTICO

Quando você não tem certeza de um valor, **marque explicitamente** no corpo
com `[unverified]`. Sparkbot é instruído a propagar a marca:

```markdown
Cap rate atual: 9.25% [unverified — Cap Update Set/2025 não disponível]
```

Vira na resposta do bot:

> "Cap atual é aproximadamente 9.25% — esse valor está marcado como
> não-confirmado na nossa base; valide no portal antes de cotar."

Isso é **muito melhor** que omitir o número (rep não tem nada) ou afirmar
sem cuidado (rep cota errado).

## Verificando o que tá no DB

```bash
# Via endpoint admin (autenticado)
curl -H "Cookie: <admin-session>" \
  https://spark-ai-platform.vercel.app/api/admin/carrier-kb?carrier=national_life_group | jq

# Métricas inclusas: total, tier1, tier2, stale (>180d sem validar), no_embedding
```

## Estrutura de pastas atual

```
.
├── README.md                       (este arquivo)
├── _template.md                    (template — copie pra criar chunks)
├── raw/                            (PDFs extraídos — NÃO ingeridos)
│   ├── 62797.txt                   UW Guide
│   ├── 104736.txt                  Internal Exchange Rules
│   ├── 53732.txt                   Annuity Commission
│   ├── 103418.txt                  FN Tax Planning (Eng)
│   └── 50038.txt                   FN Questionnaire
│
├── overview.md                     (Tier 1)
├── nlic-vs-lsw.md                  (Tier 1)
├── ratings.md                      (Tier 1)
├── critical-pitfalls.md            (Tier 1)
│
├── products/
│   ├── iul/
│   │   ├── flexlife.md
│   │   ├── peaklife.md
│   │   ├── summitlife.md
│   │   ├── survivorlife.md
│   │   └── rapidprotect.md
│   ├── wl/
│   │   ├── totalsecure.md
│   │   └── basicsecure.md
│   ├── term/
│   │   └── term-lsw-and-nl.md
│   └── annuity/
│       └── ...
│
├── riders/
│   ├── abr-set.md
│   ├── libr.md
│   ├── alzheimers.md
│   ├── fertility-journey.md
│   └── overloan-protection.md
│
├── underwriting/
│   ├── rate-classes.md
│   ├── build-chart-permanent.md
│   ├── build-chart-term.md
│   ├── ez-underwriting.md
│   ├── rapidprotect-simplified.md
│   ├── medical-conditions/
│   │   ├── diabetes.md
│   │   ├── hypertension.md
│   │   └── ...
│   └── financial-uw.md
│
├── foreign-national/
│   ├── overview.md
│   ├── countries-tier-a.md
│   ├── countries-tier-b.md
│   ├── premium-financing.md
│   └── tax-planning.md
│
├── compliance/
│   ├── ny-reg-187.md
│   └── illustration-regulation.md
│
└── replacement/
    ├── internal-exchange-rules.md
    ├── 1035-exchange-basis.md
    └── surrender-charge-waiver.md
```

## Quando re-rodar ingestion

- Após criar chunk novo: roda script
- Após editar chunk existente: roda script (content_hash detecta mudança)
- Após apenas mudar metadata (frontmatter sem mudar corpo): roda script
  (atualiza row sem re-embed; é barato)
- Re-embed em massa só com `--force-embed` (ex: novo modelo OpenAI)
