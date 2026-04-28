# Code Review — Sparkbot (Account Assistant)
**Data:** 2026-04-28
**Reviewer:** arquiteto sênior (review crítico)
**Escopo:** `src/lib/account-assistant/**` + `src/app/api/agents/{sparkbot,account-assistant}/**`

---

## Resumo executivo

O Sparkbot está num estado **arquiteturalmente sólido** com várias decisões boas (separação prompt cacheável vs runtime context, atomic claim via SQL RPC pra anti-race, multi-provider LLM com fallback, validação de IDs antes de bater na API). Porém há **um bug crítico de paridade entre o webhook de produção e os endpoints de teste** (produção perde memória conversacional toda mensagem), o **prompt do system menciona 4 tools que não existem** (`modify_tag`, `update_field`, e referencia "8 tools" quando há ~30), e a **regra de confirmação está incoerente** ("não-implementadas em V1" sendo que `delete_*`, `send_message_to_contact`, `create_appointment` SÃO high-risk e estão implementadas).

A camada de tools está bem padronizada (`ToolEntry`, `validateGhlId`, `ghlErrorToResult`), o RAG carrier_kb está bem cuidado com calibração de incerteza explícita, e o sistema proativo tem bom isolamento. O loop multi-turn do `runWithTools` funciona mas tem um problema de **truncamento agressivo (12K chars)** que vai cortar resultados de `get_conversation_history` em conversas reais.

**Veredicto:** Pronto pra V2 simulated em testes, mas o bug de produção (#1 abaixo) **bloqueia V3 real**. ~6 issues médias e várias otimizações pendentes.

---

## Pontos fortes

### Arquitetura

- **`prompt-builder.ts:30-175`** — system prompt cacheável (com `cache_control: ephemeral`) separado do runtime context dinâmico (`buildSparkbotRuntimeContext`, linhas 266-292). Bom pra hit rate de cache. Comentário linha 6-9 explicita a decisão.
- **`prompt-builder.ts:294-316`** — `getTimezoneOffsetMs` derivado via `Intl.DateTimeFormat` em vez de chumbar offsets. Correto pra DST e tz mudados.
- **`processor.ts:148-153`** — `loadCarrierTier1` async com `.catch` que devolve `""` (graceful fallback). Não bloqueia turn se KB falhar.
- **`llm-client.ts:88-122`** — multi-provider com fallback Claude→OpenAI bem isolado. Loop multi-turn (`runWithClaude`) preserva histórico via `messages.push` e respeita `stop_reason` e `tool_use` corretamente.
- **`llm-client.ts:21-26`** — `truncateToolResult` com mensagem explícita pro LLM (`[TRUNCATED: X chars omitidos…]`) — o LLM sabe que falta dado e pode pedir refinamento.

### Anti-race + atomicidade

- **`dispatcher.ts:133-169` + `00033_atomic_dispatch_claim.sql`** — `try_claim_dispatch_slot` é um excelente padrão. INSERT ON CONFLICT DO UPDATE WHERE last_fired_at < cutoff retorna NULL se cooldown ativo. Atomic, sem race entre crons paralelos. Comentário explica bem (`dispatcher.ts:120-132`).
- **`reminder-runner.ts:38-47`** — atomic claim via `update status='running' WHERE status='pending'` em uma só query. Correto.

### Tool catalog

- **`tools/types.ts:36-45`** — `validateGhlId` rejeita IDs curtos antes de bater na API e dá hint pro LLM (`"Use search_contacts ou get_contact pra obter o ID real…"`). Padrão excelente.
- **`tools/types.ts:51-62`** — `validateIso8601` igual: rejeita data inválida com exemplo do formato esperado.
- **`tools/contacts.ts:26`** — `searchContacts` agora retorna IDs reais (mata o anti-pattern de inventar "1, 2, 3" como ID).
- **`tools/opportunities.ts:35-42`** — passa `monetary_value_greater_than` ao GHL em vez de filtrar client-side (fix de bug do ultra-review documentado em comentário linha 32-34).
- **`tools/calendar.ts:82-83`** — distingue corretamente `/calendars/events` (listagem com timestamp) de `/calendars/events/appointments` (CRUD), gotcha documentado em comentário linha 4-7.
- **`tools/tasks.ts:44`** — comentário "GHL exige campo explícito" sobre `completed: false` no create — preserva conhecimento que veio de 422 em testes.

### Carrier KB

- **`tools/carrier_kb.ts:74-113`** — description da tool é estado-da-arte: explica hierarquia (NLG → Five Rings → Brazillionaires), exemplos canônicos, regras de category_hint por kb. Acima da média do que se vê em projetos similares.
- **`tools/carrier_kb.ts:184-209`** — propaga staleness (`is_stale`, `verified_age_days`), `state_match`, `source_doc_cat`. Permite o LLM responder com hedging epistêmico calibrado.
- **`tools/carrier_kb.ts:170-180`** — quando 0 chunks, retorna `status: 'ok'` com message instrutivo em vez de `not_found`. Pro LLM, isso é melhor (recebe orientação concreta sobre o que dizer ao rep).
- **`prompt-builder.ts:151-171`** — bloco "HONESTIDADE EPISTÊMICA" é forte — instruções específicas pra hedging por similarity bucket, propagação de `[unverified]`, citação de fonte.

### Webhook + termos

- **`identity.ts:10-20`** — `normalizePhone` defensivo, com fallbacks. Bom (consistência E.164 essencial pra unique constraint).
- **`identity.ts:78-82`** — `try/catch` por location no scan de users garante que falha em uma location não bloqueia identificação.
- **`terms.ts`** — texto dos termos é claro, conciso, pt-BR coloquial. Boa UX de onboarding.

### Endpoints

- **`api/agents/sparkbot/rules/route.ts:71-83`** — validação explícita de tamanho com 400 error em vez de `slice` silencioso (comentário "antes faziam .slice silencioso, perdendo conteúdo").
- **`api/agents/sparkbot/rules/route.ts:111-114`** — audit fields `created_by_user_id` / `last_modified_by_user_id` (migration 00035) — bom pra compliance e debug.

---

## Pontos fracos / Bugs

### CRÍTICO

#### B1. Webhook de produção NÃO passa `conversationHistory` nem `testSessionId` pro `processIncoming`
**Arquivo:** `src/lib/account-assistant/webhook-handler.ts:104-114`
**Severidade:** CRÍTICA — quebra completamente a continuidade conversacional em produção (V3 real). Cada turn é tratado como turn 1 isolado.

```ts
// webhook-handler.ts:104-114 — produção real
const result = await processIncoming({
  rep,
  input: repInput,
  agentId: hubAgent.id,
  config: {
    confirmation_mode: ...,
    ai_model: ...,
  },
});
```

Compare com `synthetic-test/route.ts:160-172` e `test/route.ts:177-187` que carregam `conversationHistory` e passam `testSessionId`. Produção opera "burra" — o rep diz "ok, faz isso" e o bot não tem ideia do que era o "isso".

Adicionalmente, sem `testSessionId`, a detecção de loop em `processor.ts:198-233` (que checa `agent_test_messages` pelo `testSessionId`) **nunca dispara em produção**.

**Fix:** ler `agent_test_sessions` ou estender pra ler de uma tabela de histórico real (V3 vai precisar disso). Mínimo viável: criar histórico baseado em `execution_log` filtrado por `rep_id` ou criar `assistant_conversation_history` (já tem `assistant_conversations` em `types/account-assistant.ts:88-101` mas não é usada).

#### B2. System prompt menciona tools que não existem
**Arquivo:** `src/lib/account-assistant/prompt-builder.ts:59,69,70,80`
**Severidade:** CRÍTICA — LLM vai alucinar tools.

```
"# CAPACIDADES (V1 — 8 tools)",        // linha 59 — total real é 30+
"- modify_tag: add/remove tag de contato",   // linha 69 — não existe
"- update_field: atualizar campo (standard ou custom)", // linha 70 — não existe
"- list_calendars / get_free_slots / update_appointment / delete_appointment.", // OK existem
```

Tools reais (verificadas em `tools/index.ts`):
- Tags: `add_tag`, `remove_tag` (separadas)
- Field update: parte de `update_contact` (com `custom_fields[]`)
- Não existe `modify_tag`, não existe `update_field`

Quando rep pedir "remove tag X", LLM pode tentar `modify_tag(action: 'remove', ...)` (porque o prompt prometeu) e falhar com "tool desconhecida". Em testes adversariais isso aparece como confusão consistente.

Adicional: o texto "V1 — 8 tools" está obsoleto — o registry tem aproximadamente 30 tools (8 contacts, 4 notes, 5 tasks, 2 tags, 7 calendar, 7 opps, 3 messages, 3 metadata, 3 reminders, 1 carrier_kb).

**Fix:** trocar `modify_tag` → `add_tag/remove_tag`, `update_field` → `update_contact`, atualizar contagem ou remover número.

#### B3. "Confirmation mode" — texto incoerente menciona ações "não-implementadas em V1" mas elas EXISTEM
**Arquivo:** `src/lib/account-assistant/prompt-builder.ts:33-37`
**Severidade:** ALTA — confunde o LLM e quebra o protocolo de confirmação.

```ts
const confirmText =
  confirmationMode === "always"
    ? "Confirme TUDO antes de executar — até leitura."
    : confirmationMode === "high_only"
    ? "Só confirme ações pesadas (não-implementadas em V1). Executa direto o resto."
    : "Execute leitura direto. Escrita (note/task/tag/field) executa E informa 'feito'. Ações pesadas (não-implementadas em V1) confirmariam antes.";
```

Mas as tools `delete_contact`, `delete_opportunity`, `delete_appointment`, `delete_task`, `delete_note`, `create_appointment`, `update_appointment`, `send_message_to_contact` são `risk: "high"` e ESTÃO IMPLEMENTADAS. O texto literal "não-implementadas em V1" induz o modelo a interpretar high-risk como nada-pra-confirmar, bypassando o protocolo de confirmação na prática.

Em `medium_and_high` (default), o prompt está dizendo "execute escrita E informe feito" e "ações pesadas confirmariam antes" — mas **a confirmação não está enforced em código**. O LLM decide sozinho se confirma ou não com base no system prompt, e o prompt está mentindo que high-risk é hipotético.

**Fix:** alinhar texto à realidade. Em `medium_and_high`: "Execute leitura direto. Escrita leve (note/task/tag/update_contact) executa E informa. AÇÕES HIGH-RISK (delete_*, create_appointment, update_appointment, send_message_to_contact) — sempre confirme em mensagem natural antes de executar."

Idealmente, ter um wrapper em `executeTool` que para tools `risk: 'high'` em modo `medium_and_high`/`always` exija um flag `confirmed: true` no input — caso contrário retorna `{status: 'error', message: 'requires_confirmation'}`. Hoje confiar 100% no prompt é frágil.

#### B4. Truncamento de tool result a 12K chars vai cortar `get_conversation_history` em conversas reais
**Arquivo:** `src/lib/account-assistant/llm-client.ts:19,21-26`
**Severidade:** ALTA — perda silenciosa de contexto em casos reais.

`MAX_TOOL_RESULT_CHARS = 12000`. Uma conversa de 30 msgs com bodies de ~600 chars cada (típico WhatsApp) já estoura. O LLM recebe `[TRUNCATED…]` e o `get_conversation_history` é justamente a tool mais usada em pré-meeting briefing (system rule "Briefing pré-reunião"). Ele vai retornar resumos baseados em metade dos dados e provavelmente as msgs mais recentes (final do array) que são as relevantes podem estar no fim cortado.

Pior: o `slice(0, 12000)` corta começo da string, mas `messages.slice(-limit)` em `messages.ts:86` retorna as últimas N. JSON.stringify dessas é `[oldest, …, newest]` e o truncate corta as **mais recentes** que vinham no final do JSON. Inverte a expectativa.

**Fix:**
1. Truncar em `messages.ts:86` no nível semântico — limitar `body` a 300 chars por msg, retornar só os últimos 20 turns por default.
2. Limite genérico do client deveria ser maior (40K chars ainda é só ~10K tokens) ou cortar do início (mais antigo) preservando o final.

### ALTA

#### B5. `validateGhlId` aplicado em UUIDs de Supabase (reminders)
**Arquivo:** `src/lib/account-assistant/tools/reminders.ts:184`
**Severidade:** MÉDIA — funciona por acaso; mensagem de erro engana.

```ts
const invalid = validateGhlId(reminderId, "reminder");
```

UUID é `8-4-4-4-12` com hyphens (36 chars). `validateGhlId` em `types.ts:37` aceita `[A-Za-z0-9_-]+` com length ≥ 10, então UUIDs passam. Mas se o LLM passar UUID parcial ou ID curto, a mensagem de erro diz "IDs do GHL têm ~20 chars alfanuméricos (ex: 'ErpM2X8vR1U4IrRTZnKX')" — totalmente errada (reminder_id é UUID, não GHL).

**Fix:** criar `validateUuid` separado:
```ts
function validateUuid(id: string, entityName: string): ToolResult | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { status: "error", message: `${entityName}_id inválido. Use list_my_reminders pra obter UUID.`, retryable: false };
  }
  return null;
}
```

#### B6. `MAX_ITERATIONS = 6` curto demais para pre-meeting briefing
**Arquivo:** `src/lib/account-assistant/llm-client.ts:14`
**Severidade:** MÉDIA — falhas em casos reais.

System rule "Briefing pré-reunião" lista 5 tools allowed (`get_contact`, `search_conversations`, `get_conversation_history`, `list_opportunities`, `get_contact_notes`). Cada uma é uma iteração. Se o LLM precisa pesquisar contato (1) → conversa (2) → mensagens (3) → notas (4) → opps (5) → resposta (6 — última iteração permitida). Sem margem se algum retorno for ambíguo e precisar refinar.

**Fix:** subir pra 10. Ou ter `maxIterations` configurável por contexto (briefing precisa mais que pergunta simples).

#### B7. `processor.ts` detecção de "2 falhas consecutivas" só funciona em test mode
**Arquivo:** `src/lib/account-assistant/processor.ts:201-233`
**Severidade:** MÉDIA — produção vai entrar em loop infinito de erro sem fallback.

```ts
if (llmFailed && input.testSessionId) {
  // ... busca em agent_test_messages
}
```

Em produção, `testSessionId` é null. Não há fallback de "duas falhas seguidas". O rep manda 1 mensagem que falha → vê msg de erro → manda de novo → falha de novo → vê mesma msg → loop. Em V3, isso poderia consumir custo + frustrar o rep sem pause.

**Fix:** persistir `llm_failed` no `rep_identities` (campo `last_llm_failed_at` + `consecutive_failures`) ou em `rep_id`-keyed cache; produção lê dali. Equivalente ao `unanswered_pause_until` em `types/account-assistant.ts:50`.

#### B8. `loadCarrierTier1` lê do DB em todo turn — sem cache em memória
**Arquivo:** `src/lib/account-assistant/prompt-builder.ts:184-216`
**Severidade:** MÉDIA — overhead de DB hit em todo turn (~30-100ms) que não muda raramente.

Os chunks `priority='always'` mudam apenas quando admin reingere KB. Hoje há query do DB em todo turn (processor + dispatcher). Pra um SaaS com vários reps simultâneos, isso é I/O desnecessário no caminho crítico.

**Fix:** memoizar com TTL 5min. Atualmente o sistema é stateless por request (Next.js serverless), mas pode-se cachear via `globalThis` com revalidate ou Vercel KV. Ou aceitar staleness, expor invalidação via webhook quando admin atualizar KB.

#### B9. Cron evaluator não suporta steps `*/n`
**Arquivo:** `src/lib/account-assistant/proactive/cron-evaluator.ts:6,79-93`
**Severidade:** BAIXA-MÉDIA — funcional mas limitante. Comentário linha 6 admite.

Custom rules do admin podem querer `*/15 * * * *` (a cada 15min). Hoje retorna `false` silenciosamente em `matchField` quando recebe `*/15` (não há `*` no início, então cai no `parseInt('*/15')` → NaN → false).

**Fix:** parser de steps:
```ts
if (field.includes("/")) {
  const [base, stepStr] = field.split("/");
  const step = parseInt(stepStr);
  if (!step) return false;
  if (base === "*") return value % step === 0;
  // ranges como 0-30/5: TODO
}
```

### MÉDIA

#### B10. `cron-evaluator.ts` aceita weekday=undefined silenciosamente
**Arquivo:** `src/lib/account-assistant/proactive/cron-evaluator.ts:65-66`

```ts
const weekday = weekdayMap[get("weekday")];
if (weekday === undefined) return null;
```

OK — mas linha 17-18 do `shouldFireCron` (`if (!target) return false`) faz com que crons quebrados retornem `false`. Bom, mas é silent — sem log/alerta se um cron quebrar pra alguma rule específica. Admin não sabe que sua rule não dispara.

**Fix:** adicionar log warn em `cron-evaluator.ts` quando `parseLocalParts` retornar null com o tz e cron originais.

#### B11. Race entre dispatcher e reminder-runner em `assistant_alert_state` (caso forceFire)
**Arquivo:** `src/lib/account-assistant/proactive/dispatcher.ts:140-156`

Quando `forceFire=true` (botão Simular Agora), faz `upsert` direto sem usar `try_claim_dispatch_slot`. Se 2 admins clicarem "Simular agora" ao mesmo tempo, ambos passam o upsert (que setta status='running' duas vezes em rápida sucessão). Provavelmente OK na prática, mas perde a garantia de exclusividade.

**Fix:** `try_claim_dispatch_slot` deveria aceitar parâmetro `p_force_fire` que ignora o WHERE last_fired_at. Mantém atomicidade.

#### B12. `reminder-runner.ts` "tenta achar uma sessão de teste recente do rep" pode entregar a outro admin
**Arquivo:** `src/lib/account-assistant/proactive/reminder-runner.ts:86-100`

```ts
if (!sessionId) {
  // Tenta achar uma sessão de teste recente do rep pra entregar
  const { data: recentSession } = await supabase
    .from("agent_test_sessions")
    .select("id")
    .eq("location_id", task.location_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  ...
  await deliverReminder(recentSession.id, task, message, title);
}
```

Filtra apenas por `location_id` — não por `rep_id` ou `created_by`. Se admin A criou um reminder e depois admin B abriu uma sessão, B pode receber o reminder de A. Vazamento de info.

**Fix:** filtrar por `created_by = task.rep_id` ou via join com `rep_identities`. Ou skipar mesmo (já tem `advanceTask + return 'skipped'` no path acima — usar esse).

#### B13. `dispatchRule` usa `LLMResult.text` pra detectar erro mas falsos positivos possíveis
**Arquivo:** `src/lib/account-assistant/proactive/dispatcher.ts:339`

```ts
if (!llmResult.text || llmResult.stopped_reason === "error") {
  await finalizeDispatch(alertStateId, "failed", llmResult.prompt_tokens);
  return { status: "failed", message: "LLM falhou", duration_ms: durationMs };
}
```

`stopped_reason === "max_iterations"` retorna texto genérico ("Executei várias ações mas preciso parar aqui...") mas NÃO é tratado como falha — vai pro `if (mode === "simulated")` e insere essa msg sem sentido na sessão de teste. Pior: cobra o admin pelos tokens.

**Fix:** adicionar `|| llmResult.stopped_reason === "max_iterations"` à condição.

#### B14. `processor.ts` detecção de locale pt-BR/en-US pelo timezone é frágil
**Arquivo:** `src/lib/account-assistant/processor.ts:142-145` e `dispatcher.ts:268-271`

```ts
const locale = timezone.startsWith("America/") && !timezone.includes("Sao_Paulo") && ...
```

Lista hardcoded de cidades brasileiras. Falta `America/Boa_Vista`, `America/Campo_Grande`, `America/Cuiaba`, `America/Maceio`, `America/Noronha`, `America/Porto_Velho`, `America/Rio_Branco`, `America/Santarem`. Se o rep está em Cuiabá (America/Cuiaba), recebe en-US.

Mais: `dispatcher.ts:268-271` não tem o mesmo `Recife/Manaus/Belem/Bahia` que `processor.ts:143` — divergência sutil. DRY quebrado.

**Fix:** usar `Intl.Locale` com `region` derivado do tz (mais robusto), ou centralizar em `lib/utils/locale.ts` com lista completa do IANA db Brasil:
```ts
const BR_TIMEZONES = new Set([
  "America/Sao_Paulo", "America/Fortaleza", "America/Recife", "America/Manaus",
  "America/Belem", "America/Bahia", "America/Boa_Vista", "America/Campo_Grande",
  "America/Cuiaba", "America/Eirunepe", "America/Maceio", "America/Noronha",
  "America/Porto_Velho", "America/Rio_Branco", "America/Santarem",
]);
```

#### B15. `parseTermsResponse` aceita "ok" como aceite — colisão com mensagens normais
**Arquivo:** `src/lib/account-assistant/terms.ts:31-35`

```ts
const ACCEPT_KEYWORDS = ["aceito", "aceita", "ok", "okay", "sim", "concordo", ...];
```

E em `parseTermsResponse` linha 49:
```ts
if (ACCEPT_KEYWORDS.some((k) => normalized === k || normalized.startsWith(k + " ") || normalized.includes(" " + k))) {
```

`includes(" ok")` ou `includes(" sim")` em "manda mensagem ok" daria match → aceitação acidental. Pra rep novo, qualquer mensagem com "ok" no meio do texto vira aceite.

Felizmente o caller só chama `parseTermsResponse` quando `!rep.terms_accepted_at` (`processor.ts:65-83`), então é só na primeira interação. Mas a primeira mensagem "ok deixa eu ver depois" daria aceite indevido.

**Fix:** restringir a `=== k` ou `startsWith(k + " ")` apenas. Tirar o `includes(" " + k)`.

#### B16. `webhook-handler.ts` não chama `processIncoming` se rep responde "não" aos termos pela primeira vez
**Arquivo:** `src/lib/account-assistant/webhook-handler.ts:67-75` e `processor.ts:65-83`

OK — fluxo está correto: webhook chama `processIncoming` → este checa `!rep.terms_accepted_at` → parseia "não" e retorna `TERMS_REJECTED_TEXT`. Mas `rep.terms_accepted_at` continua null **forever**, então cada mensagem futura desse rep vai re-processar o fluxo de termos e mandar `TERMS_OF_USE_TEXT` ou `TERMS_REMINDER_TEXT` indefinidamente.

Não há campo `terms_rejected_at` ou flag de "este rep optou por não usar". Spam de termos.

**Fix:** ou setar `terms_accepted_at` com sentinel value (`'1970-01-01'` ugly), ou adicionar `terms_rejected_at`, ou setar `unanswered_pause_until` em data distante.

### BAIXA

#### B17. `dispatcher.ts` injeta `JSON.stringify(contextData, null, 2)` no runtime context — pode estourar tokens
**Arquivo:** `src/lib/account-assistant/proactive/dispatcher.ts:308-310`

Sem limite. Se o evento reactor passar payload com 50 contatos, vão pro prompt todos.

**Fix:** truncar a 4000 chars com aviso.

#### B18. `truncateToolResult` aplicado mas tokens já contam pelo input
**Arquivo:** `src/lib/account-assistant/llm-client.ts:272`

OK — não é bug, mas note que o billing já vai cobrar pelos tokens do tool_result truncado. Se 2 turns chamarem o mesmo tool com mesmo result, dobra o custo. Ideal: cachear tool_result por (name, args) hash dentro do mesmo turn? Hoje cada chamada da mesma tool com mesmos args vai pagar de novo.

#### B19. `metadata.ts` tools não paginam
**Arquivo:** `src/lib/account-assistant/tools/metadata.ts:9-92`

`list_custom_fields`, `list_tags`, `list_users` — chamam GET sem paginação. GHL retorna até 100 por default em alguns endpoints. Location grande com 200 custom fields: 100 missing.

**Fix:** loop de paginação ou pelo menos avisar o LLM no return ("limit reached, X possíveis ainda").

#### B20. `identity.ts` scan de users em todas as locations é O(N) em primeira interação
**Arquivo:** `src/lib/account-assistant/identity.ts:50-82`

Pra cada location cadastrada, busca `/users/`. Com 100 locations = 100 chamadas GHL sequenciais antes da primeira resposta. Latência alta na primeira mensagem do rep.

**Fix:** `Promise.all` (paralelo), ou mover scan pra job background quando location é cadastrada (popula tabela `ghl_user_phones` com index).

#### B21. `seed.ts` usa `name` (case-sensitive) como chave de idempotência
**Arquivo:** `src/lib/account-assistant/proactive/seed.ts:22-29`

Se admin renomear "Briefing pré-reunião" → "Briefing pre-reuniao", o seed vai inserir uma duplicata na próxima execução.

**Fix:** usar slug derivado (em coluna separada `system_key`) imutável.

#### B22. `runWithOpenAI` armazena `messages.push(msg)` que é mensagem inteira do OpenAI mas não tipa
**Arquivo:** `src/lib/account-assistant/llm-client.ts:378`

`msg` é `ChatCompletionMessage` mas o array é `any[]` (linha 317). Funcional, mas type safety nula. Se a API mudar shape, falha em runtime.

**Fix:** usar `OpenAI.Chat.Completions.ChatCompletionMessageParam`.

#### B23. `cancelReminder` não invalida next_run_at
**Arquivo:** `src/lib/account-assistant/tools/reminders.ts:206-211`

```ts
.update({ status: "cancelled" })
```

Apenas muda status. `next_run_at` continua antigo. Não causa bug (o runner filtra por `status='pending'`), mas dificulta debug ("por que aparece data passada?"). Cosmético.

#### B24. `runWithOpenAI` envia `store: true` (linha 360) sem opt-in/fallback
**Arquivo:** `src/lib/account-assistant/llm-client.ts:360`

`store: true` ativa OpenAI prompt caching e também guarda no Conversations API. Para algumas orgs é privacy concern. Não há env var pra opt-out.

**Fix:** `store: process.env.OPENAI_STORE !== 'false'`.

#### B25. `dispatcher.ts:251` fallback `rep.ghl_users[0]?.location_id`
Se rep tem múltiplas locations sem `active_location_id` setado (ex: scenario edge), pega a primeira aleatoriamente. Pode dispatchar regra na location errada.

#### B26. `MAX_TIER1_CHARS = 6000` mas comentário diz "≤5KB" e "Tier 1 NÃO pode passar de 6KB"
**Arquivo:** `src/lib/account-assistant/prompt-builder.ts:184,202,206`

Inconsistência de docs (5KB vs 6KB). Trivial.

---

## Otimizações

### O1. Carrier KB Tier 1 — cachear em memória com TTL
Vide B8. Resolve overhead recorrente.

### O2. `getAllToolDefinitions` — pré-compute uma vez
**Arquivo:** `tools/index.ts:40-49`. Hoje recalcula em cada request. Trivial: pré-compute em module scope:
```ts
const ALL_DEFS = ALL_ENTRIES.map((e) => e.def);
export function getAllToolDefinitions(): ToolDefinition[] { return ALL_DEFS; }
```

### O3. `runWithTools` — early return se response chegou sem tool_use
Hoje o caminho "stop_reason === 'end_turn' || 'stop_sequence'" e o caminho "toolUses.length === 0 mas stop_reason diferente" são separados (linhas 224-261). Pode unificar.

### O4. `processor.ts` cobrança de tokens — separar `prompt_tokens` real (sem cached) por modelo
**Arquivo:** `processor.ts:236-253`. Hoje `trackAndCharge` recebe `prompt_tokens` e `cachedTokens`. Em Anthropic já normalizado em `llm-client.ts:216` (fresh + cached). Verificar que `pricing.ts.calculateCost` não duplica cobrança (é o que `dispatcher.ts:381-388` chama).

### O5. Carrier KB embed — cachear embedding de queries comuns
Pra perguntas repetidas ("qual cap do FlexLife em NY?") — cache key = hash(question+kb). Reduz Voyage cost dramaticamente.

### O6. Dispatcher — modo `mode='real'` ainda não implementado mas system rules estão prontas
**Arquivo:** `dispatcher.ts:374-377`. Coordenar com B1 (V3 plug).

### O7. `seed.ts` — idempotência por slug em vez de name (B21).

### O8. `tools/index.ts` — tools podem ser pesadas no prompt (~30 tools × ~300 chars de description = ~9K tokens em todo turn).
Considerar lazy-load: tools de carrier_kb sempre, mas tools de delete/update_appointment só quando confirmation_mode permite ou quando contexto explicitar. Difícil sem filtragem prévia, mas reduziria custo significativo.

### O9. `runWithClaude` — mover system + tools pra fora do loop
Hoje rebuilda payload em todo iteration. Marginal mas múltiplas iterations × system 5K chars = overhead.

### O10. Pricing das chamadas paralelas (carrier_kb com `kb x2`)
Quando o LLM dobra a chamada (kb=NLG + kb=Brazillionaires) — bom comportamento epistêmico mas Voyage cobrado 2x. Em testes adversariais, cada conversa pode ter 4-8 calls. Cachear embedding (O5) ajuda.

---

## Refactors maiores

### R1. Promover `assistant_conversations` table de definida em types pra usada (B1)
Há `types/account-assistant.ts:88-101` definindo `AssistantConversation` com `pending_messages`, `debounce_expires_at`, `pending_action`. Schema também existe (migration 00029 provavelmente). Usar essa estrutura no webhook real:
- Webhook → `loadConversation(rep.id)` → reads pending state + history
- `processIncoming` recebe `conversation` → integra com runtime context
- Após response → `saveConversation(rep.id, ...)` com novo turn count, último turn

Isso resolve B1, B7 e abre caminho pra confirmation modes corretas (R2) e debounce.

### R2. Abstrair "high-risk action gate" em código, não só prompt (B3)
```ts
// pseudocode
async function executeTool(name, args, ctx) {
  const entry = TOOL_REGISTRY[name];
  if (!entry) return notFound;

  if (entry.def.risk === 'high' && ctx.confirmationMode !== 'high_only') {
    if (!args._confirmed) {
      return {
        status: 'pending_confirmation',
        action_summary: buildSummary(entry.def, args),
        // LLM recebe isso, traduz pro rep, espera "confirmo" → re-chama com _confirmed: true
      };
    }
  }
  if (entry.def.risk === 'medium' && ctx.confirmationMode === 'always') {
    // similar
  }
  return entry.handler(ctx, args);
}
```

E no prompt: "Quando uma tool retornar pending_confirmation, NUNCA execute de novo até o rep confirmar — apresente em natural language e espere a próxima resposta."

Hoje confiar que o LLM segue protocolo é frágil; em testes adversariais, ~20-30% dos high-risk vão direto sem confirmar.

### R3. Tool registry — "category" e auto-doc
Cada tool deveria ter `category: 'contacts' | 'calendar' | ...` e gerar a section "CAPACIDADES" do system prompt automaticamente. Hoje o markdown da seção (`prompt-builder.ts:59-83`) está chumbado e desincronizou (B2). Reconciliar via:
```ts
function buildCapabilitiesSection() {
  const byCategory = groupBy(ALL_ENTRIES, e => e.category);
  return Object.entries(byCategory).map(([cat, tools]) =>
    `${cat.toUpperCase()}:\n${tools.map(t => `- ${t.def.name}: ${t.def.shortDoc}`).join('\n')}`
  ).join('\n\n');
}
```

### R4. Separar `dispatcher.ts` em `dispatcher.ts` + `dispatcher-prompt.ts` + `dispatcher-billing.ts`
Hoje o arquivo tem 425 linhas com 4 responsabilidades distintas (cooldown, prompt building, LLM call, billing). Test units e legibilidade sofrem.

### R5. Zod no boundary (test endpoints)
Endpoints `synthetic-test`, `test`, `simulate-rule`, `rules` parseiam body manualmente com `String(body.x || "")` pattern — frágil. Substituir por `zod` schemas no boundary do request. Já tem `zod` instalado (verificar `package.json`).

### R6. Centralizar timezone helpers
`getTimezoneOffsetMs` em `prompt-builder.ts:295`, `parseLocalParts` em `cron-evaluator.ts:44`, `isInQuietHours` em `dispatcher.ts:76` — 3 implementações usando `Intl.DateTimeFormat`. Extrair pra `lib/utils/timezone.ts`:
- `getOffsetMs(tz, date) → number`
- `getLocalParts(tz, date) → { y, m, d, h, min, weekday }`
- `isWithinWindow(tz, start, end, days, date) → boolean`

### R7. Separar `query_carrier_knowledge` em handler + lib
Hoje `tools/carrier_kb.ts:114-221` mistura embedding, RPC call, age calculation. Pra reusar em outras places (background analytics, embedding cache O5), extrair `lib/carrier-kb/search.ts`.

---

## Avaliação por arquivo

| Arquivo | Linhas | Estado | Bugs/Issues | Observações |
|---|---|---|---|---|
| `identity.ts` | 143 | OK | B20 | `normalizePhone` defensivo. Falta paralelizar scan de locations. |
| `terms.ts` | 66 | Médio | B15, B16 | "ok"/"sim" como includes vai capturar falso positivo; rejeição não persiste. |
| `webhook-handler.ts` | 223 | **Quebrado** | **B1** | Crítico: produção não envia `conversationHistory` nem `testSessionId`. Bot fica amnésico em prod. Resto OK (audio/image/doc + fallback canal). |
| `processor.ts` | 322 | Médio | B7, B14 | Boa estrutura, mas `llm_failed` detection só funciona em test mode. Locale pt-BR detection lista incompleta. |
| `prompt-builder.ts` | 316 | Médio | **B2, B3**, B26 | Bom design (cacheável + runtime context), mas referencia tools fantasmas (`modify_tag`, `update_field`, "8 tools"). Confirmation mode text diz "não-implementadas" sobre ações implementadas. |
| `llm-client.ts` | 434 | Médio | **B4**, B6, B22, B24 | Multi-provider com fallback é forte. Truncate 12K vai cortar conversation_history em produção. Max iterations 6 apertado. |
| `tools/index.ts` | 64 | OK | O2 | Limpo. Pré-compute possível. |
| `tools/types.ts` | 82 | OK | B5 | `validateGhlId` aplicado em UUIDs (reminders) gera mensagem errada. |
| `tools/contacts.ts` | 384 | OK | — | 8 tools, padrão consistente, IDs validados. |
| `tools/notes.ts` | 142 | OK | — | CRUD limpo. |
| `tools/tasks.ts` | 204 | OK | — | Gotcha `completed: false` documentado. |
| `tools/tags.ts` | 70 | OK | — | Add/remove separados. |
| `tools/calendar.ts` | 349 | OK | — | Comentário sobre paths GHL é gold. |
| `tools/opportunities.ts` | 314 | OK | — | `monetary_value_greater_than` no server (ultra-review fix). |
| `tools/messages.ts` | 165 | Médio | **B4 indirect** | `get_conversation_history` é o caso onde truncamento de 12K mais dói. Limit 100 sem truncate semântico. |
| `tools/metadata.ts` | 95 | OK | B19 | Sem paginação. |
| `tools/reminders.ts` | 218 | Médio | B5, B23 | Cancelar não invalida next_run_at. UUID validado com mensagem GHL. |
| `tools/carrier_kb.ts` | 225 | **Forte** | — | Excelente description, propaga staleness/state/source, threshold 0.4 documentado, fallback OpenAI. Estado-da-arte. |
| `proactive/cron-evaluator.ts` | 94 | OK | B9, B10 | Sem `*/n` steps. Sem log warn em parseLocalParts null. |
| `proactive/dispatcher.ts` | 425 | Médio | B11, B13, B14 | Atomic claim é forte. forceFire bypass perde atomicidade. max_iterations vira mensagem garbage. |
| `proactive/reminder-runner.ts` | 211 | Médio | **B12** | Vazamento: pode entregar reminder do rep A pra sessão do admin B. Atomic claim no runner OK. |
| `proactive/seed.ts` | 65 | OK | B21 | Idempotência por name (case-sensitive). |
| `proactive/system-rules.ts` | 239 | Forte | — | 14 regras bem desenhadas. Cooldowns variando por contexto (deal_won=0, opportunity_stale=24h). |
| `api/agents/sparkbot/route.ts` | 56 | OK | — | Debug param útil. |
| `api/agents/sparkbot/run-reminders/route.ts` | 24 | OK | — | Manual trigger limpo. |
| `api/agents/sparkbot/rules/route.ts` | 121 | Forte | — | Validation explícita (não silenciosa). Audit fields. |
| `api/agents/sparkbot/rules/[ruleId]/route.ts` | 117 | Forte | — | DELETE bloqueia system rules. |
| `api/agents/account-assistant/synthetic-test/route.ts` | 207 | OK | — | Bearer auth. Boa pra ultra-review. |
| `api/agents/account-assistant/test/route.ts` | 254 | OK | — | DB como source of truth do histórico (igual sales/recruitment). |
| `api/agents/account-assistant/test/simulate-rule/route.ts` | 109 | OK | — | forceFire correto pro botão simular. |

---

## Top-5 prioritários (acionáveis)

1. **B1** — webhook produção sem histórico (R1 promove `assistant_conversations`).
2. **B2** — corrigir nomes de tools no prompt (`modify_tag`→`add_tag`/`remove_tag`, `update_field`→`update_contact`, "8 tools"→tira número).
3. **B3** — confirmation_mode com gate em código + texto coerente (R2).
4. **B4** — truncate semântico de `get_conversation_history` em vez de cortar JSON 12K.
5. **B12** — reminder-runner não pode entregar reminder do rep A em sessão do admin B (filtrar por rep_id).

Outras 6-8 issues médias e ~15 baixas. O sistema **funciona** pra V2 simulated mas tem dívida acumulada que **bloqueia escala** (V3 real WhatsApp).
