# Code Review — Otimizações, Tech Debt & Dead Code (2026-04-28)

Escopo: varredura HORIZONTAL no `src/` inteiro. Métricas, dead code, anti-patterns, dívidas técnicas, cache & performance, cold start, dependências.

---

## Resumo executivo

O codebase tem **~26.6k LOC** (16.3k `.ts` + 10.3k `.tsx`), 39 migrations, e está numa fase de **acúmulo controlado** — não tá corroído, mas tem sinais clássicos de produto que cresceu mais rápido que a refatoração: 3 arquivos > 900 LOC fazendo "tudo" (`prompt-builder.ts` 998, `processor.ts` 946, `agent-tester.tsx` 1484), **zero testes**, `console.*` espalhado em 209 lugares (sem logger estruturado), `as any` cirurgicamente colocado em todos os SDK boundaries (Anthropic/OpenAI tipam tools como `unknown`), e duplicação real entre `src/lib/ai/*` (sales/recruitment) e `src/lib/account-assistant/*` (Sparkbot) — dois processors paralelos, dois llm-clients, dois prompt-builders.

**Qualidades**: cache de prompt está corretamente implementado em ambos os fluxos (`cache_control: ephemeral` no Claude, `store: true` na OpenAI; `cached_tokens` está sendo reportado e logado em `[AI] tokens=...cached=...hit=X%`); pipeline tem RPCs SQL para operações atômicas (`try_claim_dispatch_slot`, `finalize_dispatch`); turns estruturados em vez de string colada; truncagem com aviso explícito em tool results (`MAX_TOOL_RESULT_CHARS`); validação env startup com `validateEnv()` em `src/lib/utils/env.ts:83`; constants centralizadas em `MAX_FILE_SIZE`/`MAX_IMAGE_SIZE`/`MAX_DOC_SIZE` etc.

**Principais riscos**:
1. **N+1 em loops com supabase/GHL** — pelo menos 5 lugares fazem queries em loop (cron, follow-ups, identity, advance-task, scheduled-followups). Em rep com 5 locations, 1 follow-up = 6+ queries; cron com 100 reps = 100+ queries de timezone.
2. **Cold start do webhook** — `inbound-message/route.ts` puxa `processMessageQueue` (processor.ts) que faz `import OpenAI from "openai"` no top-level. OpenAI SDK = ~1-2MB no cold path. Isso bloqueia o ack do webhook (objetivo: <500ms).
3. **Duplicação real ai/ vs account-assistant/** — 2 LLM clients, 2 prompt-builders, 2 processors. ~50% de código compartilhável (cache, fallback, billing, multimodal, tracking) mas refeito.
4. **Imports pesados não-lazy** — `src/lib/utils/env.ts` executa `validateEnv()` no import (linha 83); cada serverless function paga validação no cold start.
5. **Zero estrutura de logger** — 209 console.\* sem prefix uniforme (alguns usam `[Webhook]`, outros `[Processor]`, outros `Erro ao buscar...`). Em produção isso vira chaos no Vercel logs.
6. **`as any` casts em SDK** — 11 ocorrências em `src/lib/ai/openai-client.ts` e `src/lib/account-assistant/llm-client.ts`. Não é "negligente", é necessário porque os SDKs Anthropic/OpenAI não tipam `cache_control` direito — mas ninguém revisita.

---

## Tech debt inventory

| Categoria | Count | Exemplos top 5 (file:line) |
|---|---|---|
| `console.log/warn/error` | **209** | webhook/route.ts:79, processor.ts:181, processor.ts:343, processor.ts:433, openai-client.ts:335 |
| `any` types / `as any` | **12** | llm-client.ts:201, llm-client.ts:204, llm-client.ts:206, openai-client.ts:241, openai-client.ts:271 |
| `eslint-disable` | **17** | llm-client.ts:200,203,205,210,316,323,366; openai-client.ts:35,240,257,270,281; prompt-builder.ts:560 |
| `as unknown as` | **3** | api/admin/carrier-kb/route.ts:51, lib/auth/sso.ts:150, tools/calendar.ts:150 |
| `.catch(() => {})` silentes | **4** | components/agents/sales/agent-tester.tsx:131,139; automations-editor.tsx:96; queue/processor.ts:125 |
| `} catch {` no-arg | **10** | app/page.tsx:30,64; dashboard/page.tsx:144; api/auth/sso/route.ts:43,77; api/agents/test/route.ts:222; api/ghl/calendars/route.ts:20; api/ghl/pipelines/route.ts:21; api/ghl/tags/route.ts:21; api/agents/test/followup/route.ts:119 |
| Arquivos > 500 LOC | **10** | components/agents/sales/agent-tester.tsx (1484), prompt-builder.ts (998), processor.ts (946), components/agents/account-assistant/sparkbot-tester.tsx (786), webhook route.ts (781) |
| Arquivos > 300 LOC `lib/` | **9** | prompt-builder.ts (998), processor.ts (946), llm-client.ts (434), proactive/dispatcher.ts (425), openai-client.ts (399), tools/contacts.ts (383), action-executor.ts (370), tools/calendar.ts (348), behavior-blocks.ts (330) |
| TODO/FIXME/HACK em comentários | **0** | Limpo. Os "TODOs" que `grep` pega são em strings PT-BR ("TODO" = artigo). |
| `void supabase.from(...)` fire-and-forget | **1** | processor.ts:515 (rolling summary, intencional + comentado) |
| `process.env.X` direto fora de `env.ts` | **17** | Vários OPENAI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_*, GHL_*, ASSISTANT_HUB_*, CRON_SECRET, WEBHOOK_REQUIRE_SIGNATURE |
| Magic numbers timeouts | **8** | openai-client.ts:9 (30000); llm-client.ts:32,313 (45000); audio-transcriber.ts:9 (60000); history-compressor.ts:93 (15000); summary-note-generator.ts:138 (25000); transcribe/route.ts:33 (25000); media-processor.ts:7 (15000) |
| `setTimeout` magic delays | **2** | webhook/route.ts:568 (`debounceSeconds * 1000 + 2000`); action-executor.ts:13 (`500 + Math.random() * 1000`) |
| Tipos GHL exportados não-usados | **12 de 15** | `GHLLocation, GHLPipeline, GHLPipelineStage, GHLCalendar, GHLCalendarSlot, GHLCalendarFreeSlots, GHLContact, GHLCustomField, GHLCustomFieldValue, GHLTag, GHLConversation, GHLWebhookPayload` em `src/types/ghl.ts` |
| Dead funções | **1 (suspeita)** | prompt-builder.ts:560-617 `buildConversationRulesSection` está com `eslint-disable @typescript-eslint/no-unused-vars` — função usada na linha 107 mas o disable é stale. Investigar se é realmente dead ou só erro de lint. |
| Dependencies suspeitas | **3** | `pdf-parse` (usado só em 1 lugar via `require()`, e o outro PDF flow usa `unpdf`); `@radix-ui/react-dialog`/`@radix-ui/react-tooltip` (não há `dialog.tsx`/`tooltip.tsx` em `components/ui/`) |

---

## Top 10 quick wins

Cada item = <1h, ganho mensurável.

### QW-1. Lazy-load `OpenAI` SDK no webhook hot path
**File**: `src/lib/ai/openai-client.ts:1`, `src/lib/queue/processor.ts:4`

`webhook/inbound-message/route.ts` importa `processMessageQueue` que importa `openai-client.ts` que faz `import OpenAI from "openai"` no top. OpenAI SDK + Anthropic SDK juntos têm várias MB. Já há precedente (`account-assistant/llm-client.ts:31` faz `await import("@anthropic-ai/sdk")` lazy; `:312` faz `await import("openai")` lazy). Aplicar mesmo padrão em `openai-client.ts:1` (mover `import OpenAI` pra dentro de `getOpenAIClient`) e `summary-note-generator.ts:1`, `audio-transcriber.ts:1`, `history-compressor.ts:1`.

**Ganho**: cold start do webhook -300 a -500ms.

### QW-2. Remover `pdf-parse`, consolidar em `unpdf`
**File**: `src/app/api/knowledge-base/route.ts:57`, `package.json`

Tem **dois libs PDF**:
- `pdf-parse` em `app/api/knowledge-base/route.ts:57` (`const pdfParse = require("pdf-parse")`)
- `unpdf` em `lib/ai/media-processor.ts:83` (`const { extractText } = await import("unpdf")`)

`unpdf` é mais leve, sem deps nativas (importante em serverless). Migrar `knowledge-base/route.ts` pra `unpdf` e remover `pdf-parse` do `package.json`.

**Ganho**: bundle -300KB, elimina `eslint-disable @typescript-eslint/no-require-imports`.

### QW-3. Remover Radix Dialog/Tooltip não usados
**File**: `package.json`

`@radix-ui/react-dialog` e `@radix-ui/react-tooltip` estão em deps mas **não há** `components/ui/dialog.tsx` ou `tooltip.tsx`, e nenhum import em `src/`. Listed UI primitives em `components/ui/`: tabs, card, slider, label, switch, badge, separator, button, select, textarea, input, skeleton — sem dialog/tooltip.

**Ganho**: 2 deps a menos em CI install (~50KB cada).

### QW-4. Limpar 12 tipos `GHL*` dead em `types/ghl.ts`
**File**: `src/types/ghl.ts`

Apenas 3 dos 15 exports são realmente usados (`GHLMessage, GHLUser, GHLTokenResponse`). Os outros 12 (`GHLLocation, GHLPipeline, GHLPipelineStage, GHLCalendar, GHLCalendarSlot, GHLCalendarFreeSlots, GHLContact, GHLCustomField, GHLCustomFieldValue, GHLTag, GHLConversation, GHLWebhookPayload`) são duplicados localmente em components UI (`use-ghl-data.ts:5`, `targeting-rules-editor.tsx:12`, `automations-editor.tsx:13`, `data-fields-editor.tsx:19`, `deactivation-rules-editor.tsx:10`). Reusar de `@/types/ghl` ou deletar de lá.

**Ganho**: clareza, single source of truth.

### QW-5. Batch insert em `scheduleFollowUps`
**File**: `src/lib/queue/follow-up-scheduler.ts:34-47, 56-68`

Loops fazendo `await supabase.from("scheduled_followups").insert({...})` um por iteração. Para `max_attempts=10`, são 10 round-trips sequenciais (~50-200ms cada vs 50ms total batched). Substituir por `insert([row1, row2, ...])`.

```ts
// Antes
for (let i = 0; i < followUpConfig.manual_steps.length; i++) {
  await supabase.from("scheduled_followups").insert({...});
}
// Depois
const rows = followUpConfig.manual_steps.map((step, i) => ({...}));
await supabase.from("scheduled_followups").insert(rows);
```

**Ganho**: scheduleFollowUps -500ms a -2s para 10 attempts.

### QW-6. Pre-fetch timezone batched no cron `sparkbot-proactive`
**File**: `src/app/api/cron/sparkbot-proactive/route.ts:70-87` (loop de reps), `:151-162` (`getRepTimezone`)

```ts
for (const rep of reps) {
  const tz = await getRepTimezone(supabase, rep);  // 1 query por rep
  ...
}
```

100 reps = 100 queries `locations.timezone`. Substituir por single query batch:

```ts
const locIds = [...new Set(reps.map(r => r.active_location_id).filter(Boolean))];
const { data: locs } = await supabase.from("locations").select("location_id, timezone").in("location_id", locIds);
const tzMap = new Map(locs?.map(l => [l.location_id, l.timezone]) ?? []);
for (const rep of reps) {
  const tz = tzMap.get(rep.active_location_id) ?? "America/New_York";
}
```

**Ganho**: cron com 100 reps -2 a -5s; reduz pressão no Supabase pool.

### QW-7. Logger estruturado mínimo
**File**: novo `src/lib/utils/logger.ts`, substituir 209 console.\*

Criar wrapper minimalista (sem libs, mantém zero deps):

```ts
export const log = {
  info: (scope: string, msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), scope, msg, ...meta })),
  warn: (...) => ...,
  error: (...) => ...,
};
```

Em vez de `console.log("[Webhook] Queued for ${agent.type} | debounce=${debounceSeconds}s")`, usar `log.info("webhook", "queued", { agentType, debounceSeconds })`. Vercel logs agregam JSON automaticamente.

**Ganho**: filtrar por `scope:webhook level:error` no painel; cardinality controlado.

### QW-8. Mover `validateEnv()` pra startup script, não top-level import
**File**: `src/lib/utils/env.ts:83`

`validateEnv()` é executado **no import** do módulo (linha 83 fora de função). Isso significa que cada cold start de cada serverless function paga validação. Em rotas que nem precisam (`/api/ghl/calendars`, `/api/auth/dev-login`), isso adiciona startup overhead sem benefício.

Mudar `validateEnv()` pra ser chamada **só** em `next.config.mjs` (build-time check) ou no primeiro endpoint crítico (webhook) com cache.

**Ganho**: cold start -10 a -30ms em rotas leves.

### QW-9. Remover stale `eslint-disable` em `prompt-builder.ts:560`
**File**: `src/lib/ai/prompt-builder.ts:560`

`buildConversationRulesSection` está com `// eslint-disable-next-line @typescript-eslint/no-unused-vars` mas é **chamada na linha 107**. Disable é stale e mascara que se a função for genuinamente removida ninguém vai notar.

**Ganho**: integridade do lint, evita false positives.

### QW-10. Centralizar timeouts AI em constants
**File**: novo bloco em `src/lib/utils/constants.ts`, refatorar 8 sites

Espalhados:
- `openai-client.ts:9` → 30000
- `openai-client.ts:16` → 30000
- `llm-client.ts:32` → 45000
- `llm-client.ts:313` → 45000
- `audio-transcriber.ts:9` → 60000
- `history-compressor.ts:93` → 15000
- `summary-note-generator.ts:138` → 25000
- `app/api/agents/test/transcribe/route.ts:33` → 25000

Criar:
```ts
export const AI_TIMEOUTS = {
  CHAT_DEFAULT: 30000,
  TOOLS: 45000,
  AUDIO: 60000,
  COMPRESSION: 15000,
  NOTE_GENERATION: 25000,
  TRANSCRIBE: 25000,
} as const;
```

**Ganho**: tunagem em 1 arquivo; possibilidade de override por env (`AI_TIMEOUT_TOOLS=60000`) sem deploy.

---

## Top 5 refactors maiores

### R-1. Extrair core compartilhado AI (sales+sparkbot) — 2-3 dias

**Problema**: `src/lib/ai/openai-client.ts` (399 LOC) e `src/lib/account-assistant/llm-client.ts` (434 LOC) são 60% código semelhante:
- Ambos: lazy import OpenAI/Anthropic
- Ambos: cache_control no system
- Ambos: cached_tokens reporting
- Ambos: fallback OpenAI quando Claude falha
- Ambos: as any em tools

Diferenças:
- Sales tem `responseSchema` (JSON schema) + sanitizer
- Sparkbot tem multi-turn tool loop (até 6 iterações)

**Proposta**: Criar `src/lib/ai/core/llm-runner.ts` com:
```ts
runLLM(opts: { model, system, messages, tools?, schema? }): Promise<LLMResult>
```

Sales chama com `schema`, Sparkbot com `tools`. Cache, billing, fallback, retry compartilhados. Sanitizer e tool-loop ficam em camadas separadas.

**Ganho**: -300 LOC líquido, 1 lugar pra otimizar cache e fallback, eliminação de divergência entre as 2 implementações (já vi pequenas diferenças: `temperature` 0.3 sparkbot vs 0.8 sales — talvez intencional, mas ninguém audita).

### R-2. Quebrar `processor.ts` em pipeline de stages — 2-3 dias

**Problema**: `src/lib/queue/processor.ts:173-773` = `processGroup` com 600 LOC fazendo:
1. Buscar agente + config
2. Gate de handoff
3. Audio transcription
4. Media processing
5. Buscar location
6. Promise.all messages+contact+slots
7. Format slots
8. Buscar feedback + KB
9. Build prompt
10. compressHistory
11. processWithAI
12. Detectar parse-failure loop
13. Log execution + billing
14. executeActions
15. syncCollectedDataToGHL
16. cancelar/agendar follow-ups
17. generateSummaryNote
18. Reactions on_data_field_set
19. Automations event-based

**Proposta**: Pipeline functional:
```ts
const stages = [
  loadAgent,
  gateHandoff,
  preprocessMedia,
  fetchGHLContext,
  buildPromptCtx,
  callLLM,
  detectParseLoop,
  executeActions,
  syncCollected,
  scheduleFollowUps,
  fireReactions,
];
const result = await pipeline(stages, ctx);
```

Cada stage é testável isoladamente. Erros middleware-style. Atualmente um único `try/catch` outermost engole tudo.

**Ganho**: testabilidade real (hoje impossível mockar); easier debug; erros granulares em vez de "[Processor] Erro grupo X".

### R-3. Test infrastructure — 3-4 dias

**Problema**: ZERO testes em `/src`. Para um pipeline com:
- 5 níveis de tom × 4 dimensões = 20 estados de behavior-blocks
- 2 agent types × 4 objectives = 8 fluxos
- Multi-provider (OpenAI vs Claude)
- Multi-modal (text, audio, image, document)
- 2 idiomas

Risco de regressão silenciosa é altíssimo. Já tem 9 bugs corrigidos em `feedback_bugs_fixed.md` que voltariam.

**Proposta**:
1. Setup vitest (não jest — mais rápido, ESM-first).
2. Snapshot tests dos prompts: `buildSystemPrompt({...config})` → snapshot. Qualquer mudança no behavior-block muda o snapshot. Detecta regressões não-intencionais.
3. Unit tests de funções puras: `bandFromPercent`, `sanitizeAgentMessage`, `parseAIResponse`, `shouldFireCron`, `calculateCumulativeDelay`, `isInQuietHours`, `parseTermsResponse`, `normalizePhone`.
4. Integration tests com Supabase test client + GHL mock — fluxo completo de webhook→reply.

**Ganho**: confidence pra refatorar; CI gate; documentação executável de behavior.

### R-4. Centralizar acesso GHL — 1-2 dias

**Problema**: `client.get(...)` espalhado, cada caller monta query string, paths são strings literais com risco de typo. Sem retry padrão (alguns lugares fazem `withRetry`, outros não). Sem timeout configurável por endpoint.

Exemplos:
- `processor.ts:303`: `/conversations/search`
- `processor.ts:330`: `/conversations/${convId}/messages`
- `processor.ts:332`: `/contacts/${group.contactId}`
- `processor.ts:336`: `/calendars/${config.calendar_id}/free-slots`
- `webhook/route.ts:597`: `/contacts/${contactId}`
- `account-assistant/identity.ts:54`: `/users/`
- `tools/contacts.ts`, `tools/opportunities.ts`, etc.

**Proposta**: tipar e centralizar em `src/lib/ghl/operations.ts` (já existe — expandir). Cada endpoint vira função tipada:
```ts
export const ghl = {
  contacts: {
    get: (client, contactId) => client.get<{contact: GHLContact}>(`/contacts/${contactId}`),
    update: (client, contactId, patch) => client.put(`/contacts/${contactId}`, patch),
    addTags: ..., removeTags: ...,
  },
  conversations: { search, getMessages, sendMessage, ... },
  calendars: { freeSlots, ... },
};
```

**Ganho**: refactor de paths em 1 arquivo; retry/timeout config único; mockable em testes.

### R-5. Componentizar `agent-tester.tsx` (1484 LOC) — 2 dias

**Problema**: maior arquivo do repo. Single component com state, fetches, render, parsing, ações de UI. Performance degrada (re-render full em qualquer state change). Próxima feature do tester (suporte a "step debugger") vai escalar pra 2000 LOC.

**Proposta**: split em:
- `agent-tester.tsx` (orchestrator, ~200 LOC)
- `tester-message-list.tsx`
- `tester-input-bar.tsx`
- `tester-state-panel.tsx` (collected_data, conversation_status)
- `tester-tool-trace.tsx` (tool_calls + diffs)
- `useTesterState` hook (state machine)

**Ganho**: render perf (memoizable), maintainability, possível re-uso no Sparkbot tester (também 786 LOC com lógica similar).

---

## Dead code identificado

### Confirmado / alto-confidence

- **`@radix-ui/react-dialog` e `@radix-ui/react-tooltip`** em `package.json` — sem `dialog.tsx` ou `tooltip.tsx` em `components/ui/` e zero imports diretos.
- **`pdf-parse`** em `package.json` — único uso `app/api/knowledge-base/route.ts:57` que pode migrar pra `unpdf` (já em deps via `media-processor.ts:83`).
- **12 tipos em `src/types/ghl.ts`** que ninguém importa fora do próprio arquivo: `GHLLocation, GHLPipeline, GHLPipelineStage, GHLCalendar, GHLCalendarSlot, GHLCalendarFreeSlots, GHLContact, GHLCustomField, GHLCustomFieldValue, GHLTag, GHLConversation, GHLWebhookPayload`. Tipos locais em components fazem o trabalho.
- **`notFound()` em `src/lib/utils/api.ts:40`** — exportada mas nenhum caller (busca: `notFound\b` retorna apenas a definição).

### Suspeita / vale investigar

- **`buildConversationRulesSection` em `prompt-builder.ts:560`** — o `eslint-disable-next-line @typescript-eslint/no-unused-vars` é stale (a função É usada em `:107`). Investigar: ou a função é dead e a chamada é estranha, ou o disable está obsoleto. Em qualquer caso, limpar.
- **`AGENT_TYPES.account_assistant.comingSoon`** em `constants.ts` — Sparkbot já está em prod, esse flag pode estar desatualizado.

---

## Code quality metrics

```
Total LOC src/                    26,651
  - .ts                           16,341
  - .tsx                          10,310
Total arquivos .ts/.tsx              146
Arquivos > 500 LOC                    10
Arquivos > 300 LOC em src/lib/         9
console.* total                      209
  - console.log                      75
  - console.warn                     38
  - console.error                    96
any types / as any                    12
as unknown as                          3
eslint-disable                        17
TODO/FIXME/HACK em código              0
catch blocks total                   122
catch silentes (no-arg)               10
.catch(() => {}) silentes              4
RPCs supabase                          3 (search_carrier_knowledge,
                                        try_claim_dispatch_slot,
                                        finalize_dispatch)
```

---

## Cache & performance

### Prompt cache — funcionando, mas com gaps

**Implementação atual** (correta):
- **Claude (Anthropic)**: `src/lib/ai/openai-client.ts:271` e `src/lib/account-assistant/llm-client.ts:201` injetam `cache_control: { type: "ephemeral" }` no system prompt. Reportam `cache_read_input_tokens` (`:283` e `:213`).
- **OpenAI**: `src/lib/ai/openai-client.ts:210` e `src/lib/account-assistant/llm-client.ts:360` passam `store: true` (ativa caching automático da OpenAI). Reportam `prompt_tokens_details.cached_tokens` (`:216` e `:367`).
- **Logging**: `openai-client.ts:335` loga `[AI] tokens=Nin/Nout cached=N hit=X% dur=Yms` — visibilidade existe.
- **Persistência**: `processor.ts:600` registra `cached_tokens` e `cache_hit_ratio` em `execution_log.action_payload`. Isso permite query de eficiência por agent.

**Gaps identificados**:
1. **Cache só aplica ao system prompt**. Em conversas longas, o histórico (`messages: [...history, userMessage]`) não tem `cache_control` — passa fresh todo turno mesmo sendo byte-exact estável. Anthropic permite **até 4 cache breakpoints**; pode-se cachear o último N-1 da história também: `messages: [...history, { ...turn, cache_control }, userMessage]`.
2. **Cache não tem TTL controlled visualization** — sem dashboard mostrando hit rate evoluindo. Os logs estão lá, mas ninguém analisa. Sugestão: query Supabase `SELECT AVG(cached_tokens::float / NULLIF(prompt_tokens, 0)) FROM execution_log WHERE created_at > now() - interval '24h'` num panel.
3. **Sparkbot tool calls não-cacheados** — `llm-client.ts:184-188` passa `tools` array fresh em cada iteração do loop (até 6×). Tools são byte-exact estáveis dentro do turno. Possível cache_control no tools array.
4. **System prompt grande (15-25k tokens)** — `prompt-builder.ts` (sales) compõe sections incluindo KB completa, feedback, behavior-blocks, custom_instructions. No primeiro turno, paga full input cost. Aceitável dado o cache, mas vale revisitar se o system prompt está enxuto.

**Verdict**: cache *está* funcionando e *está* sendo medido. O melhor hit possível só vem com cache nos turns também — refactor moderado (1-2h por arquivo).

### DB queries hot path — 5 N+1 confirmados

#### N+1.1 — `cron/sparkbot-proactive/route.ts` getRepTimezone
`:70-87` itera reps; `:151-162` chama `getRepTimezone(supabase, rep)` que faz 1 SELECT em `locations` por rep. **100 reps = 100 queries**. Fix: ver QW-6.

#### N+1.2 — `lib/account-assistant/proactive/reminder-runner.ts:155-160` advanceTask
Para cada task recorrente disparada, busca `locations.timezone` individual. `:57` itera tasks. 50 tasks = 50 queries de timezone. Fix: pre-fetch único por batch.

#### N+1.3 — `lib/queue/follow-up-scheduler.ts:127-321` processScheduledFollowUps
Para cada follow-up no batch:
- L131: `conversation_state` SELECT (1)
- L151: `locations` SELECT (1)
- L160: GHL `/contacts/{id}` GET (1)
- L187: `message_queue` SELECT (1)
- L208: `agents+config` SELECT (1)
- L229: `locations` SELECT (1) — **duplicada da L151**
- L254: GHL `messages+contact` (2 paralelos)
- L298: AI call
- L306: GHL `messages` POST

= **9 round-trips por follow-up**. 20 follow-ups por batch = 180 round-trips. Fix: batched fetch de `locations` (1 query), `agents+config` (1 query), `conversation_state` (1 query) com `.in("id", ids)` antes do loop.

#### N+1.4 — `lib/account-assistant/identity.ts:50-82`
Loop sequencial de locations chamando GHL `/users/` em cada uma. Em rep com cadastro em 5 locations = 5 chamadas GHL sequenciais (~500ms-2s cada). **Crítico**: identifyRep é chamado **a cada msg do rep até cachear**. Fix: `Promise.all` paralelizando — risco mínimo, ganho grande.

#### N+1.5 — `lib/queue/follow-up-scheduler.ts:34-47, 56-68` scheduleFollowUps
Insert sequencial. Fix em QW-5.

### Cold start — imports pesados na hot path

**Webhook (`/api/webhooks/inbound-message/route.ts`)**:
```
route.ts (1,3,5,22,23,24,25,26)
  → @vercel/functions
  → @/lib/supabase/admin → "@/lib/utils/env" (executa validateEnv() top-level)
  → @/lib/ghl/client
  → @/lib/ai/audio-transcriber → openai (top-level)
  → @/lib/ai/media-extractor
  → @/lib/queue/processor → openai-client → openai (top-level)
                          → @anthropic-ai/sdk via dynamic import (já lazy ✓)
                          → action-executor, history-compressor, etc.
```

`import OpenAI from "openai"` é o maior peso. SDK fica em ~1MB unzipped. Cada cold start do webhook paga isso, **mesmo antes de qualquer LLM call**.

**Já fizeram lazy** (parabéns):
- `route.ts:56` — `crypto` (nativo, baixo custo mas correto)
- `route.ts:150` — `account-assistant/webhook-handler` (correto, só carrega se Hub)
- `route.ts:354` — `summary-note-generator`
- `media-processor.ts:83` — `unpdf`
- `media-processor.ts:122` — `mammoth`
- `account-assistant/llm-client.ts:31, 312` — Anthropic, OpenAI

**Não estão lazy** (oportunidades):
- `audio-transcriber.ts:1` — `import OpenAI, { toFile } from "openai"`
- `openai-client.ts:1` — `import OpenAI from "openai"`
- `summary-note-generator.ts:1` — `import OpenAI from "openai"`
- `history-compressor.ts:1` — `import OpenAI from "openai"`
- `account-assistant/tools/carrier_kb.ts:22` — `import OpenAI from "openai"`

Como qualquer um desses sobe transitivamente do webhook, o cold start de uma mensagem que vai pro OpenAI custa mais. Aplicar QW-1.

**Outras sugestões**:
- `vercel.json` só tem cron `summary-notes` (na real `process-queue` no path) — vale revisar se precisaria tunar `runtime: "nodejs20.x"` em routes específicas (atualmente default). Edge runtime não vale aqui (precisa de Node modules).

---

## Lessons & padrões positivos identificados

Para reaproveitar:

1. **`withRetry`** em `lib/utils/retry.ts` usado consistentemente onde importa (slots, GHL).
2. **`notifyCriticalError`** em `lib/utils/notify.ts` — alerting é centralizado.
3. **Atomic claim via RPC** em `try_claim_dispatch_slot` — pattern correto pra evitar duplo-fire em cron paralelo.
4. **`MAX_TOOL_RESULT_CHARS`** em `llm-client.ts:19` — truncagem com aviso explícito pra LLM, em vez de stack overflow silencioso.
5. **`reqId`** em `processor.ts:179` — request correlation ID prepended em todos os logs daquele request.
6. **`waitUntil`** em `webhook/route.ts:567` — background processing após ack, padrão Vercel correto.
7. **`Promise.allSettled`** em `processor.ts:328` — fetch paralelo de messages+contact+slots, com handling separado de success/failure.

Esses padrões podem ser puxados pro core compartilhado no R-1.

---

## Conclusão

Codebase é **decente para o estágio**. Não tem nada catastrófico. Os principais débitos são:
1. **Falta de testes** (R-3): risco crescente com complexidade.
2. **Duplicação ai/ vs account-assistant/** (R-1): vai piorar quando tiver Sparkbot V3 com WhatsApp.
3. **N+1 silenciosos** (5 lugares): hoje invisíveis, mas com 100+ reps no Sparkbot escala mal.
4. **Cold start hot path** (QW-1): 200-500ms recuperáveis no webhook.
5. **Sem logger estruturado** (QW-7): observability ruim no Vercel, fica difícil triar bugs em prod.

Os 10 quick wins somados = ~6h de trabalho, ganhos mensuráveis em latência e DX. Os 5 refactors maiores = 8-12 dias, mas R-3 (testes) deveria virar prioridade antes de qualquer reescrita do processor (R-2).
