# B1 — Arquitetura & Fronteiras

> Agente B1 da auditoria enterprise do SparkBot (Fase 2, READ-ONLY). Itens 2.a/2.b
> do review: "a arquitetura está devidamente separada? cada coisa no seu lugar?"
> Toda afirmação ancorada em `arquivo:linha` ou commit. PT-BR.

---

## 1. RESUMO EXECUTIVO

**Veredito "arquitetura devidamente separada": 6,5 / 10.**

A arquitetura tem **ossatura boa e propositada** — os dois pipelines (sales/recruitment
via fila × SparkBot via webhook direto) são genuinamente distintos e não se misturam;
os subdomínios novos (`filter-engine/`, `followup/`) são leaf modules limpos, dependendo
só de `supabase/admin` + `ghl/client`; o `proactive/` reusa o núcleo por uma ponte única
(`dispatcher.ts`). Não há **nenhuma dependência circular**. A camada GHL tem um cliente
central (`GHLClient`) com retry/refresh/sanitização decentes.

Mas a separação **quebra em pontos estruturais sérios**, todos sintoma da regra de ouro do
projeto ("velocidade > rigor"): (a) **zero camada de repositório** — 158 chamadas cruas a
`createAdminClient()` espalhadas, com nomes de tabela/coluna hardcoded em ~34 arquivos de
`account-assistant/`; (b) **fronteira GHL vazada** — 42 chamadas diretas a
`ctx.ghlClient.{get,post,put,delete}` em 8 arquivos de tools, furando a `operations.ts` que
foi criada exatamente pra centralizar isso; (c) **multi-tenant meio-feito** — o webhook é
multi-hub (via DB), mas crons/proativo/UI admin/uma tool ainda dependem da env legada
`ASSISTANT_HUB_LOCATION_ID` (single-hub); (d) **dois arquivos `processor.ts` + dois
`prompt-builder.ts`** com mesmo nome em pastas diferentes (colisão cognitiva); (e) **escopo
de token OAuth mora FORA do código** — `scope` é persistido mas nunca lido/validado, o que é
a raiz estrutural dos P0/P1 `delete_appointment`/`get_contact_notes`.

### Os 5 problemas estruturais mais graves

| # | Problema | Evidência | Sev |
|---|----------|-----------|-----|
| 1 | **Sem camada de repositório/data-access.** Supabase cru em todo lugar (158× `createAdminClient()`); webhook-handler.ts mistura transporte + dedup + billing + persistência + envio. | `grep createAdminClient()` = 158 hits; `webhook-handler.ts` 1.052 LOC faz tudo | P0-arq |
| 2 | **Escopo/IAM de token é invisível ao código.** `scope` salvo em `Token Refresher` (token-refresher.ts:132,215) mas nunca lido. Nenhuma validação de escopo por location/recurso. Causa raiz de `delete_appointment` (IAM) e `get_contact_notes` (403). | token-refresher.ts:132; `grep scope` não acha leitura; tools são thin wrappers (notes.ts, calendar.ts:1344) | P0-arq |
| 3 | **Fronteira GHL vazada.** 42 chamadas diretas `ctx.ghlClient.*` em 8 tool files, ignorando `operations.ts` (cujo header diz que existe pra centralizar isso). | operations.ts:1-15; 42 hits em tools/ | P1 |
| 4 | **Multi-tenant inconsistente.** Webhook usa `isSparkbotHub()` (DB), mas `ASSISTANT_HUB_LOCATION_ID` (single-hub legado) ainda é load-bearing em proactive runners, admin routes e numa tool. | route.ts:30-53 (DB) vs reminder-runner.ts:169, tools/followup.ts:449, agents/sparkbot/route.ts:21 | P1 |
| 5 | **Orquestração LLM duplicada** entre `processor.ts` (inbound) e `proactive/dispatcher.ts` (proativo) — mesmo loop runWithTools+tools+prompt copiado. | processor.ts:702-716 ≈ dispatcher.ts:24-26 + corpo | P2 |

---

## 2. DIAGRAMA DOS DOIS PIPELINES

Confirmado lendo o código: **um único endpoint HTTP** (`/api/webhooks/inbound-message`)
bifurca em dois pipelines totalmente distintos a partir de `isSparkbotHub(locationId)`
(route.ts:186).

```
                    ┌─────────────────────────────────────────────────────┐
                    │  POST /api/webhooks/inbound-message/route.ts          │
                    │  (HMAC signature · rate-limit · parse · isRealMessage)│
                    │  route.ts:60-202                                      │
                    └───────────────┬─────────────────────────────────────┘
                                    │
                       isSparkbotHub(locationId)?  ── route.ts:186
                       (query agents WHERE type=account_assistant, cache 5min)
                          │                                  │
                  SIM (SparkBot)                      NÃO (sales/recruitment)
                          │                                  │
   ┌──────────────────────▼─────────────────┐   ┌────────────▼───────────────────────┐
   │ PIPELINE 2 — SparkBot (webhook direto)  │   │ PIPELINE 1 — Sales/Recruitment (fila)│
   │ waitUntil(handleAssistantInbound)       │   │ STOP/handoff/targeting/working-hours │
   │ route.ts:187-201                        │   │ → INSERT message_queue (debounce)    │
   ├─────────────────────────────────────────┤   │ route.ts:204-637                     │
   │ webhook-handler.ts (1.052 LOC):         │   ├──────────────────────────────────────┤
   │  • 7 camadas de dedup (mutex/SELECT/    │   │ waitUntil(sleep+processMessageQueue) │
   │    locks/content/timing/UNIQUE)         │   │   ── OU cron Vercel diário           │
   │  • identifyRep(phone)  (identity.ts)    │   │   /api/cron/process-queue (vercel.json)│
   │  • extractRepInput → audio/img/doc/CSV  │   ├──────────────────────────────────────┤
   │    (ai/audio-transcriber, media-extr.,  │   │ queue/processor.ts (40K):            │
   │     file-processor)                     │   │  • reaper + atomic claim (UPDATE..    │
   │  • billing Whisper (billing/charge)     │   │    RETURNING, LIMIT 100)             │
   │  • load history (sparkbot_messages)     │   │  • compressHistory (ai/history-comp.)│
   └───────────────┬─────────────────────────┘   │  • processWithAI (ai/openai-client)  │
                   │                               │  • buildSystemPrompt (AI/prompt-bld) │
   ┌───────────────▼─────────────────────────┐   │  • executeActions (ai/action-executor)│
   │ processor.ts (939 LOC):                 │   │  • scheduleFollowUps, summary-note   │
   │  • terms gate · active_location resolve │   └────────────┬─────────────────────────┘
   │  • buildSparkbotSystemPrompt (86K!)     │                │
   │  • runWithTools (llm-client.ts 639)     │   ┌────────────▼─────────────────────────┐
   │     Claude Sonnet→Haiku→GPT-4.1 loop    │   │ ai/action-executor.ts → GHLClient     │
   │  • executeTool × N (tools/ 22 files)    │   │ (add_tag, send_message, etc.)         │
   │  • detectHallucination (post-hoc)       │   └────────────┬─────────────────────────┘
   │  • billing turn (billing/charge)        │                │
   └───────────────┬─────────────────────────┘                ▼
                   │                                  GHLClient → CRM (Spark Leads)
   ┌───────────────▼─────────────────────────┐
   │ sendResponseToRep → GHLClient            │
   │  /conversations/messages (SMS→WhatsApp)  │   ── webhook-handler.ts:1001-1052
   └──────────────────────────────────────────┘

  PROATIVO (3º vetor, paralelo):  pg_cron 'sparkbot-proactive' @30s
  (migration 00032) → net.http_post → /api/cron/sparkbot-proactive
  → proactive/dispatcher.ts → (reusa runWithTools + tools + prompt-builder do núcleo)
  → reminder-runner / bulk-message-runner / followup-runner / daily-briefing
```

**Camadas dos dois fluxos** — separação real:

| Camada | Pipeline 1 (queue) | Pipeline 2 (SparkBot) |
|--------|--------------------|-----------------------|
| (a) Transporte | `route.ts` (compartilhado) | `route.ts` + `webhook-handler.ts` |
| (b) Orquestração/LLM | `ai/openai-client`, `ai/prompt-builder` | `llm-client`, `account-assistant/prompt-builder` |
| (c) Tools/domínio | `ai/action-executor` (ações inline) | `tools/` (22 arquivos, registry) |
| (d) Integração externa | `ghl/client` + `supabase/admin` | `ghl/client` + `supabase/admin` |
| (e) Cron/proativo | Vercel cron diário | pg_cron @30s + `proactive/` (17 arq.) |

Os dois pipelines **não compartilham** orquestração nem prompt nem tools — só compartilham
a infra de baixo nível (`ghl/`, `supabase/`, `billing/`). Isso é correto e proposital.

---

## 3. MAPA DE DEPENDÊNCIAS ENTRE MÓDULOS

### Quem depende de quem (em `src/lib/`)

```
        ┌───────────────────────────────────────────────────────┐
        │                  CONSUMIDORES (alto nível)             │
        │                                                        │
        │  account-assistant/  ──┐         queue/  ──┐           │
        │  (núcleo SparkBot)     │         (sales)   │           │
        │      │  │  │  │        │            │      │           │
        │      │  │  │  └─ proactive/         │      │           │
        │      │  │  └──── followup/          │      │           │
        │      │  └─────── filter-engine/     │      │           │
        │      │          conversational/     │      │           │
        │      ▼                              ▼      ▼           │
        └──────┼──────────────┬───────────────┼──────┼──────────┘
               │              │               │      │
       ┌───────▼───┐   ┌──────▼─────┐   ┌─────▼──┐  ┌▼────────┐
       │ ai/       │   │ billing/   │   │ ghl/   │  │supabase/│
       │ (transcr, │   │ (charge,   │   │ (auth, │  │(admin,  │
       │  media,   │   │  pricing)  │   │ client,│  │ client) │
       │  prompt)  │   │            │   │ ops,   │  │         │
       └───────────┘   └────────────┘   │ refr.) │  └─────────┘
                                        └────────┘   admin-signals/ (folha)
                                                     auth/ (folha)
```

Contagem de importadores (medida via grep, números abaixo):
- `@/lib/ghl`: account-assistant **21**, queue 3, ai 2, billing 1, auth 1.
- `@/lib/billing`: importado por AMBOS pipelines (`queue/processor`, `ai/history-compressor`)
  e SparkBot (`processor`, `webhook-handler`, `proactive/dispatcher`). Compartilhamento são.
- `@/lib/account-assistant/*` de fora: só **API routes + crons** (correto — ninguém de
  `queue/`/`ai/` importa o núcleo SparkBot).
- `createAdminClient()`: **158 chamadas**; por módulo `account-assistant` lidera com 34 arquivos.

### Sem dependência circular
- `account-assistant/prompt-builder.ts:14` importa de `@/lib/ai/prompt-builder` — mas **só o
  TYPE `KnowledgeBaseItem`** (type-only). `ai/prompt-builder.ts` **não** importa nada de
  `account-assistant/` (`grep` = 0). Logo, **sem ciclo**, mas é um vazamento de tipo
  cross-pipeline (o tipo deveria viver em `src/types/`).

### Violações de camada (com arquivo:linha)

1. **Acesso direto ao Supabase sem camada de repositório** — violação transversal.
   Tabelas e colunas hardcoded inline em todo lugar. Ex.: `webhook-handler.ts:119-123`
   (`sparkbot_messages`), `:258-266` (`sparkbot_dedup_locks`), `:526-532` (`agents`),
   `:543-547` (`agent_configs`), `:617-624`, `:680-695`, `:710-718` (`rep_identities`),
   `:798` (`execution_log`) — **8 tabelas diferentes tocadas cruamente num único arquivo de
   transporte**. `processor.ts:482`, `:513-516`, `:543-547`, `:622-628` idem. Não há `repo`
   nem `dao` no projeto inteiro (`find -iname '*repo*' -o -iname '*dao*'` = vazio).

2. **Lógica de transporte misturada com domínio** — `webhook-handler.ts` (1.052 LOC) é
   responsável por: HMAC indireto, dedup (7 camadas, :29-43, :100-279, :402-472), extração
   multimodal (:828-952), billing Whisper (:579-606), persistência (:680-792), silence reset
   (:709-721), e envio (:1001-1052). Deveria ser ~5 colaboradores.

3. **Tools furam `operations.ts`** — 42 chamadas `ctx.ghlClient.*` diretas em
   `calendar.ts`, `contacts.ts`, `messages.ts`, `metadata.ts`, `notes.ts`,
   `opportunities.ts`, `tabular.ts`, `tasks.ts`. Ex.: `notes.ts:113` faz
   `ctx.ghlClient.put('/contacts/.../notes/...')` em vez de uma primitiva em `operations.ts`.
   `operations.ts:1-15` documenta que foi criado pra acabar com exatamente esse padrão (add_tag
   duplicado em 3 lugares) — mas só `createNoteOnContact`, `addTagsToContact` etc. foram
   migrados; calendar/opportunities/messages nunca foram.

4. **Env var single-hub vazando em camadas que deveriam ser multi-tenant** —
   `tools/followup.ts:449` resolve hub agent via `process.env.ASSISTANT_HUB_LOCATION_ID`
   (uma TOOL não deveria conhecer env de topologia); `proactive/reminder-runner.ts:169,428`,
   `proactive/whatsapp-delivery.ts:123,160,162` idem.

---

## 4. HOTSPOTS DE ACOPLAMENTO E RESPONSABILIDADES MAL ALOCADAS

| Hotspot | Diagnóstico | Evidência |
|---------|-------------|-----------|
| **`webhook-handler.ts` (1.052 LOC)** | God-file de transporte. Faz 8 responsabilidades. Maior risco de manutenção do pipeline. | arquivo inteiro; 8 tabelas tocadas |
| **`processor.ts` (939 LOC)** | Mistura orquestração + detector de hallucination (300 LOC de regex, :64-330) + billing + camada conversacional + timezone backfill (:500-524). O detector de hallucination deveria ser módulo próprio. | processor.ts:64-330 |
| **`prompt-builder.ts` (86 KB / 1.153 LOC)** | Maior arquivo do núcleo. System prompt monolítico. Difícil testar/versionar seções. | wc -l = 1.153; 86.179 bytes |
| **Colisão de nomes `processor.ts` ×2 e `prompt-builder.ts` ×2** | `account-assistant/processor.ts` vs `queue/processor.ts`; `account-assistant/prompt-builder.ts` vs `ai/prompt-builder.ts`. Em IDE/imports vira fonte de erro humano. | `find` confirma 2+2 |
| **Orquestração LLM duplicada** | `processor.ts:702-716` e `dispatcher.ts` montam o MESMO `runWithTools({systemPrompt, messages, tools:getToolDefinitions, executor:executeTool})`. Bug num lado não propaga pro outro. | processor.ts:702-716 ≈ dispatcher.ts:24-26 |
| **`ai/history-compressor.ts` importa billing** | Um "compressor de histórico" (util de transformação) chama `trackAndCharge` (:3,146-159). Mistura responsabilidade de billing num utilitário. | history-compressor.ts:3 |
| **`route.ts` faz lookup de hub + STOP + handoff + targeting + working-hours** (909 LOC) | O entrypoint compartilhado carrega regras de NEGÓCIO dos dois pipelines. Deveria delegar mais cedo. | route.ts:204-637 |

**Boa notícia (bem alocado):** `filter-engine/` (10 arq., só ghl+supabase), `followup/`
(10 arq., só ghl+supabase), `conversational/` (folha pura, sem GHL/Supabase) são exemplos
de encapsulamento correto. O `tools/index.ts` registry (`withConfirmationParam`,
`executeTool` gate) é um ponto de orquestração limpo e bem desenhado.

---

## 5. CAMADA GHL / TOKEN — DIAGNÓSTICO ESTRUTURAL DOS CASOS P0/P1

### Como auth/escopo/refresh funcionam hoje

```
  Marketplace/OAuth install (FORA DESTE REPO — n8n/GHL app config)
        │  concede SCOPES na instalação
        ▼
  Tabela "Token Refresher"  (projeto Supabase SEPARADO — createGHLTokenClient, admin.ts)
   ── companyId (PK), access_token, refresh_token, scope  ← scope É SALVO (token-refresher.ts:132,215)
        │
   refreshAllCompanyTokens()  ── cron Vercel diário /api/cron/refresh-ghl-token (vercel.json)
   grant_type=refresh_token, user_type=Company (token-refresher.ts:61-91)
        │  (NUNCA lê nem valida scope — só persiste o que o GHL devolve)
        ▼
  getCompanyToken(companyId)  → company access_token  (auth.ts:19-39)
        │
  getLocationToken(companyId, locationId)  ── POST /oauth/locationToken  (auth.ts:47-106)
   ── deriva LOCATION token do COMPANY token; cache 20min; mutex anti-stampede
        │  (o escopo do location token É HERDADO do company token — sem escopo por location)
        ▼
  GHLClient.{get,post,put,delete}  → retry/401-refresh/429/5xx  (client.ts)
        │
        ▼
  tools/* (thin wrappers) → ghlErrorToResult (types.ts:231-313)
```

### Onde mora a decisão de escopo
**Em lugar nenhum do código.** O escopo é decidido **no momento do OAuth install** (no app
GHL Marketplace / fluxo n8n, externo ao repo — não há rota `/authorize`/`/install` em
`src/app`, confirmado). O campo `scope` é gravado em `Token Refresher`
(token-refresher.ts:132,215) e **nunca é lido** em parte alguma (`grep scope` só acha
gravação). Não existe nenhuma camada que: (a) saiba quais scopes uma operação precisa, (b)
valide o token antes de chamar, ou (c) detecte "scope faltando" proativamente. O código
**descobre o problema só quando o GHL devolve 403/500 em runtime**.

### `delete_appointment` (signal `261cabfc`, IAM)
- Tool é wrapper puro: `calendar.ts:1344-1346` faz
  `ctx.ghlClient.delete('/calendars/events/appointments/{id}')` e cai em
  `ghlErrorToResult(err, "deleção de appointment")` (:1348).
- GHL responde **500 "This route is not yet supported by the IAM Service"** (A3
  signal `261cabfc`, location `ZtvCHBtQD6Ka2RpxCjbd`).
- **Diagnóstico estrutural:** isto NÃO é bug do nosso código — o endpoint
  `DELETE /calendars/events/appointments/{id}` exige um IAM scope/feature que o token OAuth
  atual (derivado do company token) não tem. Como `client.ts:64-72` trata 5xx como
  **transitório** (retry 2× backoff), o bot ainda gasta 3 chamadas + latência num erro que é
  **permanente**. A camada não distingue "5xx transitório" de "5xx estrutural/IAM". A decisão
  de scope mora no install OAuth — fora do alcance do código até reinstalar/reconfigurar o
  app GHL com o escopo de calendar/IAM correto.

### `get_contact_notes` (signal `cc7c6406`, 403)
- Wrapper puro: `contacts.ts:397` faz `ctx.ghlClient.get('/contacts/{id}/notes')` →
  `ghlErrorToResult(..., "consulta de nota")`.
- GHL responde **403 "token does not have access to this location"** na location
  `dF2FDDZzSv715e1av4gr` (A3 `cc7c6406`).
- **Diagnóstico estrutural:** `getLocationToken` (auth.ts:47-106) deriva o location token do
  **company token**. Se a location `dF2FDDZzSv715e1av4gr` foi adicionada à agência **depois**
  do install OAuth (ou não foi incluída no consentimento da company), o company token não tem
  acesso a ela e o `/oauth/locationToken` gera um token sem escopo pra aquela location. O 403
  é **fatal e silencioso**: `ghlErrorToResult` (types.ts:292-294) até reconhece o padrão
  ("permissão negada (token sem escopo necessário ou recurso de outra location)"), mas **só
  como string repassada ao LLM** — não há (a) sinal pro admin "reconecte a location X", (b)
  detecção upfront de "esta location não está no token". O cache de token (auth.ts:92) ainda
  guarda o token "ruim" por 20min, repetindo o 403.

### Veredito da camada GHL/token
A **mecânica** de auth/refresh é sólida (mutex anti-stampede auth.ts:14-60, rotation
token-refresher.ts:131, retry/401-invalidate client.ts:42-72, sanitização anti-vazamento
types.ts:183-193). O **buraco estrutural** é a **ausência total de gestão de escopo**: o
escopo é um efeito colateral do OAuth externo, salvo e ignorado; o sistema é puramente
reativo a 403/IAM. Ambos os P0/P1 são da **mesma raiz**: token company-level cujo escopo/
cobertura de location o código nunca conhece nem valida. **Nota da camada GHL isolada: 7/10**
(boa engenharia de runtime, ponto cego de governança de escopo).

---

## 6. MULTI-TENANT / HUB

- **Runtime inbound (correto):** `isSparkbotHub(locationId)` (route.ts:30-53) faz query a
  `agents WHERE type='account_assistant' AND status='active'`, cache em memória 5min
  (route.ts:27-28). Multi-hub real — qualquer location com agent ativo é hub. Bom design.
- **Inconsistência:** o resto do sistema **continua single-hub via env legada**
  `ASSISTANT_HUB_LOCATION_ID`:
  - `proactive/reminder-runner.ts:169,428`, `proactive/whatsapp-delivery.ts:123,160`,
    `tools/followup.ts:449` — proativo e uma tool resolvem hub pela env.
  - Admin UI: `app/api/agents/sparkbot/route.ts:21`, `.../rules/route.ts:16,85`,
    `app/api/sparkbot/send/route.ts:67`, `.../transcribe/route.ts:84` — todo o painel admin
    é single-hub.
  - `utils/env.ts:62-69` trata a env como **obrigatória** ("🚨 Sparkbot fica inacessível").
- **Resultado:** o CLAUDE.md diz que a env é "só pra fallback de cron/billing", mas na prática
  **proativo, follow-up e UI admin só funcionam pro hub da env**. Uma 2ª location-hub recebe
  inbound (via DB) mas **não recebe proativos nem aparece no painel** — multi-tenant
  pela metade.
- `ASSISTANT_HUB_COMPANY_ID` (webhook-handler.ts:213) tem fallback decente
  (`NEXT_PUBLIC_GHL_COMPANY_ID`), menos crítico.
- **pg_cron acopla URL hardcoded:** migration 00032 agenda `net.http_post` para
  `'https://spark-ai-platform.vercel.app/api/cron/sparkbot-proactive'` literal — staging/
  fork aponta pra prod sem editar SQL.

---

## 7. RECOMENDAÇÕES DE REFATORAÇÃO (priorizadas, SEM implementar)

> Esforço: **S** ≤1 dia · **M** 2–4 dias · **L** ≥1 semana. Tudo diagnóstico.

| Pri | Recomendação | Esforço | Por quê |
|-----|--------------|---------|---------|
| **P0** | **Camada de gestão de escopo GHL.** Mapear scope→operação; ao gerar location token, registrar quais locations o company token cobre; detectar 403/IAM como **fatal não-retryable** (não 5xx-retry) e emitir signal admin "reconecte location X / falta scope Y". Resolve a raiz comum de `delete_appointment` + `get_contact_notes`. | M | 2 P0/P1 abertos; hoje 100% reativo |
| **P0** | **Introduzir camada de repositório fina** (`src/lib/repositories/` ou `db/`) p/ as tabelas quentes (`sparkbot_messages`, `rep_identities`, `agents`, `agent_configs`, `usage_records`). Encapsula nome de tabela/coluna + os padrões de dedup/idempotência (23505). Reduz os 158 acessos crus e blinda contra drift de schema. | L | maior violação "cada coisa no lugar"; 158 hits |
| **P1** | **Unificar resolução de hub** num único helper `resolveHubForLocation()` baseado em DB (como `isSparkbotHub`), e **remover `ASSISTANT_HUB_LOCATION_ID`** de proactive/tools/admin (manter só como seed/fallback explícito). Torna multi-tenant real ponta a ponta. | M | proativo+UI single-hub; contradiz CLAUDE.md |
| **P1** | **Migrar as 42 chamadas `ctx.ghlClient.*` das tools para primitivas em `operations.ts`** (calendar, opportunities, messages, tasks, metadata, tabular). Cumpre o propósito declarado do módulo. | M | fronteira GHL vazada |
| **P1** | **Decompor `webhook-handler.ts`** em: `dedup-guard.ts`, `rep-input-extractor.ts` (já tem `extractRepInput` lá dentro), `sparkbot-persistence.ts`, `sparkbot-send.ts`. Handler vira orquestrador ~150 LOC. | M | god-file 1.052 LOC, 8 tabelas |
| **P2** | **Extrair o detector de hallucination** (processor.ts:64-330) para `account-assistant/hallucination-detector.ts` com testes unitários dos regex. | S | 300 LOC de regex frágil dentro do processor |
| **P2** | **Unificar o loop LLM** de `processor.ts` e `dispatcher.ts` num `runSparkbotTurn()` compartilhado. | M | duplicação de orquestração |
| **P2** | **Renomear arquivos colididos**: `queue/processor.ts`→`queue/queue-processor.ts`; `ai/prompt-builder.ts`→`ai/sales-prompt-builder.ts` (ou mover p/ pastas claras). Mover `KnowledgeBaseItem` p/ `src/types/`. | S | colisão cognitiva 2×2 |
| **P2** | **Parametrizar a URL do pg_cron** (migration 00032) via setting/Vault em vez de literal hardcoded. | S | staging aponta pra prod |
| **P2** | **Mover `trackAndCharge` para fora de `ai/history-compressor.ts`** — billing decidido pelo caller, não pelo compressor. | S | responsabilidade trocada |

---

### Apêndice — números medidos (read-only, 2026-05-19)
- `createAdminClient()`: **158** chamadas; `ctx.ghlClient.{verb}` direto em tools: **42**.
- Maiores arquivos do núcleo: `prompt-builder.ts` 1.153 / `webhook-handler.ts` 1.052 /
  `processor.ts` 939 / `llm-client.ts` 639 (LOC). Tools: `bulk-messages.ts` 1.429 /
  `calendar.ts` 1.363 / `bulk-messages-v2.ts` 1.145 / `bulk-management.ts` 1.058.
- Subdomínios: `proactive/` 17 arq · `followup/` 10 · `filter-engine/` 10 · `conversational/` 10.
- Dependência cross-pipeline: **type-only** (`KnowledgeBaseItem`, prompt-builder.ts:14).
  **Zero ciclos.**
- Crons: Vercel (`process-queue` diário, `refresh-ghl-token` diário) + pg_cron
  (`sparkbot-proactive` @30s, migration 00032, com triplo `WHERE EXISTS` guard).
