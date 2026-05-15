# Bulk Message Segmentado / Condicional — Plano

> **Data:** 2026-05-15
> **Decision code (proposto):** H27
> **Origem:** Tentativa real do Gustavo Couto manhã de 2026-05-15 (logs em `sparkbot_messages` 09:14-09:33 ET)
> **Status:** PLANO — aguardando aprovação do Pedro pra implementar.

---

## 1. O que aconteceu (forensics)

Gustavo, manhã de 2026-05-15, queria mandar **mensagem promocional** ("último dia de ingresso da convenção") pros agentes que estão no stage **"Prova Agendada"** (11 pessoas) — depois mencionou também querer fazer fluxo similar pros do M0, com **mensagens diferentes por estágio**.

Resultado real: **falhou em 5 frentes diferentes.**

### Cronologia abreviada (ET)

| Hora | Evento | Estado |
|---|---|---|
| 09:14 | "lista agentes do M0" | ✅ Bot devolve 23 nomes (pós-fix Gustavo `stage_name`) |
| 09:17 | "lista agentes Prova Agendada" | ✅ Bot devolve 11 nomes |
| 09:18 | Gustavo manda template + pede disparo | ❌ Bot chama `preview_bulk_message(filter_tag='prova agendada')` → **not_found** (contatos têm STAGE, não TAG) |
| 09:20 | Bot apresenta UX confusa: "adicionar tag + bulk" ou "individual" | ⚠️ Gambiarra forçada |
| 09:21 | Gustavo escolhe "adicionar tag + bulk" | ⚠️ |
| 09:22 | Bot adiciona tag em 4 de 11 contatos e **para** | ❌ Job nem foi criado |
| 09:28 | Gustavo: "Não" (responde algo) | UX desalinhado |
| 09:30 | Gustavo confirma disparo individual pra os 11 | |
| 09:31 | Bot dispara 4 mensagens (Juliana, Crislorraine, Vicente, Eduardo) e para com **"Executei várias ações mas preciso parar aqui"** | ❌ Atingiu MAX_ITERATIONS=6, ainda faltavam 7 envios |
| 09:31 | Gustavo: "me confirma o que você fez?" | |
| 09:31 | Bot: **"Sendo honesto, NÃO EXECUTEI NADA AINDA"** | ❌❌ **MENTIRA INVERSA** — havia 4 sends com status=ok no turn anterior |
| 09:33 | Gustavo aponta "vi mensagens enviadas" | |
| 09:33 | Bot checa `list_bulk_jobs` (vazio) + `list_scheduled_messages` (vazio) → "as mensagens devem ter sido manuais" | ❌ Bot não cruzou com `sparkbot_messages` próprios tool_results recentes |

### 5 problemas críticos identificados

| # | Problema | Severidade | Causa raiz |
|---|---|---|---|
| **P1** | **Não dá pra fazer bulk filtrado por STAGE** | HIGH | `schedule_bulk_message` aceita só `filter_tag`. Stage requer tag manual (gambiarra) |
| **P2** | **Não dá pra fazer multi-segment** (mensagens diferentes por grupo) | HIGH | Schema atual = 1 filter + 1 template |
| **P3** | **MAX_ITERATIONS=6 mata disparo individual de N>4 contatos** | HIGH | Bot tenta N tool calls sequenciais e bate limite no meio |
| **P4** | **Bot mentiu INVERSO** — afirmou não ter executado quando executou 4 sends | **CRÍTICO** | Detector atual (commit 993970e) só pega hallucination DIRETA (afirmou fez sem ter feito). Inversa não pega |
| **P5** | **add_tag em loop também bateu MAX_ITERATIONS** | MEDIUM | Bot adicionou tag em 4 de 11 antes de parar |

P3+P5 são o mesmo bug. P4 é gravíssimo — quebra confiança do cliente (Gustavo deve estar confuso até agora).

---

## 2. Solução proposta — visão geral

Plano em 4 partes:

### Parte A. **Filter expandido**: bulk filtra por tag OU stage OU value range OU combo
### Parte B. **Multi-segment**: 1 job com N segmentos, cada um com filter + template próprio
### Parte C. **Anti-hallucination INVERSA**: detector que pega bot negando o que fez
### Parte D. **MAX_ITERATIONS bump + redirect** pra bulk: bot prefere job ao invés de loop

Cada parte standalone — Pedro pode aprovar 1, 2 ou todas.

---

## 3. Parte A — Filter expandido

### 3.1 Atual

`bulk_message_jobs.filter_config` (jsonb) sempre = `{ "tag": "X" }`. Single filter.

Schema da tool:
```ts
schedule_bulk_message({
  filter_tag: string,  // OBRIGATÓRIO
  message_template: string,
  ...
})
```

### 3.2 Proposto

`filter_config` aceita formato discriminated:

```typescript
type FilterConfig =
  | { type: "tag", tag: string }
  | { type: "stage", stage_id?: string, stage_name?: string, pipeline_id?: string }
  | { type: "opp_value", min?: number, max?: number, status?: "open"|"won"|"lost"|"all" }
  | { type: "combo", filters: Filter[], op: "and"|"or" }  // futuro V2
  | { type: "manual", contact_ids: string[] };           // pra contact_ids específicos
```

Tool signature nova (additive — não-breaking):
```ts
schedule_bulk_message({
  // Compat: filter_tag continua funcionando (vira FilterConfig type=tag)
  filter_tag?: string,
  // NOVOS (mutuamente exclusivos com filter_tag):
  filter_stage_name?: string,    // ex: "M0", "Prova Agendada"
  filter_stage_id?: string,      // UUID direto
  filter_opp_min_value?: number, // ex: 5000 (M2+)
  filter_opp_max_value?: number, // ex: 19999 (M2 strict)
  filter_pipeline_id?: string,   // limita a 1 pipeline
  filter_contact_ids?: string[], // lista manual

  message_template: string,
  ...
})
```

Handler resolve filter → `resolveContactsByFilter()`:

```typescript
async function resolveContactsByFilter(
  ctx: ToolContext,
  filter: FilterConfig
): Promise<{ contacts: ContactSummary[], truncated: boolean }> {
  switch (filter.type) {
    case "tag":
      return fetchContactsByTag(ctx.ghlClient, ctx.locationId, filter.tag);

    case "stage":
      // Usa list_opportunities (pós-fix Gustavo) com paginação completa
      const opps = await ctx.ghlClient.get<...>("/opportunities/search", {
        location_id: ctx.locationId,
        pipeline_stage_id: filter.stage_id,
        // paginação via startAfterId até complete
      });
      // Dedup contact_ids (opp pode estar duplicada?), faz get_contact pra cada
      // OU melhor: extract contact.id + contact.name + contact.phone do response da opp
      return extractContactsFromOpps(opps);

    case "opp_value":
      // monetary_value_greater_than = filter.min server-side
      // monetary_value_less_than = filter.max server-side
      // status = filter.status (default "open")
      // ...
      return extractContactsFromOpps(opps);

    case "manual":
      // Fetch each by id paralelizado
      return fetchContactsById(ctx.ghlClient, filter.contact_ids);
  }
}
```

### 3.3 Resolver stage_name automaticamente

Mesma lógica do `list_opportunities` (commit `ba29fea`): se `filter_stage_name` passado sem `filter_stage_id`, chama `/opportunities/pipelines` pra resolver. Ambíguo → erro com candidates.

### 3.4 Mudanças DB

**Nenhuma migration necessária** — `filter_config jsonb` já aceita qualquer shape. Só adicionamos types novos no handler.

### 3.5 Effort Parte A

| Tarefa | Tempo |
|---|---|
| Refactor `fetchContactsByTag` → `resolveContactsByFilter` com switch por type | 60min |
| Adicionar 4 novos params no schema `schedule_bulk_message` + `preview_bulk_message` | 30min |
| `extractContactsFromOpps` helper (de list_opportunities response) | 30min |
| Stage_name auto-resolve (reuso lógica de list_opportunities) | 20min |
| Smoke test 6 cenários (tag legacy, stage_name, stage_id, opp_value range, manual ids, combo de stage+min_value) | 40min |
| **Total Parte A** | **3h** |

---

## 4. Parte B — Multi-segment

### 4.1 Use case Gustavo

> "Quero mandar mensagem pros M0 dizendo X, pros M3 dizendo Y, pros Prova Agendada dizendo Z. Tudo num só comando."

### 4.2 Schema da tool

```ts
schedule_bulk_message_multi({
  segments: [
    {
      label: "M0",                    // descritivo, vira coluna de audit
      filter_stage_name: "M0",
      message_template: "Bem-vindo {first_name}! Pra começar...",
    },
    {
      label: "Prova Agendada",
      filter_stage_name: "Prova Agendada",
      message_template: "Olá {first_name}, hoje é o último dia...",
    },
    {
      label: "M3 (alto valor)",
      filter_stage_name: "M3",
      message_template: "Parabéns {first_name} pelo progresso!",
    },
  ],
  // Settings compartilhados entre segments
  variation_mode?: "none"|"light"|"medium",      // default 'light'
  interval_seconds?: number,                     // default 90
  jitter_seconds?: number,                       // default 30
  delivery_channel?: "whatsapp_web_sms"|"whatsapp_api",
  start_at?: string,                             // ISO
  interleave_segments?: boolean,                 // default false (sequencial); true = intercalado pra distribuir tipos
})
```

### 4.3 Modelo de dados

**Reuso do `bulk_message_jobs`** — 1 job com `filter_config.type="multi"`:

```json
{
  "type": "multi",
  "segments": [
    {
      "label": "M0",
      "filter": {"type": "stage", "stage_name": "M0", "stage_id": "e1f57dee-..."},
      "message_template": "Bem-vindo {first_name}!",
      "resolved_contact_count": 23
    },
    ...
  ],
  "interleave": false
}
```

**Em `bulk_message_recipients`**: cada row já tem `contact_id`, `scheduled_at`, `message_template_used` (jsonb com texto final pós-variação). Adicionamos coluna nova OU usa metadata:

Adicionar coluna **`segment_label text NULL`** em `bulk_message_recipients` (migration nova) pra auditar qual segmento cada recipient pertence.

Recipients são criados na mesma tabela mas com `segment_label` setado. Cron runner agnóstico — processa todos sequencialmente.

### 4.4 Resolução de overlap

Se um contato está em 2 stages (improvável mas possível), ele recebe 2 mensagens? Decisão:

**Default: dedup por contact_id** — primeiro segment que encontra contato "ganha" (ordem dos segments no array). Adicionar param `allow_duplicate_contacts: boolean` (default false) pra override.

### 4.5 Validações

- `segments.length ≥ 2` (senão use single)
- `segments.length ≤ 10` (anti-runaway)
- Total resolved contacts ≤ daily cap
- Cada segment tem pelo menos 1 contato (warn se vazio mas não bloqueia)

### 4.6 Effort Parte B

| Tarefa | Tempo |
|---|---|
| Migration 00065: coluna `segment_label` em bulk_message_recipients | 15min |
| Tool nova `schedule_bulk_message_multi` (schema + handler) | 90min |
| Tool nova `preview_bulk_message_multi` (calcula por segment + total) | 45min |
| Dedup logic (`allow_duplicate_contacts` default false) | 30min |
| Interleave logic (`interleave_segments=true` intercala por timestamp) | 30min |
| `list_bulk_jobs` + `get_bulk_job_progress` mostram breakdown por segment | 45min |
| Smoke test 6 cenários multi-segment | 60min |
| **Total Parte B** | **5h** |

---

## 5. Parte C — Anti-hallucination INVERSA

### 5.1 Problema

Detector atual (commit `993970e`, 2 camadas) pega: bot afirma "X feito" SEM tool_call → signal.

Não pega: bot **NEGA ter feito** quando **EXECUTOU** tool com status=ok. Caso Gustavo 09:31:43.

### 5.2 Fix proposto

Adicionar 3ª camada no `detectHallucination()`:

```typescript
const DENIAL_REGEX = /\b(n[aã]o\s+executei|n[aã]o\s+fiz|n[aã]o\s+enviei|n[aã]o\s+mandei|n[aã]o\s+criei|nada\s+foi\s+(enviad|criad|salv|agendad|mandad)[ao]|n[aã]o\s+rodei|sem\s+executar|n[aã]o\s+cheguei\s+a\s+(executar|enviar|criar|salvar))\b/i;

function detectInverseHallucination(
  responseText: string,
  toolsCalled: string[],
): boolean {
  if (!DENIAL_REGEX.test(responseText)) return false;
  const writeToolsCalled = toolsCalled.filter(isWriteTool);
  return writeToolsCalled.length > 0;
  // Bot negou + tem write tool com status=ok = inverse hallucination
}
```

Signal type=`failure` severity=`critical` (mais grave que hallucination direta — quebra confiança ativamente).

Bonus: bot deveria ter ACCESS a memory de últimos N turns. Hoje processor passa `conversationHistory`. Verificar se LLM realmente vê tool_results dos últimos 2-3 turns. Se não, prompt-fix:
> "Antes de afirmar 'não fiz X', SEMPRE revise os tool_results dos seus últimos 3 turns. Se há tool_call com status=ok que corresponde, ADMITA que executou."

### 5.3 Effort Parte C

| Tarefa | Tempo |
|---|---|
| Adicionar DENIAL_REGEX + `detectInverseHallucination` | 20min |
| Atualizar processor pra rodar detecção em ambos sentidos | 15min |
| Reforçar prompt-builder com regra "revisar tool_results antes de negar" | 15min |
| Smoke test 3 cenários (negação válida sem tool / negação inválida com tool / negação parcial) | 20min |
| **Total Parte C** | **1h 10min** |

---

## 6. Parte D — MAX_ITERATIONS + redirect pra bulk

### 6.1 Problema

`MAX_ITERATIONS=6` em `llm-client.ts:14`. Cada iteration LLM pode fazer N tools em paralelo. Mas se LLM resolve fazer 1 por iteration (caso Gustavo: 4 sends + 1 listOpportunities = 5 iterations, parou na 6 com "preciso parar"), bate o teto.

### 6.2 Opção 1: Bump MAX_ITERATIONS

`MAX_ITERATIONS=10` ou `15`. Risco: custo + tempo de resposta + risco loop infinito se LLM bugar.

### 6.3 Opção 2 (recomendada): Bot redireciona N≥3 sends pra bulk job

Adicionar regra no prompt:
> "Se rep pede pra mandar mensagem pra ≥3 contatos individualmente, NÃO chame send_message_to_contact em loop. Use `schedule_bulk_message` com `filter_contact_ids=[...]` (manual list). Bulk roda em backend espaçado, sem bater limite de tool calls do bot."

Isso elimina o caso de uso problemático. Bot só faz 1 tool call (schedule_bulk_message), runner processa N envios em backend com drip + audit.

### 6.4 Opção 3: Catch interno do max_iterations

Quando `stopped_reason="max_iterations"` E houve tool_calls de write → resposta extra "Executei X de Y. Os Z restantes ficaram pendentes. Quer que eu retome?" (não mente como o caso atual).

Recomendação: **fazer (2) + (3)** combinados. (1) não é necessário se (2) funciona.

### 6.5 Effort Parte D

| Tarefa | Tempo |
|---|---|
| Adicionar `filter_contact_ids` em schedule_bulk_message (Parte A já cobre `manual` type) | 0 (já em Parte A) |
| Prompt-builder: "≥3 sends individuais → use schedule_bulk_message com filter_contact_ids" | 20min |
| Catch max_iterations no processor: resposta semântica + lista do que foi feito | 30min |
| Smoke test 2 cenários (rep pede 5 sends → bot usa bulk; rep pede 1 send → bot usa send direto) | 20min |
| **Total Parte D** | **1h 10min** |

---

## 7. Ordem recomendada de implementação

| Ordem | Parte | Razão |
|---|---|---|
| 1º | **C** (anti-hall inversa) | 1h, baixo risco, fecha gap crítico de confiança do Gustavo |
| 2º | **D** (max_iterations redirect) | 1h, complementa C com Opção 2+3, evita repetir caso de hoje |
| 3º | **A** (filter expandido) | 3h, desbloqueia stage filter (caso #1 do Gustavo manhã) |
| 4º | **B** (multi-segment) | 5h, depende de A, é a feature "premium" pedida |

**Total estimado: 10h efetivas dev.**

Pode quebrar em 4 PRs separados.

---

## 8. Riscos / pontos abertos pra decidir

1. **Backward compat `filter_tag`**: manter por quanto tempo? Sugestão: indefinido (additive, não-breaking).
2. **`filter_contact_ids` cap**: max quantos contatos em lista manual? Sugestão: 100 por job (alinhado com daily_cap).
3. **Multi-segment dedup default**: contact em 2 stages recebe 1 ou 2 msgs? Sugestão: 1 (dedup por contact_id, primeiro segment ganha). Override com `allow_duplicate_contacts`.
4. **Interleave default**: sequencial (todos M0 primeiro, depois M3) OU intercalado (alterna)? Sugestão: sequencial (mais previsível pro rep).
5. **Audit em `/admin/signals`**: criar signal `idea` quando multi-segment job rodar? Pedro avalia uso. Sugestão: sim, severity=low, fingerprint estável por rep_id.
6. **`schedule_bulk_message_multi` é tool nova OU sobrecarrega `schedule_bulk_message`?** Recomendação: **tool nova**. Mantém schema antigo claro pra single, novo pra multi. LLM escolhe melhor.

---

## 9. Smoke tests (consolidado)

12 cenários cobrindo tudo:

| # | Cenário | Tool | Expectativa |
|---|---|---|---|
| 1 | Bulk single por tag (legacy) | `schedule_bulk_message(filter_tag='X')` | Funciona igual antes |
| 2 | Bulk single por stage_name | `schedule_bulk_message(filter_stage_name='M0')` | Auto-resolve + 23 contatos enfileirados |
| 3 | Bulk single por stage_id | `schedule_bulk_message(filter_stage_id='uuid')` | Direct, 11 contatos enfileirados |
| 4 | Bulk single por opp value range | `schedule_bulk_message(filter_opp_min_value=20000)` | M3+ via monetary_value filter |
| 5 | Bulk single manual contact_ids | `schedule_bulk_message(filter_contact_ids=[id1,...id11])` | Caso Gustavo hoje — 11 envios em 1 job |
| 6 | Combo stage + min_value | filter_stage_name='M3' + filter_opp_min_value=20000 | M3 e ≥20k |
| 7 | Multi segment 2 stages | `schedule_bulk_message_multi(segments=[M0+template_a, M3+template_c])` | 2 segments, 2 templates |
| 8 | Multi segment 3 stages com overlap | Contato X em M0 e Prova Agendada → recebe só msg de M0 (dedup) | |
| 9 | Multi segment com `interleave_segments=true` | Intercala M0 + M3 + Prova em vez de sequencial | |
| 10 | Negação válida sem tool | Bot: "Não criei ainda" + 0 tools no turn | NÃO dispara inverse detector |
| 11 | Negação inválida com tool | Bot: "Não executei nada" + tem create_note ok no turn | DISPARA inverse detector (critical) |
| 12 | Bot redirect ≥3 sends → bulk | Rep: "manda pra X, Y, Z" → bot chama schedule_bulk_message com manual ids | |

---

## 10. Decisão pendente do Pedro

Pra começar implementação, preciso confirmação:

1. ✅ ❓ Aprova as 4 partes? Ou prefere implementar só algumas?
2. ✅ ❓ Ordem 1º→4º (C→D→A→B) faz sentido pra você?
3. ✅ ❓ Pontos abertos da seção 8: alguma resposta diferente das sugestões?

Após aprovação, eu implemento, commito e marco H27 em DECISIONS.md.
