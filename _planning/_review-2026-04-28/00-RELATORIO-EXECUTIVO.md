# Relatório Executivo — Stress Test + Code Review

**Data:** 2026-04-28
**Escopo:** plataforma Spark AI (Sales agent, Recruitment agent, Sparkbot/Account Assistant, infraestrutura, billing, otimizações)
**Método:** 10 agentes paralelos — 5 conversaram em produção com Sparkbot via API (~64 turnos reais), 5 fizeram review do código (39 migrations, ~26.6k LOC).
**Output detalhado:** `stress-test/01-05.md` + `code-review/01-05.md`

---

## TL;DR

| Área | Nota | Estado | Risco principal |
|---|---|---|---|
| **Account Assistant (Sparkbot) — qualidade conversacional** | 8.5/10 | ✅ usável em produção | Roteamento Claude/GPT-4.1 erra em ~10-15% dos turnos |
| **Sales/Recruitment agents — código** | 7/10 | ⚠️ funcional com bugs | 5 bugs CRITICAL/HIGH + 0 testes |
| **Account Assistant — código** | 6.5/10 | 🚨 bug bloqueador | Webhook real é amnésico (B1) |
| **Infraestrutura** | 5/10 | 🚨 riscos graves | Secret em git, 4 tabelas sem migration |
| **Billing & cobrança** | 3/10 | 🚨🚨 quebrado | Tabela `usage_records` não existe + 4 serviços sem cobrança |
| **Performance / dead code** | 6/10 | ⚠️ folga | 5 N+1, 209 console.*, 60% duplicação ai/ vs account-assistant/ |
| **Stress test conversacional (64 turnos)** | 88% PASS | ✅ aprovado | 7 falhas, 6 delas em GPT-4.1 fallback |

**Veredicto final:** o produto **funciona bem na superfície** (qualidade de conversa boa, custo $0.01-0.035/turno, cache hit 75-90%). Mas tem **3 problemas estruturais P0** que precisam ser resolvidos antes de escalar:

1. 🚨 **Billing está fundamentalmente quebrado** — tabela `usage_records` referenciada mas nunca criada → zero cobrança real chegando ao GHL Marketplace. ~$1.3k/mês perdido com 10 locations.
2. 🚨 **Account Assistant em produção é amnésico** — `webhook-handler.ts:104-114` não passa `conversationHistory` ao processor. Synthetic-test passa, webhook real não. Bot no WhatsApp não lembra de turnos anteriores.
3. 🚨 **Roteamento Claude/GPT-4.1 instável** — 6 de 7 falhas conversacionais foram em GPT-4.1 fallback. Forçar Claude pra Sparkbot resolve a maioria dos hallucinations.

Custo de inação se nenhum P0 for atacado: **inviabiliza onboarding comercial**.

---

## 1. Stress test conversacional (64 turnos reais via API)

### 1.1 Métricas agregadas

| Cenário | Turnos | Pass | Cache hit | Custo total | Latency p50/p95 | $ / turno |
|---|---|---|---|---|---|---|
| NLG underwriting | 10 | 10/10 (1 sem tool) | 75% | $0.345 | 27s / 57s | $0.035 |
| Brazillionaires | 12 | 11/12 | 79% | ~$0.18 | 22s / 43s | $0.015 |
| Cross-KB & carreira | 10 | 9/10 | 73% | ~$0.20 | 26s / — | $0.020 |
| Adversarial | 14 | 11 PASS / 1 MED-FAIL | 90% | $0.144 | 17s / — | $0.010 |
| Conversa longa (15) | 15 | 15/15 | 87% | $0.220 | 16s / 35s | $0.015 |
| **TOTAL** | **64** | **56 ok / 7 fail** (88% PASS) | **80% médio** | **~$1.09** | — | **$0.017 médio** |

### 1.2 Falhas detectadas (7 turnos, 11% do total)

| # | Cenário | Turno | Problema | Modelo |
|---|---|---|---|---|
| 1 | NLG | T9 | Bot listou produtos Whole Life NLG ("TotalSecure NL") **sem chamar tool** → risco hallucination | gpt-4.1 |
| 2 | Brazillionaires | T5 | Não chamou tool sobre fingerprint apesar de chunk existir (similarity 0.52) | gpt-4.1 |
| 3 | Brazillionaires | T9 | **Inventou** "Clube dos $10K" e citou fonte falsa | gpt-4.1 |
| 4 | Cross-KB | T6 | **Hallucinou** que NLG exige fingerprint do CLIENTE (é do agente) | gpt-4.1 |
| 5 | Adversarial | T9 | Em vez de bloquear pré-aprovação UW, pediu confirm → pediu nome do cliente | gpt-4.1 |
| 6 | Cross-KB | T2 | Resposta genérica em pergunta híbrida sobre Visa/abordagem (não cruzou KBs) | claude |
| 7 | Conversa longa | T11-T13 | `search_contacts` em loop sem progresso (sem fallback de task standalone) | claude |

**Padrão crítico:** **6 de 7 falhas (86%)** ocorreram em **gpt-4.1**. Claude Sonnet 4.6 tem comportamento muito mais consistente em tool calling, hedging e compliance. O roteamento atual entre Claude e GPT-4.1 não tem padrão claro e está produzindo regressões previsíveis.

### 1.3 O que o bot faz bem

- Hierarquia NLG > Five Rings > Brazillionaires explicada com nuance avançada (T7 do Cross-KB)
- Estrutura "LADO NLG / LADO BRAZILLIONAIRES" consistente em queries cruzadas
- 15 turnos sem perder contexto (lembrou Maria/João/Ana com idades, condições, premiums)
- Recusas firmes em compliance (anti-rebate em T8 NLG, prompt injection em T5 adversarial)
- Resposta clínica em depressão+IUL (abriu com 988 hotline antes do conteúdo técnico)
- PT-BR natural em 100% dos turnos
- Cache hit 80% médio é forte

---

## 2. Achados CRITICAL (bloqueadores — corrigir ANTES de escalar)

### C1 — Billing: tabela `usage_records` não existe

**File:** `supabase/migrations/00028_rls_deny_anon.sql:25` referencia, `src/lib/billing/charge.ts:32-50,69,182` usa, **nenhuma migration cria a tabela**.

**Impacto:** call sites em `processor.ts:625`, `account-assistant/processor.ts:238`, `dispatcher.ts:390` envolvem em `try/catch` non-blocking. Erro é engolido. **Zero cobranças efetivamente vão pro GHL Marketplace.**

**Loss estimada:** $1.3k/mês (10 locations) → $6.5k/mês (50 locations).

**Fix:** criar migration `00040_usage_records.sql` com schema completo (rep_id, location_id, agent_id, provider, model, prompt_tokens, completion_tokens, cached_tokens, cost_usd, billed_at, created_at) + índices em `location_id` + `created_at` + `billed_at IS NULL`.

---

### C2 — Account Assistant em produção é amnésico

**File:** `src/lib/account-assistant/webhook-handler.ts:104-114`

**Problema:** o webhook real chama `processIncoming()` SEM passar `conversationHistory` nem `testSessionId`. Apenas o endpoint `synthetic-test` passa o histórico corretamente.

**Impacto:** bot no WhatsApp **não tem memória entre turnos**. O stress test de 15 turnos só funciona porque é synthetic-test. Em produção, cada msg é uma conversa nova — usuário mandando "lembra que falei da Maria?" → bot não tem nada.

**Fix:** carregar histórico em `webhook-handler.ts` (similar ao que synthetic-test/route.ts:142-153 faz com `agent_test_messages`, mas pra `agent_messages` ou tabela equivalente de produção).

---

### C3 — Whisper, summary, history-compressor e follow-ups sem cobrança

**Files:**
- `src/lib/ai/audio-transcriber.ts:90` — Whisper-1 sem `trackAndCharge`
- `src/lib/ai/summary-note-generator.ts:140-168` — gpt-4.1-mini sem billing
- `src/lib/ai/history-compressor.ts:115-128` — gpt-4.1-nano sem billing
- `src/lib/queue/follow-up-scheduler.ts:298` — `processWithAI` sem billing

**Impacto:** mesmo se C1 fosse resolvido, esses serviços ficariam free. Whisper sozinho com 30 min/dia/location = ~$5/mês × 10 locations = $50/mês silently free.

**Fix:** wrappar todos call sites em `trackAndCharge()`. Adicionar entry `whisper-1: $0.006/min` em `pricing.ts`.

---

### C4 — CRON_SECRET hardcoded em git

**File:** `supabase/migrations/00032_sparkbot_pg_cron.sql:32`

```sql
auth_header => 'Bearer spark-cron-secret-2026'
```

**Impacto:** repo público (ou futuro public) → qualquer pessoa com acesso ao git pode disparar `/api/cron/process-queue`, `/api/agents/process-batch`, etc. Já está no commit `753b6a1`.

**Fix:**
1. Rotacionar segredo IMEDIATAMENTE.
2. Migration nova: `ALTER` o cron job pra ler de `vault.decrypted_secrets` ou env var Supabase.
3. Remover linha do migration histórico via `git filter-repo` (ou aceitar que segredo antigo está queimado).

---

### C5 — `try_claim_dispatch_slot` não funciona pra `target_id IS NULL`

**File:** `supabase/migrations/00030_assistant_proactive_rules.sql` (UNIQUE) + `00033_atomic_dispatch_claim.sql:54` (alegação errada nos comments)

**Problema:** UNIQUE `(rep_id, rule_id, target_id)` sem `NULLS NOT DISTINCT`. Postgres trata cada NULL como distinct → `ON CONFLICT` **nunca casa** rows com `target_id IS NULL`. Comentário em 00033 diz "nosso UNIQUE inclui NULLs como iguais" — está errado.

**Impacto:** o claim atômico que essa migration alegou resolver **não funciona** justamente nos casos de regras globais (target_id null). Race conditions retornam.

**Fix:** migration nova adicionando `UNIQUE NULLS NOT DISTINCT` ou usar coalesce em índice expression-based.

---

### C6 — Schema drift: 4 tabelas em prod sem migration

**Tabelas sem migration de criação versionada:** `usage_records` (já no C1), `location_settings`, `agent_feedback`, `scheduled_followups` (existe só em SETUP.sql, mas index em 00022 já a referencia).

**Impacto:** **disaster recovery é impossível hoje**. Clonar repo + aplicar migrations não reproduz prod. Onboarding de dev novo requer dump manual.

**Fix:** sprint dedicada — exportar schema de prod, gerar migrations sequenciais, validar com `supabase db diff`.

---

### C7 — Anthropic prompt cache write tratado como input normal

**File:** `src/lib/billing/pricing.ts:6-8` (admitido em comments)

**Problema:** Anthropic cobra **125% premium** em tokens de cache write (vs 100% input normal). Código trata `cache_creation_input_tokens` como input regular → undercharge de 25% nesses tokens.

**Impacto:** 10-30% das mensagens disparam cache write. Em ~50% delas o input é grande (system prompt + tools + KB chunks). Loss estimada: $30-100/mês escalando.

**Fix:** em `charge.ts`, separar `cache_creation_input_tokens` e aplicar multiplicador 1.25 sobre input rate.

---

## 3. Achados HIGH (corrigir essa sprint)

### H1 — Roteamento Claude ↔ GPT-4.1 instável

Confirmado em **4 stress tests independentes**: bot oscila sem padrão entre `claude-sonnet-4-6` e `gpt-4.1`. **6 de 7 falhas** ocorreram em GPT-4.1.

**Files prováveis:** `src/lib/account-assistant/llm-client.ts` (model fallback logic).

**Fix:** lock em `claude-sonnet-4-6` para Sparkbot quando query envolve KB ou compliance. Manter GPT-4.1 só pra fluxos triviais (talvez nem isso).

---

### H2 — `processor.ts:128-133` finally usa contadores globais

Quando 1 dos N grupos falha, marca status errado pro grupo inteiro → duplicação ou retry perdido.

**Fix:** trackar errors/processed por-grupo, não global.

---

### H3 — Webhook: insert + update de `process_after` não-atômico

**File:** `webhook` insert handler. Crash entre 1 e 2 quebra debounce.

**Fix:** wrappar em transaction ou usar `INSERT ... RETURNING` com computed `process_after`.

---

### H4 — Schema OpenAI strict desperdiça 20-30% de output tokens

**File:** action schemas em `src/lib/ai/action-executor.ts` ou tool defs.

**Problema:** todos os ~10 campos da action marcados como `required: true` em schema strict da OpenAI. Modelo gera 10 chaves null por action quando usa só 2-3.

**Fix:** usar `oneOf` com sub-schemas por tipo de ação, marcando apenas campos relevantes como required.

---

### H5 — System prompt 25-30k tokens com KB cheia

**File:** `src/lib/ai/prompt-builder.ts` (998 LOC)

**Problema:** KB inline pode chegar a 12k chars cap. Sem RAG.

**Fix:** já existe `query_carrier_knowledge` no Sparkbot — replicar pattern no Sales agent. Cap KB inline em 6000 chars + dispatch a tool quando rep faz query específica.

---

### H6 — `findExistingAppointment` faz 3 GHL calls sequenciais

**File:** `src/lib/ai/calendar.ts` ou similar.

**Problema:** -400ms p99 desnecessários em booking.

**Fix:** `Promise.all`.

---

### H7 — `prompt-builder.ts:59,69-70` referencia tools que não existem

**File:** `src/lib/account-assistant/prompt-builder.ts`

**Problema:** menciona "modify_tag", "update_field", "V1 — 8 tools" mas o registry tem ~30 tools. Modelo vai alucinar chamadas.

**Fix:** sincronizar prompt com `tools/index.ts`.

---

### H8 — `confirmation_mode` não é enforced em código

**File:** `prompt-builder.ts:33-37` diz "ações pesadas (não-implementadas em V1)" mas `delete_contact`, `delete_appointment`, `send_message_to_contact`, `create_appointment` são `risk: "high"` e EXISTEM. Protocolo de confirmação só vive no prompt.

**Fix:** gate em `executeTool()` que respeita `agent_configs.confirmation_mode` e exige confirm antes de executar `risk: "high"`.

---

### H9 — `MAX_TOOL_RESULT_CHARS=12000` corta o FIM do JSON

**File:** `src/lib/account-assistant/llm-client.ts:19,21-26`

**Problema:** truncamento do fim. `get_conversation_history` retorna msgs em ordem cronológica → as MAIS RECENTES são cortadas. Pre-meeting briefing (system-rules.ts:36-43) recebe dados truncados sem saber.

**Fix:** se resultado > limit, smart-truncate (keep head + tail, marcar `[...truncated N items...]`).

---

### H10 — 5 CVEs em deps

`npm audit`: glob (high, command injection), next 14.2.35 (4 vulns: HTTP smuggling, request deserialization DoS, image cache exhaustion), postcss (XSS).

**Fix:** `npm audit fix`. Pode requerer bump do Next pra patch.

---

### H11 — Webhook dispara `processMessageQueue()` global após cada msg

**File:** webhook handler.

**Problema:** burst de 60+ workers concorrentes em pico (todos processando a mesma fila).

**Fix:** debounce/dedup em-fila ou cap em queue depth.

---

### H12 — `processing` órfãos sem reaper

**File:** `src/app/api/cron/process-queue/route.ts` ou processor.

**Problema:** lambda morto deixa msgs em `status='processing'` sem TTL. `finally` não roda em timeout/SIGKILL.

**Fix:** cron `every 5 min` que faz `UPDATE message_queue SET status='pending' WHERE status='processing' AND updated_at < now() - interval '5 min'`.

---

## 4. Achados MED (corrigir esse mês)

| # | Área | Issue | File | Fix em 1 linha |
|---|---|---|---|---|
| M1 | Sparkbot | Reminder vaza sessão entre admins | `proactive/reminder-runner.ts:86-100` | Filtrar por `created_by`/`rep_id` |
| M2 | Sparkbot | `is_stale` flag não é honrada nas respostas | `tools/carrier_kb.ts:189-210` (gera flag mas LLM não age) | Reforçar no prompt-builder |
| M3 | Conversa | `search_contacts` em loop sem progresso | `tools/contacts.ts` | Fallback `create_task` standalone (sem contact_id) |
| M4 | Billing | Race conditions em `chargeUnbilledRecords` | `charge.ts` | `SELECT ... FOR UPDATE SKIP LOCKED` |
| M5 | Billing | GHL charge sem idempotency key | `charge.ts` | Hash `(usage_id, location_id)` como key |
| M6 | Billing | Modelos desconhecidos fallback silencioso | `pricing.ts` | Hard fail + log |
| M7 | Billing | `gpt-5.4` placeholders pra modelo não-anunciado | `pricing.ts:24-26` | Remover ou marcar `disabled` |
| M8 | Infra | RLS sem `FORCE ROW LEVEL SECURITY` | migration 00007 | Adicionar `FORCE` |
| M9 | Infra | `agent_configs` virou tabela com 35+ colunas | schema | Splitar JSONB-heavy fields em config_json |
| M10 | Infra | `execution_log` sem TTL | schema | Particionar por mês ou auto-truncate >90d |
| M11 | Infra | Falta FK em `*.location_id` em várias tabelas | schema | Adicionar FK + ON DELETE CASCADE |
| M12 | Infra | `search_carrier_knowledge` 2 versões coexistindo | DB function | DROP versão 1536 |
| M13 | Conversa longa | Path synthetic-test usa `slice(-30)` sem compressão | `synthetic-test/route.ts:144` | Reusar `history-compressor.ts` |
| M14 | Otimização | 5 N+1 confirmados em hot paths | múltiplos | `IN (...)` com batch fetch |
| M15 | Otimização | `cache_control` não cobre tools nem histórico | `llm-client.ts` | Adicionar cache breakpoint após system+tools |
| M16 | Performance | Cold start: imports SDK top-level | 5 arquivos | Lazy load (precedente em `llm-client.ts:31,312`) |

---

## 5. Padrões transversais (problemas que aparecem em múltiplas áreas)

### P1 — GPT-4.1 fallback é a fonte de regressões

Apareceu em **4 dos 5 stress tests** + **2 code reviews**. GPT-4.1 com Sparkbot:
- Não chama tools quando deveria (NLG T9, Brazillionaires T5)
- Inventa info ("Clube $10K", fingerprint do cliente)
- Compliance flexível demais (pediu confirm em pré-aprovação UW + pediu nome do cliente)
- Latency até 43s (vs Claude ~22s)

**Recomendação:** lock Sparkbot em `claude-sonnet-4-6`. Se GPT é necessário (cost), confine em fluxos triviais sem tool calling.

### P2 — Billing tem múltiplos furos independentes

C1 (tabela ausente) + C3 (4 serviços sem billing) + C7 (cache write rate errado) + M4 (race) + M5 (idempotency) + M6 (fallback silencioso). **Sintomático: o módulo billing nunca foi exercitado em produção real.**

**Recomendação:** sprint dedicada de 1 semana só pra billing — auditoria E2E + test suite.

### P3 — Zero testes em /src

Confirmado em 2 reviews independentes. **0 arquivos `.test.ts` em 26.6k LOC.** Para uma plataforma com 5 bandas × 4 dims × 2 tipos × 4 objetivos no prompt builder, ausência total de testes é incompatível com escalar.

**Recomendação:** começar por **suite de regressão dos 64 turnos do stress test** (já temos os outputs). Cada turno vira fixture: `input → expected_tools_called + expected_keywords_in_response`.

### P4 — Duplicação ai/ vs account-assistant/

`src/lib/ai/openai-client.ts` (399) vs `src/lib/account-assistant/llm-client.ts` (434) → 60% overlap (cache, fallback, billing, multimodal reimplementados).

**Recomendação:** extrair `src/lib/llm/core.ts` com runner unificado + adapters por feature. Refactor de 2-3 dias.

### P5 — Schema drift

C6 (4 tabelas sem migration) + M8 (RLS sem FORCE) + M11 (FKs faltando) + M12 (2 versões da search function). **DB de prod e schema versionado divergiram.**

**Recomendação:** `supabase db diff --schema public` e committar deltas como 00040/00041.

### P6 — Configuração frágil em ambientes

C4 (secret em git) + vercel.json com cron diário inútil + maxDuration:60s incompatível com workload de 20-50s/msg.

**Recomendação:** auditoria de config (vercel.json + .env vars + migration secrets) numa única passagem.

---

## 6. Plano de ação priorizado

### Sprint 0 (essa semana — 5 dias)

| # | Item | Esforço | Owner sugerido |
|---|---|---|---|
| C1 | Migration `00040_usage_records.sql` + validar todos call sites | 1 dia | back-end |
| C2 | Webhook handler passar `conversationHistory` | 0.5 dia | back-end |
| C3 | Wrappar Whisper/summary/history/follow-ups em `trackAndCharge` | 1 dia | back-end |
| C4 | Rotacionar CRON_SECRET + migration update | 0.5 dia | infra |
| C5 | Migration UNIQUE NULLS NOT DISTINCT em assistant_alert_state | 0.5 dia | back-end |
| H1 | Lock Sparkbot em claude-sonnet-4-6 | 0.5 dia | back-end |
| H10 | `npm audit fix` + bump Next | 0.5 dia | infra |

**Total:** 4-5 dias. Resolve 5/7 P0 + 2 HIGHs.

### Sprint 1 (próximas 2 semanas)

- C6: schema drift sweep + migrations 00041-00043
- C7: cache write rate correto
- H2-H9: bugs de processor/webhook/prompt
- M1-M8: medium issues do Sparkbot e billing
- Suite de regressão dos 64 turnos do stress test

### Sprint 2 (mês corrente)

- P3: cobertura de testes >40% em hot paths
- P4: refactor LLM core unificado
- M9-M16: schema cleanups + performance

### Backlog (Q3 ou conforme cresce)

- Observabilidade (logging estruturado, métricas, alertas)
- DR strategy (backup + restore tested)
- Multi-region (se cliente exigir)
- Chunks faltando no KB (Power Monday, Clube $10K, Whole Life NLG)

---

## 7. Estimativas de impacto

### Financeiro

| Item | Loss/mês 10 loc | Loss/mês 50 loc | Pós-fix |
|---|---|---|---|
| C1 (usage_records ausente) | $1.300 | $6.500 | $0 |
| C3 (Whisper sem cobrança) | $50 | $250 | $0 |
| C3 (summary/history/follow-up) | $80 | $400 | $0 |
| C7 (cache write rate) | $30 | $150 | $0 |
| **TOTAL recovery** | **~$1.460** | **~$7.300** | — |

### Qualidade conversacional

- **Hoje:** 88% PASS rate (88% PASS, 11% fail).
- **Pós H1 (lock Claude):** estimativa 95%+ PASS rate (6 das 7 falhas eram em GPT-4.1).
- **Pós M2 (`is_stale` no prompt):** +2% em queries com chunk velho.
- **Pós forçar tool call em queries de produto:** elimina hallucinations T9 NLG e T9 Brazillionaires.
- **Target realista 30 dias:** **97%+ PASS** com cache hit acima de 80%.

### Risco operacional

- **Hoje:** secret em git = qualquer um disparar crons (DoS / fila envenenada). Webhook amnésico = UX quebrada.
- **Pós Sprint 0:** risco crítico zerado. Schema drift ainda existe mas não é blocker.

---

## 8. O que está bem-feito (e deve manter)

Pra equilibrar, vale ressaltar o que se destaca positivamente:

- **Atomic claim em UPDATE-RETURNING** (`processor.ts:57`) — pattern correto.
- **Idempotência por `ghl_message_id`** com UNIQUE index parcial.
- **Parse failure loop detection** (impede "Desculpa, tive problema técnico" infinito).
- **Sanitizer mecânico defense-in-depth** (turn state + regex + salvaguarda).
- **`cache_control: ephemeral` no Claude** + `store: true` na OpenAI — funcionando, cache hit médio 80%.
- **Tool description do `query_carrier_knowledge`** — estado-da-arte com hierarquia, exemplos, propagação de staleness/state/source.
- **Dual-KB com Voyage 1024 + threshold 0.4** — qualidade de retrieval validada nos stress tests.
- **Hierarquia NLG > Five Rings > Brazillionaires** explicada com nuance avançada (turno 7 do Cross-KB).
- **Recusa firme em compliance crítico** (anti-rebate, prompt injection, conselho financeiro inadequado).
- **PT-BR natural** em 100% dos turnos.
- **Cleanup automático** via 00034.
- **pg_cron com conditional fire** (só dispara se houver work).

---

## 9. Próximos passos recomendados

**Hoje (se for retomar trabalho):**
1. Ler este relatório + os 10 detalhados em `_planning/_review-2026-04-28/`
2. Decidir: a) atacar Sprint 0 nesta semana, ou b) priorizar só P0 1+2+3 (billing+webhook+modelo) que dão ROI imediato

**Esta semana:**
- Sprint 0 completo (C1-C5 + H1 + H10).

**Antes de onboarding comercial novo:**
- Mínimo viável: P0 todos resolvidos + suite de regressão dos 64 turnos passando + DR documentado.

**Antes de escalar pra 50+ locations:**
- Refactor LLM core unificado (P4) + cobertura de testes >40% (P3) + observabilidade básica.

---

## Referências detalhadas

| Arquivo | Conteúdo |
|---|---|
| `stress-test/01-nlg-underwriting.md` | 10 turnos UW NLG, métricas, achados |
| `stress-test/02-brazillionaires.md` | 12 turnos processo, Clube $10K, fingerprint |
| `stress-test/03-cross-kb-carreira.md` | 10 turnos integração 2 KBs, hierarquia |
| `stress-test/04-adversarial.md` | 14 turnos red team, T9 pré-aprovação |
| `stress-test/05-conversa-longa.md` | 15 turnos memória, 3 leads, score 9.0/10 |
| `code-review/01-sales-recruitment.md` | 5 bugs CRITICAL/HIGH, refactor processor |
| `code-review/02-account-assistant.md` | 26 issues + 10 otimizações + 7 refactors |
| `code-review/03-infraestrutura.md` | 39 migrations, schema drift, secret em git |
| `code-review/04-billing.md` | 4 furos CRITICAL, $1.3-7.3k/mês |
| `code-review/05-otimizacoes.md` | 209 console.*, 5 N+1, 60% duplicação |

---

**Custo do review:** ~$1.10 (64 turnos stress × ~$0.017) + agentes de code review (~$0.30 estimado em Claude Sonnet) = **~$1.40 USD total**.
