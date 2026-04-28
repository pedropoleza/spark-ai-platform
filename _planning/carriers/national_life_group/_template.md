---
# Identificação (snake_case nas chaves; kebab-case no slug)
carrier: national_life_group
category: <overview|product|rider|underwriting|compliance|process|pitfall|resource|commission|workflow>
subcategory: <slug-curto-ou-null>
slug: <kebab-case-único-dentro-de-category>
title: "Título amigável (com aspas)"

# Tier de injeção
# always = inline no system prompt SEMPRE (Tier 1, limite 5KB total agregado)
# on_demand = só vem via tool query_carrier_knowledge (Tier 2 RAG)
priority: on_demand

# Metadata estruturada (todos opcionais)
product_refs: []                # ['flexlife', 'peaklife'] — slugs de produto referenciados
state_specific: null            # ['NY'] OU null se vale em todos os estados
tags: []                        # ['libr', 'income-rider', '60+']
applies_to_companies: [NLIC, LSW]  # subsidiárias que emitem

# Sourcing & verificação
source: official                # official | imo | community | synthetic
source_url: ""                  # URL pública se houver
source_doc_cat: ""              # catalog # do PDF NLG (ex: "62797(0126)")
last_verified: 2026-04-28       # ISO date — atualize quando re-validar
---

Corpo do chunk em markdown — texto corrido, listas curtas com `- ` ou
parágrafos. Idealmente <2KB, máximo 4KB (script falha acima disso).

Foco no que rep precisa pra responder ao cliente, não em prosa de marketing.

**Pontos críticos:**

- Item 1
- Item 2

**Quando NÃO usar / pitfalls:**

- Cenário X → não fit

**Marcadores de incerteza:**

Se algum dado não foi confirmado pelo PDF oficial, marque `[unverified]`
no corpo. Ex: "cap rate 9.25% [unverified — confirme cap update]". O
Sparkbot é instruído a propagar essa marca pra rep.
