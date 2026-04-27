# Ultra Review do Sparkbot V2 — Findings

**Data:** 2026-04-27
**Escopo:** Sparkbot V2 + comparativo com sales/recruitment + DB schema
**Metodologia:** synthetic chats (12 cenários), análise estática (Explore agent), DB inspection (MCP), cross-system review

---

## 🎯 Sumário Executivo

| Categoria | Severidade | Achados |
|---|---|---|
| Não-implementados (stubs em prod) | 🔴 | 3 |
| Race conditions / atomicity | 🔴 | 3 |
| Edge cases boundary | 🔴🟡 | 4 |
| Validações incompletas | 🟡 | 5 |
| Configurabilidade hardcoded | 🟡 | 4 |
| UI/UX inconsistente | 🟡 | 3 |
| Limpeza/débito técnico | 🟢 | 6 |

**O que está funcionando muito bem:**
- ✅ Tool calling iterativo do Claude — multi-step orchestration impecável (ex: cancel_reminder chamou list_my_reminders primeiro)
- ✅ Validação `validateGhlId` rejeita IDs inventados ("contato 5" → resposta correta)
- ✅ Desambiguação fluida — quando há múltiplos matches, lista candidatos e pergunta
- ✅ Sessões persistentes + polling — contexto preservado entre turns + msgs proativas aparecem no chat sem refresh
- ✅ pg_cron + pg_net rodando a cada 30s — substituiu Vercel Hobby cron diário
- ✅ Cache hit Claude alto (58-87% nas chamadas medidas)
- ✅ 14 system rules seedadas e editáveis

**O que precisa atenção urgente (top 5 críticos):**
1. **Modo "real" totalmente desabilitado** — scheduled rules NUNCA disparam de verdade ([cron route:62-87](src/app/api/cron/sparkbot-proactive/route.ts#L62)). Reactive polling é stub vazio. *(Batch 6 mantém como skipped_disabled por design até V3 WhatsApp.)*
2. ✅ **~~Race condition em cooldown~~** — Resolvido em Batch 3 via `try_claim_dispatch_slot` SQL function (atomic INSERT ON CONFLICT)
3. ✅ **~~Tool result sem truncação~~** — Resolvido em Batch 2: `MAX_TOOL_RESULT_CHARS=12000` + `truncateToolResult()` em llm-client.ts
4. ✅ **~~Quiet hours boundary~~** — Resolvido em Batch 1: `<=` em vez de `<`
5. ✅ **~~Reminder runner com timezone hardcoded NY~~** — Resolvido em Batch 2: `computeNextRun(cron, from, timezone)` resolve TZ por location

**Batches aplicados (todos no main + deploy):**
- Batch 1-2: critical reliability (quiet hours, parse-loop, tool truncation, reminder TZ)
- Batch 3: race condition cooldown via atomic SQL claim
- Batch 4: extrair lib/ghl/operations.ts (DRY entre sales/sparkbot)
- Batch 5: validações (cron POSIX completo, timezone IANA, min_value server-side)
- Batch 6: resilience (OpenAI fallback real + cleanup cron)
- Batch 7: nice-to-have (validações explícitas, audit columns, get_appointment)

---

## 1. Synthetic Chat Tests (12 cenários)

Endpoint: `POST /api/agents/account-assistant/synthetic-test` com Bearer auth.
Rep: `+17867717077` (4 locations vinculadas, "John Doe").

| # | Cenário | Resultado | Tools | Tokens | Tempo |
|---|---|---|---|---|---|
| 1 | "bom dia, o que tenho hoje?" | ✅ Resumo coerente com data real | `list_appointments`, `list_opportunities` | 11421 in (cache 58%) / 218 out | 9.5s |
| 2 | "olha aquele Pedro lá" | ✅ Pediu desambiguação | `search_contacts` | — | 8.4s |
| 3 | "me lembra em 5min" | ✅ Agendou reminder | `schedule_reminder` | — | 4.9s |
| 4 | "todo dia útil 18h..." | ✅ Recurring + cron `0 18 * * 1-5` | `schedule_reminder` | — | 5.5s |
| 5 | "nota + task pra Pedro Henrique" | ✅ Pausou pra desambiguar antes de qualquer ação | `search_contacts` | — | 5.8s |
| 6 | "cria nota no contato 5" | ✅ Rejeitou ID inventado | (nenhuma) | — | 2.8s |
| 7 | Áudio: "fechei venda do Cristian de 1668" | ✅ Buscou contato + pediu confirmação antes de mover stage | `search_contacts` | — | 13.6s |
| 8 | "lista meus lembretes" | ✅ Listou 2 lembretes formatados | `list_my_reminders` | — | 4.9s |
| 9 | Multi-turn: "qual phone do Cristian Dias?" → "e o email?" | ✅ Manteve contexto, segundo turn entendeu "dele" | `search_contacts` | — | 5.5s |
| 10 | "cancela o lembrete recorrente" | ✅ Listou + cancelou pelo ID correto | `list_my_reminders`, `cancel_reminder` | — | 5.8s |
| 11 | "minhas reuniões essa semana?" | ✅ Tom natural, sem reuniões | `list_appointments` | — | 3.9s |
| 12 | "opps abertas > 1000 USD" | ✅ Filtrou e mostrou 1 opp | `list_opportunities` | — | 6.9s |

### 🟡 Issues observados nos chats

1. **Markdown bullet list quando prompt diz "texto corrido"** — Cenário 1 retornou `**Hoje:** Nenhum...` com `**`. O prompt-builder.ts:13 diz "Respostas curtas. Texto corrido, não bullet list". Claude está ignorando essa regra. **Sugestão:** mover essa regra pro topo do prompt + reforço com exemplo concreto.

2. **Cenário 12 (opps > 1000)** — Mostrou 1 opportunity mas não esclareceu se é o total real ou truncado. Bate com finding do Explore: filter `min_value` é client-side após pegar 100, perdendo opps de alto valor que estão fora da janela. **Sugestão:** passar `min_value` pra GHL como query param ou avisar quando truncado.

3. **Tom às vezes corporativo demais** — "Quer ver mais detalhes ou fazer algo com ela?" (cenário 12) é OK mas comum, não pareceu colega. Comparar com cenários onde tom ficou mais natural ("Cancelado. O lembrete diário não vai mais disparar."). **Sugestão:** adicionar mais exemplos de "voz de colega" no prompt.

4. **Cenário 7 (áudio)** — perfeitamente natural ("Tem um Cristian Cesar Ferreira Araujo... É ele? Antes de mover pra won quero confirmar."). **Excelente** — confirmação antes de ação medium/high.

---

## 2. Análise Estática (Explore Agent)

Análise de 41 tools, dispatcher, prompt-builder, llm-client, UI, cron.

### 🔴 Críticos

#### A. Modo "real" totalmente desabilitado
- **Local:** [src/app/api/cron/sparkbot-proactive/route.ts:62-87, 153-160](src/app/api/cron/sparkbot-proactive/route.ts)
- **Problema:** Cron processa scheduled rules mas grava `status: "skipped_disabled"` em vez de dispatchar. `processReactivePolling` retorna `{fired:0, skipped:0}` sempre — implementação ausente.
- **Impacto:** **Nenhuma regra reativa OU scheduled dispara de verdade hoje.** Só reminders agendados pelo rep funcionam (via reminder-runner). UI mostra 14 regras "ativas" mas só `Briefing pré-reunião` etc são placebo.
- **Fix V3:** Implementar `processReactivePolling` com lookups por tipo de evento (appointment_upcoming via lista de calendars + filter por offset, opportunity_stale via lookup created_at de opps em open >X dias, etc).

#### B. Race condition em cooldown (dispatcher upsert sem lock)
- **Local:** [dispatcher.ts:141-152](src/lib/account-assistant/proactive/dispatcher.ts#L141)
- **Problema:** Dois crons paralelos (cron principal + manual "Simular agora") podem ler `last_fired_at < cutoff` simultaneamente, ambos passar cooldown check, ambos upsert. Resultado: regra disparada 2x.
- **Impacto:** Custo duplicado, msg duplicada pro rep.
- **Fix:** Usar `SELECT ... FOR UPDATE` ou Postgres advisory lock por (rep_id, rule_id, target_id).

#### C. Tool result truncation silenciosa
- **Local:** [llm-client.ts:232, 244](src/lib/account-assistant/llm-client.ts#L232)
- **Problema:** `JSON.stringify(result)` sem limit de tamanho. `get_conversation_history` com 100 msgs pode ser MB; LLM trunca silenciosamente, alucinando sobre dados que não viu.
- **Fix:** `JSON.stringify(result).slice(0, 10000)` com sufixo `(... truncado, X items omitted)`.

#### D. Quiet hours off-by-one boundary
- **Local:** [dispatcher.ts:94-96](src/lib/account-assistant/proactive/dispatcher.ts#L94)
- **Problema:** Janela cruzando meia-noite (`start=22:00, end=07:00`): teste `nowMin >= startMin || nowMin < endMin`. Em `06:59`, `nowMin=419`, `endMin=420`, retorna `false` → marca como FORA de quiet hours (acordou 1min antes).
- **Fix:** `<=` em vez de `<` no segundo branch.

#### E. Reminder runner com timezone hardcoded
- **Local:** [reminder-runner.ts:155-206](src/lib/account-assistant/proactive/reminder-runner.ts#L155)
- **Problema:** `computeNextRun(cron_expr, from)` chama `shouldFireCron(cron, "America/New_York", cursor)` — timezone fixo. Se rep agendou recurring em PT-BR (UTC-3), proximas execuções calculadas em NY (UTC-4 ou -5), disparam 1-3h fora.
- **Fix:** Buscar timezone da location via `task.location_id` e passar pra `shouldFireCron`.

### 🟡 Importantes

| # | Local | Problema | Fix sugerido |
|---|---|---|---|
| 1 | `llm-client.ts:75-94` | Fallback OpenAI é stub — retorna msg genérica "Tive um problema técnico" sem tentar OpenAI de verdade | Implementar tool use OpenAI ou remover "fallback" das descriptions |
| 2 | `llm-client.ts:14` | `MAX_ITERATIONS = 6` hardcoded | Mover pra config ou rule.max_iterations override |
| 3 | `cron-evaluator.ts:29` | Day-of-month e month ignorados (`* *`); cron tipo `0 9 15 * 1` (dia 15 OU segunda) só dispara segundas | Implementar parsing completo ou documentar limite |
| 4 | `dispatcher.ts:67-70` | Timezone inválido (typo) faz `Intl.DateTimeFormat` retornar UTC silenciosamente | Validar tz contra IANA list ou catch + fallback explícito |
| 5 | `tools/contacts.ts:214-217` | `update_contact.custom_fields` mapeia `cf.key` → `id` mas GHL aceita id OU fieldKey, ambíguo | Forçar admin a usar `list_custom_fields` antes |
| 6 | `tools/opportunities.ts:50` | `min_value` filter client-side; pega 100 mais recentes, perde opps grandes fora da janela | Passar `min_value` na query GHL |
| 7 | `reminder-runner.ts:86-100` | Fallback session_id busca última sessão da location inteira (pode ser de outro rep) | Filtrar por `eq("rep_id", task.rep_id)` |
| 8 | `tools/messages.ts:129-133` | Channel enum hardcoded (sem GBM, etc) | Tool dedicada `list_available_channels` |
| 9 | `route.ts:124-134` | `getEligibleReps` ignora `agent_id`, busca todos os reps; em V3 multi-agent vaza entre agents | Filtrar por `agent.location_id` ou `allowed_ghl_users` |
| 10 | `route.ts:71` | `shouldFireCron` recebe timezone do rep, mas se admin muda TZ da location depois, cron expression antigo desalinha | Guardar `created_tz` na rule ou re-validar |

### 🟢 Nice-to-have

- ✅ ~~Sem `get_appointment_by_id` global~~ — Adicionado em Batch 7 ([calendar.ts](src/lib/account-assistant/tools/calendar.ts))
- Tool descriptions genéricas — sem exemplos de uso *(deixado pra próximo ciclo, baixo ROI)*
- ✅ ~~Sem audit log de quem editou regra~~ — Migration 00035 adiciona `created_by_user_id` + `last_modified_by_user_id`, populado nos handlers POST/PUT
- Tags case-sensitive (admin pode criar "Prospect" e "prospect") *(GHL-side, não controlamos)*
- Sem dedup de reminders idênticos *(low frequency em prática)*
- Logging de "regra skippada" sem motivo legível *(coluna `status` cobre os 3 motivos principais)*

---

## 3. DB Schema Review

| Tabela | Rows | RLS | Policies | Indexes | Tamanho |
|---|---|---|---|---|---|
| `rep_identities` | 1 | ✅ | 1 | 3 (pkey, phone unique, idx_phone) | 64 kB |
| `assistant_conversations` | 0 | ✅ | 1 | 3 (pkey, rep, debounce partial) | 32 kB |
| `assistant_proactive_rules` | 14 | ✅ | 1 | 2 (pkey, agent+enabled+type) | 48 kB |
| `assistant_alert_state` | 0 | ✅ | 1 | 4 (pkey, unique constraint, lookup, recent) | 40 kB |
| `assistant_scheduled_tasks` | 1+ | ✅ | 1 | 3 (pkey, due partial, rep+status+next) | 64 kB |
| `agent_test_sessions` | 7 | ✅ | 1 | (compartilhada com sales) | 96 kB |
| `agent_test_messages` | 50+ | ✅ | 1 | (compartilhada com sales) | 144 kB |

### 🟢 Indexes adequados pras queries hot

- `assistant_scheduled_tasks` tem index parcial `WHERE status='pending'` — boa otimização pro cron
- `assistant_alert_state` tem unique constraint em `(rep_id, rule_id, target_id)` — previne duplicatas estruturalmente
- `rep_identities.phone` é unique — bom (1 rep por phone)

### 🟡 Gaps observados

- **Sem index em `assistant_alert_state(last_fired_at)`** isoladamente — query "alertas órfãos antigos" pode scanear toda a tabela
- **Sem cleanup automatizado** de:
  - `assistant_scheduled_tasks` com `status='completed'` antigos (cresce indefinidamente)
  - `assistant_alert_state` antigos (cresce com cada disparo)
- **`assistant_conversations` está vazia** — tabela não está sendo usada (era pra V3 webhook real). Pode ser removida ou marcada como placeholder
- **Sem foreign key** entre `assistant_scheduled_tasks.task_payload->>'test_session_id'` e `agent_test_sessions.id` — admin deleta sessão e reminder fica com referência inválida (handler cobre, mas dados ficam órfãos)

### 🔴 Crítico

- **Nenhum.** Schema está sólido pra V2.

---

## 4. Análise de pg_cron

Job ativo (`cron.job`):
```
jobid 3, name 'sparkbot-proactive', schedule '30 seconds', active TRUE
```

Conditional fire query:
```sql
EXISTS (SELECT 1 FROM assistant_scheduled_tasks WHERE status='pending' AND next_run_at <= now())
OR EXISTS (SELECT 1 FROM assistant_proactive_rules WHERE rule_type='scheduled' AND enabled=true)
```

**Issue:** Segundo EXISTS sempre é `true` (14 scheduled rules enabled), então cron vai fazer HTTP call a cada 30s mesmo sem trabalho real.

- **Local:** [migration 00032](supabase/migrations/00032_sparkbot_pg_cron.sql)
- **Severidade:** 🟡 importante (custo desnecessário)
- **Fix:** Adicionar filter "scheduled rule deveria rodar agora" — usar comparação de hora com cron_expr no SQL, ou só disparar se houver scheduled task pendente:

```sql
WHERE EXISTS (SELECT 1 FROM assistant_scheduled_tasks WHERE status='pending' AND next_run_at <= now())
```

(Remove o segundo EXISTS, scheduled rules dispatcham via outro mecanismo quando V3 chegar.)

---

## 5. Cross-System Review (Sales/Recruitment vs Sparkbot)

### 5.1 Tabela comparativa por área

| Área | Sales/Recruitment | Sparkbot | Divergência |
|---|---|---|---|
| **Pipeline** | webhook → debounce queue → processor → JSON schema → action-executor → GHL | webhook → processor → tool-calling iterativo → tools direto → GHL | Paradigmas diferentes |
| **LLM** | OpenAI (`openai-client.ts`), JSON parse | Claude 4.6 (`llm-client.ts`), tool use API + multi-turn loop | Sparkbot mais avançado |
| **Operations** | 7 ações em `action-executor.ts` | 41 tools em 9 módulos | Sparkbot 5x+ rico |
| **History** | Pulled do GHL conversation, 30 turnos, comprimido | Test-only (agent_test_messages); GHL prod TBD em V3 | Sparkbot incompleto |
| **Parse failure** | ✅ Conta 2 falhas → pause `ai_paused_reason` | ❌ Não tem mecanismo | **🔴 GAP** |
| **Caching** | OpenAI auto cache_control | Claude `cache_control: ephemeral` explícito | Ambos OK |
| **DB sessions** | `agent_test_sessions` filtrada por agent_id | Mesma tabela compartilhada | OK |
| **Billing** | `trackAndCharge`, action_type por agente | Idem | OK, mesmo sistema |

### 5.2 🔴 Cross-system críticos (do Explore agent 2)

#### A. Sparkbot sem parse failure detection
- **Risco:** Sparkbot pode entrar em loop de tool calls mau-formados (ex: search_contacts com query vazia repetidamente). O `MAX_ITERATIONS=6` corta no 6º turno mas até lá gastou 6 × 2500 tokens, retorna msg genérica de erro, sem aprendizado.
- **Sales:** detecta `parse_failed`, conta 2 seguidas, pausa com motivo registrado.
- **Fix Sparkbot:** propagar `parse_failed` em `processIncoming` igual o sales faz, registrar em `assistant_alert_state` ou nova coluna em `assistant_conversations.ai_parse_failure_count`.
- **Effort:** 2h

#### B. `hubLocationId` undefined causa fallthrough silencioso
- **Local:** [inbound-message/route.ts:148](src/app/api/webhooks/inbound-message/route.ts#L148)
- **Risco:** Se `ASSISTANT_HUB_LOCATION_ID` não configurado, msgs do Hub caem em sales/recruitment routing (sem hub match). Em transição (admin configura DEPOIS de tráfego começar), há período de duplicação ou roteamento errado.
- **Fix:** Throw warning audível se ENV ausente em prod + adicionar test garantindo skip explícito quando null.
- **Effort:** 30 min

### 5.3 🟡 Duplicação de operações GHL

3 lugares implementam **`add_tag`** com mesma lógica:
- `src/lib/ai/action-executor.ts` (sales/recruitment)
- `src/lib/account-assistant/tools/contacts.ts` (Sparkbot)
- `src/lib/account-assistant/tools/tags.ts` (Sparkbot, agora separado)

Idem `update_field`, `move_pipeline`, `book_appointment`.

- **Fix:** Extrair `src/lib/ghl/operations.ts` com funções primitivas (`addTagToContact`, `updateContactField`, `bookAppointment`). Tools/actions chamam essas helpers.
- **Effort:** 3h
- **Benefício:** Reduz código duplicado, centraliza error handling, facilita manutenção. Quando GHL muda spec, fix em 1 lugar.

### 5.4 🟡 Booking error detection com strings soltas

[action-executor.ts:78](src/lib/ai/action-executor.ts) tem:
```typescript
const isBookingError = ... && (
  failedActionError.includes("available") ||
  failedActionError.includes("conflict") ||
  failedActionError.includes("calendario") ||  // typo? PT-BR mistura?
  ...
);
```

- **Risco:** Cada nova msg de erro do GHL requer update manual. Frágil.
- **Fix:** Helper `isBookingConflictError(err)` em `lib/ghl/client.ts` com lista canônica.
- **Effort:** 1h

### 5.5 💡 Oportunidades futuras

- **Portar Sales pra tool use API** (Q3, ~40h) — robustez + economia. Tool use é 99% reliable vs JSON parse 97%; Claude Sonnet 4.6 é 50% mais barato que GPT-4.1. **Mas:** sales é prod com 100+ locations — exige A/B test e branch experimental. Não urgente.
- **Unificar `scheduled_followups` + `assistant_scheduled_tasks`** — mesma semântica (agendamento), schemas diferentes. Tabela única `scheduled_tasks_unified` com `type` discriminador. **Mas:** migração de dados é risky, ROI baixo. **Pulável.**

### 5.6 ❓ Risco latente: vazamento de test sessions entre agents

**Cenário hipotético:** Se algum endpoint filtra mal `agent_id` em `agent_test_sessions`, msgs de Sales podem aparecer em chat do Sparkbot.

**Verificação:** Endpoint `/api/agents/test/sessions/[sessionId]/route.ts` filtra por `location_id` (linha 25) — Sparkbot tem location_id da Hub, sales/recruitment tem location do admin. **Diferentes locations, sem vazamento.** ✅

Mas o endpoint `/api/agents/test/sessions/route.ts` (POST cria sessão) não força `agent.type` matching — admin podia criar sessão "sparkbot" pra agent_id de sales por engano. **Pequeno risco, sem dataleak real** (sessão fica órfã se agent não bate). **Sugestão:** validar que `agent_id` é tipo `account_assistant` quando endpoint Sparkbot é chamado.

---

## 6. Gap Analysis V2 → V3 (WhatsApp Real)

Quando WhatsApp Hub for habilitado:

### Backend
1. **Implementar `mode: "real"` no dispatcher** ([dispatcher.ts:267-272](src/lib/account-assistant/proactive/dispatcher.ts#L267)) — atualmente só log de warning. Precisa: enviar via GHL conversations/messages do Hub para contato_id correspondente ao rep.
2. **Implementar `processReactivePolling`** ([route.ts:153-160](src/app/api/cron/sparkbot-proactive/route.ts#L153)) — uma função por tipo de evento:
   - `appointment_upcoming`: query calendar events em janela futura, gerar `target_id=appointment.id`, dispatch
   - `post_meeting`: query events que acabaram nos últimos 30 min sem follow-up
   - `appointment_no_show`: query events com `appointmentStatus='noshow'` recente
   - `opportunity_stale`: query opps em mesmo stage há >X dias
   - `task_due_soon`: query tasks com due_at próximo
   - `task_overdue`: query tasks com due_at passado
   - `inbound_unanswered`: query conversations com unread_count>0 há >X horas
   - `deal_won`: query opps com status mudado pra won recentemente
   - `contact_assigned_to_rep`: webhook GHL `ContactCreate/Update` com assignedTo
   - `contact_inactive`: query contacts ativos sem msg há >X dias
3. **Reminder runner mode "real"** — quando session_id null e modo prod, enviar via WhatsApp Hub
4. **GHL webhook routing pra eventos** — o webhook principal já roteia inbound msgs pro Hub. Precisa adicionar handlers pra `AppointmentUpdate`, `OpportunityUpdate`, `TaskCreate`, `ContactCreate` que cheguem da location do rep e disparem dispatcher inline (real-time, em vez de polling)

### Infra
5. **Número WhatsApp dedicado** — comprar chip, configurar Cloud API + Evolution coexist no mesmo número
6. **GHL Hub location config** — ASSISTANT_HUB_LOCATION_ID já setado (`Cjc1RonkhwcnrMp3vAqt`)
7. **Test→Prod toggle** — UI deve permitir admin alternar entre simulated e real (env var ou agent config)

### Observability
8. **Logging estruturado** — request_id propagado nos logs do Sparkbot
9. **Métricas de regras** — dashboard por regra: disparos/dia, hit ratio, falhas, custo médio
10. **Dead reminder cleanup** — cron diário pra arquivar `completed`/`failed` >30 dias

---

## 7. Plano de Ação Priorizado

### 🔴 Crítico — Fix antes de V3 launch (10-15h)

| # | Item | Effort | Impact |
|---|---|---|---|
| 1 | Implementar `mode: "real"` + reactive polling (10 eventos) | 6-8h | Habilita V3 |
| 2 | **Parse failure detection** no Sparkbot (parity com sales) | 2h | Evita loop de erros / token waste |
| 3 | Race condition cooldown (advisory lock ou unique guard) | 1h | Evita disparos duplicados |
| 4 | Quiet hours boundary off-by-one fix | 15min | Não acordar rep antes da hora |
| 5 | Tool result truncation com aviso | 30min | Previne alucinação |
| 6 | Reminder runner timezone correto (não NY hardcoded) | 30min | Recurring no horário certo |
| 7 | Bug do markdown — reforçar regra "texto corrido" no prompt | 30min | Tom natural consistente |
| 8 | `ASSISTANT_HUB_LOCATION_ID` null check + warning audível | 30min | Roteamento previsível |

### 🟡 Importante — V2.x antes do GA (8-11h)

| # | Item | Effort | Impact |
|---|---|---|---|
| 9 | **Extrair `lib/ghl/operations.ts`** (unifica add_tag/update_field entre agents) | 3h | Reduz duplicação 3x → 1x |
| 10 | Implementar OpenAI fallback de verdade no llm-client | 2h | Resiliência se Claude cair |
| 11 | `min_value` server-side em list_opportunities | 30min | Cobertura correta de filter |
| 12 | Validação timezone IANA + erro explícito | 30min | Quiet hours funcional |
| 13 | Cron evaluator: dom/month suportados | 1h | Cron expressions completos |
| 14 | `getEligibleReps` filtra por agent | 30min | Multi-tenant isolation |
| 15 | `isBookingConflictError` helper centralizado | 1h | Detection robusta |
| 16 | Cleanup automatizado de tasks/alerts antigos | 1h | Storage/perf longo prazo |
| 17 | UI: acessibilidade + cleanup polling no unmount | 1h | UX |
| 18 | pg_cron conditional fire — remover OR sempre-true | 15min | Custos desnecessários |

### 🟢 Nice-to-have — Polish (4-6h)

| # | Item | Effort | Impact | Status |
|---|---|---|---|---|
| 14 | Tool descriptions com exemplos | 1h | LLM mais eficiente | Pendente (low ROI, próximo ciclo) |
| 15 | Tools faltantes: get_*_by_id globais | 2h | Cobertura | ✅ Batch 7 — `get_appointment` adicionado, demais já existiam |
| 16 | Audit log de mudanças de regra | 1h | Governance | ✅ Batch 7 — migration 00035 + handlers populam `last_modified_by_user_id` |
| 17 | UI: simular regra desabilitada se sem session | 15min | UX | Pendente (UI work) |
| 18 | Rule limits validados (não slice silencioso) | 30min | UX | ✅ Batch 7 — POST/PUT com 400 explícito em vez de truncar silenciosamente |
| 19 | Tabela `assistant_conversations` documentada como placeholder V3 | 15min | Limpeza | ✅ Batch 7 — migration 00036 adiciona COMMENTS na tabela e colunas |

---

## 8. Anexos

### Cenários sintéticos: dados raw
Salvos em `/tmp/synthetic-test-results.jsonl` durante a sessão (efêmero).

### Endpoint sintético
`POST /api/agents/account-assistant/synthetic-test`
Auth: `Bearer ${CRON_SECRET}`
Documentado em [route.ts](src/app/api/agents/account-assistant/synthetic-test/route.ts).

### IDs úteis pra debug
- Sparkbot agent: `c04d7bed-abfc-4ba2-8a51-d3f4ad12b6a6`
- Hub location: `Cjc1RonkhwcnrMp3vAqt`
- Briefing rule: `ddba467a-7165-46c5-ae3a-e385265bd1ae`
- Resumo matinal rule: `d89e40ce-a1aa-4fc3-bf1b-29e793e0453a`
- Test rep: `+17867717077`
