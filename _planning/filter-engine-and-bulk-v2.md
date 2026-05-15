# Filter Engine Universal + Bulk Messages V2 — Plano Arquitetural

> **Data:** 2026-05-15
> **Decision code (proposto):** H27 (Filter Engine) + H28 (Bulk V2)
> **Origem:** caso Gustavo Couto 2026-05-14/15 + diretriz Pedro 2026-05-15 ("foco em infraestrutura, não bloqueios")
> **Status:** PROPOSTA arquitetural. Substitui `bulk-message-segmented-plan.md` (mais tático).

---

## 0. Por que este plano existe

Pedro 2026-05-15:
> *"A gente vai ter que seguir por um caminho diferente porque esses problemas se correlacionam. Em geral, temos que pensar na estrutura como um todo, em vez de apenas buscar uma solução rápida. Precisamos focar na infraestrutura, resolver a raiz do problema e evitar apenas colocar bloqueios."*

O caso Gustavo (5 problemas distintos em uma única conversa) revelou que **a infra de filtragem do bot é fragmentada**:

- `search_contacts` só aceita query string genérica
- `list_opportunities` só ganhou stage filter ontem (commit `ba29fea`)
- `schedule_bulk_message` só aceita `filter_tag`
- `list_birthdays_today` é hardcoded para `dateOfBirth`
- `list_custom_fields`, `list_tags`, `list_users` listam mas ninguém consome programaticamente

Cada tool reimplementou paginação, validação, dedup. **Não há fonte única de verdade pra "dado o filtro X, devolva contatos / opps".**

Esse plano constrói essa fonte única — chamada **Filter Engine** — e refaz bulk messages em cima dela.

---

## 1. Visão arquitetural

```
┌─────────────────────────────────────────────────────────┐
│  LLM (Sparkbot)                                          │
└──┬───────────────────┬───────────────────┬──────────────┘
   │                   │                   │
   ▼                   ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ get_contacts │  │ get_opps     │  │ count_*      │
│  (FEL input) │  │  (FEL input) │  │  (FEL input) │
└──┬───────────┘  └──┬───────────┘  └──┬───────────┘
   │                 │                 │
   └────────┬────────┴─────────────────┘
            │ (FilterExpression)
            ▼
   ┌──────────────────────────────┐
   │   FILTER ENGINE (core)       │
   │  • Compila FEL → GHL calls   │
   │  • Resolve aliases (M0→stage)│
   │  • Pagina sem cap            │
   │  • Aplica filtros não-API    │
   │    client-side               │
   │  • Cache opcional por hash   │
   │  • Capability matrix         │
   └──────┬────────────┬──────────┘
          │            │
          ▼            ▼
   ┌──────────┐  ┌──────────────┐
   │ GHL API  │  │ Custom Field │
   │ V2 search│  │  resolver    │
   └──────────┘  └──────────────┘

CONSUMIDORES da Filter Engine:
─────────────────────────────────
• get_contacts_filtered   (tool nova — LLM puxa lista)
• get_opportunities_filtered (tool nova)
• count_filtered          (tool nova — pré-validação de bulk)
• schedule_bulk_message   (v2 — usa FEL ao invés de filter_tag string)
• schedule_bulk_messages_segmented (v2 — N segments × N templates)
• daily_briefing          (pull leads pra resumo matinal por critério)
• schedule_message_to_contact (futuro: agendar pra grupo)
• audit/admin signals     (futuro: "quantos M3 mudaram nas últimas 24h")
```

**Princípio central:** a Filter Engine é a ÚNICA forma de buscar lista de contatos/opps via filtros. Tools antigas (`search_contacts`, `list_opportunities`) continuam pra casos simples (query única), mas qualquer combinação multi-filtro passa pela engine.

---

## 2. Filter Expression Language (FEL)

### 2.1 Por que uma DSL própria

GHL POST `/contacts/search` aceita `filters: [{ field, operator, value }]` mas:
- Não suporta OR explícito (só AND implícito entre filters)
- Operators variam por tipo de campo (date vs string vs numeric — `eq` em `dateOfBirth` retorna 422)
- Custom fields têm IDs em vez de slugs
- Tags estão dentro de array → `contains`
- Capability matrix incompleta (algumas combinações não funcionam)

Uma DSL própria nos dá:
- AND/OR/NOT aninhado
- Aliases ("M3" → stage_id correto)
- Fallback automático (se GHL não suporta, fazemos client-side)
- Validação antes de bater na API (erro útil pro LLM)
- Versionável (V1 limitado, V2 com mais operators)

### 2.2 Schema FEL

```typescript
type FilterExpression =
  | { all: FilterExpression[] }     // AND (lógico) — todos verdadeiros
  | { any: FilterExpression[] }     // OR  — pelo menos um verdadeiro
  | { not: FilterExpression }       // NOT — inverte
  | FilterCondition;                // folha (condição atômica)

type FilterCondition = {
  field: FilterableField;          // ver lista 2.3
  op: FilterOp;                    // ver lista 2.4
  value: string | number | boolean | string[] | number[] | DateRange;
};

type FilterableField =
  // Standard contact fields
  | "firstName" | "lastName" | "fullName"
  | "email" | "phone"
  | "address1" | "city" | "state" | "postalCode" | "country"
  | "timezone" | "companyName" | "dateOfBirth" | "source"
  | "tags" | "assignedTo"
  | "dateAdded" | "dateUpdated" | "lastActivity"
  | "dnd"
  // Opportunity fields (joinados via contact_id)
  | "opportunity.pipelineId"
  | "opportunity.stageId"
  | "opportunity.stageName"          // alias resolve auto
  | "opportunity.status"             // open|won|lost|abandoned|all
  | "opportunity.monetaryValue"
  | "opportunity.assignedTo"
  | "opportunity.createdAt"
  | "opportunity.updatedAt"
  | "opportunity.lastStageChangeAt"
  // Custom fields
  | `customField.${string}`;        // ex: customField.aap_range, customField.cf_xyz123abc

type FilterOp =
  | "eq" | "neq"
  | "gt" | "gte" | "lt" | "lte"
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  | "in" | "not_in"
  | "exists" | "not_exists"
  | "between" | "before" | "after"
  | "date_eq" | "month_day_eq";    // helpers temporais

type DateRange = { from: string; to: string }; // ISO 8601
```

### 2.3 Aliases dinâmicos (LLM friendly)

O LLM raramente sabe `stage_id` UUID. Aliases são resolvidos na engine antes de compilar:

| Alias em FEL | Resolve via | Cache |
|---|---|---|
| `opportunity.stageName: "M3"` | `GET /opportunities/pipelines` → match case-insensitive partial | 10min in-memory |
| `tag: "boca raton"` | passa direto (GHL faz dedup case-insensitive) | n/a |
| `customField.aap_range` | `GET /locations/{id}/customFields` → match por `fieldKey` (slug) | 10min in-memory |
| `assignedTo: "self"` | resolveAssignedUserId helper (já existe) | n/a |
| `state: "FL"` | pass-through (GHL aceita 2-letter US states) | n/a |

Tudo configurável via `rep.profile.aliases` (também já existe, commit Gustavo): rep ensina "M2 = M2 dos 5 ao 20k", LLM resolve automaticamente.

### 2.4 Exemplo: caso Gustavo manhã

Rep diz: *"manda mensagem pros agentes em M0 com tag 'novo inscrito' E que ainda não foram contactados em 2026-05"*.

LLM gera FEL:
```json
{
  "all": [
    { "field": "opportunity.stageName", "op": "eq", "value": "M0" },
    { "field": "tags", "op": "contains", "value": "novo inscrito" },
    {
      "any": [
        { "field": "lastActivity", "op": "lt", "value": "2026-05-01" },
        { "field": "lastActivity", "op": "not_exists", "value": null }
      ]
    }
  ]
}
```

Engine compila:
1. Alias `stageName="M0"` → `stage_id=e1f57dee-...` (cache hit)
2. Verifica capability matrix:
   - `tags contains` → GHL aceita ✅
   - `opportunity.stageId` na busca de contatos → não suporta direto → JOIN client-side via list_opportunities + filter contact_ids
   - `lastActivity lt` → GHL aceita ✅
3. Otimiza chamadas:
   - Primeiro pull opps com `stageId=e1f57dee` (filtra server) → set de contact_ids A
   - Pull contacts com `tags contains "novo inscrito"` AND `(lastActivity lt 2026-05 OR not_exists)` → set B
   - Intersection: `A ∩ B`
4. Retorna lista deduplicada com paginação completa (sem cap arbitrário)

LLM recebe: `{ contacts: [...], total: 47, complete: true }`.

### 2.5 Capability matrix (versionada)

Tabela mantida em código (`filter-engine/capabilities.ts`), atualizada quando GHL libera filter novo:

| Field | GHL suporta? | Operators GHL | Fallback client-side |
|---|---|---|---|
| `tags` | ✅ | `contains`, `not_contains` | n/a |
| `firstName`, `lastName`, `email`, `phone` | ✅ | `eq`, `contains`, `starts_with` | n/a |
| `dateOfBirth` | ❌ (422 Invalid Operator) | nenhum | pull all + client filter (cap 5000) |
| `dateAdded`, `dateUpdated`, `lastActivity` | ✅ | `gt`, `gte`, `lt`, `lte`, `between` | n/a |
| `customField.*` | ✅ (parcial — só certos types) | depende do type do CF | client-side fallback |
| `opportunity.stageId` | ✅ (em `/opportunities/search`) | `eq` | JOIN via contact_ids |
| `opportunity.monetaryValue` | ✅ | `gt`, `lt` | n/a |
| `state`, `city`, `postalCode` | ✅ | `eq`, `contains` | n/a |
| `assignedTo` | ✅ | `eq` | n/a |
| `dnd` | ✅ | `eq` boolean | n/a |

Cada execução de FEL gera um **plan** logado em `metadata.plan` do tool_result — Pedro vê quais chamadas foram feitas. Útil pra debug + auditoria.

### 2.6 Sem cap (zero limites artificiais)

Pedro 2026-05-15:
> *"Não pode haver limite de chamadas."*

Engine pagina via `searchAfter` cursor até `complete=true`. **Único cap defensivo**: 50 páginas (5000 registros) por chamada FEL, configurável via env `FILTER_ENGINE_MAX_PAGES` (default 50). Se atingir, retorna `complete: false, hit_safety_cap: true` — bot avisa rep explicitamente *"puxei 5000, posso ter mais — quer filtrar mais específico?"*. Nunca silenciosamente.

Tempo de execução: típico 1-3 páginas (sub-segundo). Pior caso 50 páginas = ~10-15s. Bot informa progresso se >3s via tool_progress callback (futuro V2).

### 2.7 Cache

In-memory por process (não Redis V1):
- **Pipelines + stages**: TTL 10min (raramente mudam) — economiza 1 chamada por FEL com stageName
- **Custom field schemas**: TTL 10min — economiza 1 chamada por FEL com customField
- **Resultado de FEL**: TTL 60s, key = hash(rep_id + locationId + FEL JSON serializado) — útil pra repreview/disparo em sequência mas não pra rep que muda critério

---

## 3. Tools novas (consumidoras de FEL)

### 3.1 `get_contacts_filtered`

```ts
{
  name: "get_contacts_filtered",
  description:
    "Lista contatos via FEL (Filter Expression Language) com paginação completa e suporte a AND/OR/NOT, aliases (M0→stage), custom fields, opportunity joins. Use sempre que precisar de mais do que query simples — ex: 'contatos no M0 com tag boca raton', 'aniversariantes da semana', 'leads sem atividade há 30 dias'.",
  risk: "safe",
  parameters: {
    filter: FilterExpression,        // obrigatório
    fields?: string[],               // o que devolver (default: id+name+phone+tags+email)
    include_opportunity?: boolean,   // join com opp pra cada contato (útil pra ver stage)
    sort?: { field, direction },
    limit?: number,                  // soft cap pra LLM ver subset (não afeta total reportado)
  },
}
```

Return shape:
```json
{
  "contacts": [...],
  "total_returned": 47,
  "total_reported_by_ghl": 47,    // ground truth quando complete=true
  "complete": true,
  "pages_fetched": 1,
  "plan": ["search_v2 filters=[tag], opp_join via stageId"],
  "applied_aliases": { "M0": "e1f57dee-..." }
}
```

### 3.2 `get_opportunities_filtered`

Mesma estrutura mas para opps (já temos `list_opportunities` pós-Gustavo — refatorar pra usar engine internamente, mantendo schema atual como wrapper retrocompat).

### 3.3 `count_filtered`

```ts
{
  name: "count_filtered",
  description:
    "Conta quantos contatos/opps batem num FEL SEM puxar os dados. Use pra preview ANTES de bulk message ('quantos do M0 vão receber? 23'). Mais barato que get_contacts_filtered quando rep só quer número.",
  risk: "safe",
  parameters: {
    entity: "contacts" | "opportunities",
    filter: FilterExpression,
  },
}
```

Implementação: chama GHL search com `pageLimit: 1` + lê `meta.total`. 1 chamada, sub-segundo.

### 3.4 `describe_filter_capabilities`

```ts
{
  name: "describe_filter_capabilities",
  description:
    "Retorna lista de campos/operators que o Filter Engine suporta. Use quando rep pergunta 'dá pra filtrar por X?' ou bot quer validar FEL antes de chamar get_contacts_filtered.",
  risk: "safe",
  parameters: {},
}
```

Retorna o capability matrix (seção 2.5) + lista de custom_fields da location (via cache). Bot prompt instrui: *"se rep menciona filtro novo desconhecido, chame describe_filter_capabilities primeiro pra checar suporte"*.

---

## 4. Refactor das tools existentes

### 4.1 search_contacts (mantém schema, usa engine)

`search_contacts(query, tag, assigned_to_me, limit)` continua funcionando pra casos simples (1 critério, query string). Internamente passa a usar engine — compila pra FEL:

```ts
// Wrapper retrocompat
search_contacts({ tag: "boca raton" })
  → engine.compileAndRun({ field: "tags", op: "contains", value: "boca raton" })
```

Sem mudança de comportamento visível pro LLM. Garante consolidação no backend.

### 4.2 list_opportunities (idem)

Pós-commit Gustavo já tem `stage_name`/`stage_id`/paginação. Refatora pra delegar pra engine. Mantém schema.

### 4.3 list_birthdays_today (substituído)

Hoje canary-only (GHL não suporta `eq` em `dateOfBirth`). Engine usa **client-side fallback** automaticamente:

```ts
// FEL
{ field: "dateOfBirth", op: "month_day_eq", value: "05-15" }
```

Engine detecta no capability matrix que `dateOfBirth` não tem suporte GHL → pull all contacts (com paginação) → filter client-side pelo `MM-DD`. Limite defensivo: 5000 contatos (locations menores funcionam, grandes ganham warning).

Mantém tool `list_birthdays_today` como wrapper amigável que constrói o FEL.

### 4.4 Outras tools (futuro V2)

- `daily_briefing` ganha capacidade de "puxa leads do M0 que vieram nas últimas 24h" sem precisar de tool dedicada
- `schedule_message_to_contact` ganha versão `_bulk_to_filtered` que aceita FEL

---

## 5. Bulk Messages V2 (sobre a Filter Engine)

### 5.1 Mudanças no modelo de dados

**Tabela existente `bulk_message_jobs`** (migration 00050) — sem mudança:
- `filter_config jsonb` já é flexível — passa a guardar FEL serializado em vez de `{tag: X}`

**Tabela existente `bulk_message_recipients`** — adiciona 2 colunas (migration 00065):
- `segment_label text NULL` — qual segmento o contato pertence (multi-segment)
- `personalized_message text NULL` — texto final pós-interpolação (snapshot pra debug/audit)

### 5.2 Tools novas

#### `preview_bulk_message_v2`

```ts
{
  name: "preview_bulk_message_v2",
  description:
    "Preview de disparo em massa com FEL + risk disclaimer. Sempre chame ANTES de schedule_bulk_message_v2 pra mostrar pro rep: quantos contatos, ETA, exemplos, e RISCOS conforme tamanho.",
  risk: "safe",
  parameters: {
    segments: [
      {
        label?: string,                    // ex: "M0", "Prova Agendada"
        filter: FilterExpression,
        message_template: string,          // com {first_name}, {full_name}, {tags[0]}
        variation_mode?: "none"|"light"|"medium",
      }
    ],
    interval_seconds?: number,             // default 90, min 30, max 600
    jitter_seconds?: number,               // default 30
    delivery_channel?: "whatsapp_web_sms"|"whatsapp_api",
    start_at?: string,
    interleave_segments?: boolean,         // default false (sequencial por segment)
    dedup_across_segments?: boolean,       // default true (contato em 2 segments → recebe só do primeiro)
  },
}
```

Return:
```json
{
  "segments": [
    { "label": "M0", "count": 23, "examples": [...], "filter_explanation": "Stage M0 (resolved e1f57dee...)" },
    { "label": "M3", "count": 6, "examples": [...] }
  ],
  "total_contacts": 29,
  "deduped_count": 27,
  "total_after_dedup": 27,
  "eta_minutes": 42,
  "estimated_completion_at": "2026-05-15T16:30:00-04:00",
  "daily_cap_remaining": 100,
  "would_exceed_cap": false,
  "risk_level": "low" | "medium" | "high",
  "disclaimers": [
    "lista_quente_required",                // sempre
    "risk_disclaimer_required"               // se total > 20
  ]
}
```

#### `schedule_bulk_message_v2`

Mesma assinatura do preview + flags de aceite:
- `confirmed_by_rep: true` (gate H8)
- `confirmed_warm_list: true` (rep confirmou que é "lista quente" — pessoas que já interagiram)
- `confirmed_risk: true` (só required se `total_contacts > 20`)

Engine validates ANTES de criar job. Se aceites faltam, retorna `status:error` com mensagem explicativa pro bot encadear confirmações.

### 5.3 Sistema de disclaimers tier

Toda execução de `preview_bulk_message_v2` retorna disclaimers obrigatórios. Bot DEVE ler e expor pro rep ANTES de pedir confirmação. Configurado em `filter-engine/disclaimers.ts`:

```typescript
const DISCLAIMERS = {
  lista_quente_required: {
    threshold: { min_contacts: 1 },          // sempre
    required_flag: "confirmed_warm_list",
    text: "⚠️ Disparo via WhatsApp Web/SMS só é seguro pra LISTAS QUENTES — pessoas que já te mandaram mensagem ou interagiram antes. Disparar pra desconhecidos = denúncia → ban do número. Você confirma que esses contatos já interagiram com você?",
  },
  risk_disclaimer_required: {
    threshold: { min_contacts: 21 },          // > 20
    required_flag: "confirmed_risk",
    text: "⚠️ Você está prestes a disparar pra {N} contatos. Acima de 20 envios aumenta significativamente o risco de bloqueio do WhatsApp se algum reportar. Recomendação: pequenos batches de 10-20 espalhados por horas. Você entende o risco e quer prosseguir?",
  },
  // futuro V2:
  // high_volume_disclaimer (>100)
  // cross_segment_template_diff (segments com templates muito diferentes — risco de inconsistência)
};
```

Bot é instruído via prompt-builder a **sempre** ler `disclaimers[]` do preview e exibir cada um separadamente, pedindo confirmação textual antes de avançar.

### 5.4 Personalização com interpolação rica

Template suporta:
- `{first_name}` — primeiro nome (mais comum)
- `{full_name}` — nome completo
- `{tags[0]}`, `{tags[i]}` — tag de índice i
- `{custom.field_key}` — valor de custom field (resolve via cache)
- `{opportunity.stage_name}` — pegar nome do stage da opp ativa do contato
- `{opportunity.value}` — valor monetário

Engine valida template antes de disparar — se referencia field não-existente OU contato não tem o valor, fallback configurável:
- `strict` (default): rejeita o contato (warning no preview)
- `empty_string`: substitui por ""
- `placeholder`: substitui por "[sem dado]"

Variator (Haiku) continua aplicável (já existe) — varia frases pra evitar pattern detection. Aplica após interpolação.

### 5.5 Multi-segment (caso Gustavo manhã)

```ts
preview_bulk_message_v2({
  segments: [
    {
      label: "Prova Agendada (lembrete promo)",
      filter: { field: "opportunity.stageName", op: "eq", value: "Prova Agendada" },
      message_template: "Bom dia {first_name}, último dia pra garantir ingresso da convenção...",
    },
    {
      label: "M0 (motivacional início)",
      filter: { field: "opportunity.stageName", op: "eq", value: "M0" },
      message_template: "Oi {first_name}! Bem-vinda à academia. Hoje tem evento...",
    },
  ],
  dedup_across_segments: true,
  interleave_segments: false,
  interval_seconds: 90,
})
```

Preview retorna 2 segments com counts próprios. Bot apresenta:
```
Segmento 1: Prova Agendada — 11 contatos
Segmento 2: M0 — 23 contatos
Total: 34 (sem overlap)
ETA: ~51 minutos
⚠️ Acima de 20 — confirma o risco?
⚠️ É lista quente (pessoas que interagiram)?
```

Após confirmações → `schedule_bulk_message_v2` cria 1 job com 34 recipients, cada um com `segment_label` setado e `personalized_message` final.

### 5.6 Recipients individualmente identificáveis pra retry/audit

Cada `bulk_message_recipients` row tem:
- `contact_id`, `phone`, `name`
- `segment_label`
- `personalized_message` (texto exato que será/foi enviado)
- `scheduled_at`
- `status`: pending|sent|failed|skipped
- `error_message` (se failed)
- `ghl_message_id` (se sent — link audit pra GHL)

Pedro pode reviewar no Supabase Studio o que cada contato recebeu. Útil pra debug de complaint ("você mandou X pro João?" → SELECT direto).

---

## 6. Mudanças no prompt-builder

Adicionar seção dedicada `# FILTER ENGINE — INFRA NOVA (2026-05-15)`:

1. **Sempre que rep menciona múltiplos critérios** ("M0 com tag X", "leads sem atividade que estão no M3", "tudo que faz aniversário no mês"), use `get_contacts_filtered` com FEL — NÃO encadeie 3 search_contacts.

2. **Aliases automáticos**: rep falar "M3" / "boca raton" / "novo inscrito" / nomes de stages/tags — Engine resolve. Bot não precisa list_pipelines antes.

3. **Antes de bulk message**: SEMPRE chame `count_filtered` ou `preview_bulk_message_v2` primeiro. NUNCA promete "vou mandar pra X pessoas" sem ter contado.

4. **Disclaimers**: leia `disclaimers[]` do preview e EXIBA cada um separadamente. Pedir confirmação textual. **NUNCA** mascarar disclaimers.

5. **Capability discovery**: rep pergunta "dá pra filtrar por X?" → chame `describe_filter_capabilities`. Se field não suportado, explique a limitação E ofereça workaround (custom field manual, etc).

6. **Anti-hallucination herdado**: a regra geral do commit `993970e` continua valendo. Detector pega "mandei 11 mensagens" sem schedule_bulk_message_v2 chamada.

---

## 7. Camada de logs/audit

Cada execução de FEL gera um audit row em tabela nova `filter_executions` (migration 00065):

```sql
CREATE TABLE filter_executions (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references rep_identities(id),
  agent_id uuid references agents(id),
  location_id text not null,
  entity text not null,                -- 'contacts' | 'opportunities'
  fel_input jsonb not null,            -- FEL completo
  ghl_calls_made integer not null,
  pages_fetched integer not null,
  total_returned integer not null,
  total_reported_by_ghl integer,
  client_side_filter_applied boolean default false,
  hit_safety_cap boolean default false,
  duration_ms integer not null,
  consumer_tool text,                  -- 'get_contacts_filtered' | 'schedule_bulk_message_v2' | etc
  created_at timestamptz default now()
);

CREATE INDEX idx_filter_executions_rep_created ON filter_executions (rep_id, created_at DESC);
```

Útil pra:
- Debug: "por que filtro X devolveu 47 contatos?" → busca o row, vê plan
- Performance: queries lentas (> 5s) → otimização da engine
- Detecção de uso anormal: rep fazendo 50 filtros/min = bot bugado
- Billing futuro (chamadas GHL extras se cap exceder)

---

## 8. Ordem de implementação proposta

| Fase | Escopo | Effort | Pré-requisito |
|---|---|---|---|
| **F0** | Capability matrix doc + tests empíricos (descobre o que GHL aceita REALMENTE) | 2h | nenhum |
| **F1** | Core Filter Engine: FEL types + compiler + paginação + aliases + cache + audit log | 8h | F0 |
| **F2** | Tools novas: `get_contacts_filtered`, `get_opportunities_filtered`, `count_filtered`, `describe_filter_capabilities` | 4h | F1 |
| **F3** | Refactor tools existentes pra usar engine (search_contacts, list_opportunities, list_birthdays_today) — wrappers retrocompat | 3h | F2 |
| **F4** | Migration 00065 (segment_label + personalized_message em recipients + filter_executions table) | 1h | nenhum (paralelo) |
| **F5** | Disclaimers tier system + interpolação rica (`{custom.x}`, `{opportunity.stage_name}`) | 3h | F1 |
| **F6** | `preview_bulk_message_v2` + `schedule_bulk_message_v2` (multi-segment + dedup + disclaimers) | 6h | F1+F4+F5 |
| **F7** | Prompt-builder updates (seção FILTER ENGINE) | 1h | F2+F6 |
| **F8** | Smoke tests: 20 cenários (FEL básico, AND/OR, custom fields, multi-segment, disclaimers, dedup, ...) | 4h | F6 |
| **F9** | Documentação `docs/FILTER_ENGINE.md` + entrada `H27/H28` em DECISIONS.md | 1h | F8 |

**Total: ~33h efetivas dev.** Realista 1 semana ininterrupta OU 2 semanas part-time.

Pode quebrar em **3 PRs grandes**:
- **PR1 (F0-F3, 17h)**: Filter Engine core + tools + refactor — útil sozinho mesmo sem bulk V2
- **PR2 (F4-F6, 10h)**: Bulk V2 sobre engine — feature do Gustavo entregue
- **PR3 (F7-F9, 6h)**: Prompt + tests + docs

---

## 9. Riscos / pontos abertos

### R1: GHL capability matrix incompleta
Não temos lista oficial de operators × fields. Estratégia: F0 roda probe empírico (sanity test contra location real do Gustavo) e documenta o que GHL aceita HOJE. Capability matrix vira documento vivo.

### R2: Performance de client-side fallback
Filtro em campo não-suportado pelo GHL (ex: `dateOfBirth`) força pull all contacts. Locations com >5000 contatos vão sentir. Mitigação:
- Hard cap em 5000 client-side pull
- Pre-filter por outros critérios (ex: tag + dateOfBirth) — tag reduz set ANTES do client-side
- Cache resultado por 60s

### R3: LLM gera FEL inválido
JSON Schema valida estrutura, mas semântica (campo correto, operator compatível com tipo) cabe ao validator. Estratégia: validator retorna erro específico (`"date_eq não suporta operator eq em dateOfBirth — use month_day_eq"`) — bot corrige.

### R4: Custom field IDs vs slugs
GHL retorna custom fields com `id` (UUID) e `fieldKey` (slug human-friendly). LLM pode passar ambos. Engine aceita `customField.{fieldKey}` E `customField.{id}` — resolve via cache.

### R5: Backward compat
`schedule_bulk_message` legacy (filter_tag) **continua funcionando** mesmo após F6. Bot lê o catálogo e prefere V2 quando user pede mais de 1 critério ou multi-segment.

### R6: Tamanho do FEL no contexto do LLM
JSON pode ficar grande pra filtros complexos. Compensação: bot só gera FEL via prompt — não precisa MEMORIZAR sintaxe completa, schema da tool é o guia.

### R7: Edge: rep usa Smart Lists do GHL diretamente
Smart Lists do app GHL têm UI própria de filtros. Bot **não substitui** isso — só dá acesso programático via API. Se rep quer salvar uma Smart List, ainda usa app GHL.

---

## 10. Pontos abertos pra Pedro decidir antes de começar

1. **Audit table `filter_executions`**: ok com nova tabela ou prefere reusar metadata em `sparkbot_messages.metadata.filter_plan`?
2. **Cap defensivo 5000**: ok ou Pedro prefere outro número (3000, 10000, ilimitado)?
3. **Disclaimers**: lista quente disclaimer aparece SEMPRE ou só >5 contatos? Risk disclaimer em >20 ou em outro threshold?
4. **Ordem PRs**: F0→F1→F2 (engine primeiro) ou F4→F6 (bulk V2 com tag legacy + engine como follow-up)?
5. **Custom field resolve por slug ou ID**: ambos OK ou padronizar em slug (mais legível pro LLM)?
6. **Cache TTL pipelines/custom fields**: 10min ok ou prefere maior (30min) / menor (5min)?
7. **Backward compat**: deprecar `schedule_bulk_message` legacy em 30 dias ou manter pra sempre?

---

## 11. Conexão com problemas anteriores do Gustavo (resolvidos pela infra)

| Problema Gustavo | Causa raiz | Resolve por |
|---|---|---|
| "Bot truncou em 20" tag list | search_contacts sem paginação | F1 (engine paginação ilimitada) + F3 (search_contacts → engine) |
| "Bot só vê 100 opps" | list_opportunities sem paginação | F1 + F3 |
| "Bot mentiu M3=3 quando era 6" | confiança falsa em dado truncado | F1 retorna `complete: true/false` + LLM prompt anti-confiança falsa (já implementado) |
| "Não consigo bulk por stage" | filter_tag only | F6 (multi-filter via FEL) |
| "Quero msg diferente por stage" | single template | F6 (multi-segment) |
| "Bot mandou 4 de 11, parou meio" | MAX_ITERATIONS limit + tool em loop | F6 (1 schedule_bulk_message_v2 call → backend dispara 11 via cron) — bot NÃO loop |
| "Bot mentiu 'não executei nada'" | hallucination inversa | Plano separado (commit 993970e + extensão pra detector inverso futuro) |
| "Adicionou tag em 4, esqueceu" | bot tentou workaround tag manual | F6 elimina necessidade — filtra por stage nativamente |

A infra é a resposta arquitetural pra TODOS esses casos. Nada de bandage.

---

## 12. Decision codes propostos

- **H27** — Filter Engine universal (FEL + compiler + 4 tools novas + audit + cache). Substitui search_contacts/list_opportunities legacy via wrapper retrocompat. Capability matrix versionado.
- **H28** — Bulk Messages V2 sobre Filter Engine. Multi-segment + disclaimers tier + interpolação rica + recipients audit.

Entradas em `docs/DECISIONS.md` no merge de cada PR.
