# C3 — Billing & Módulos — Síntese (ultra-review 2026-05-26)

Coordenador C3. READ-ONLY (código + queries SELECT na prod `vyfkpdnwevtuxauacouj`).
Domínio: L3.1 Billing/cobrança · L3.2 Logs & configs · L3.3 Crons & schedulers.

Severidade: **P0** = dinheiro errado / cobrança quebrada · **P1** · **P2**.

---

## TL;DR (ordenado por severidade)

| # | Sev | Título | Arquivo:linha |
|---|-----|--------|---------------|
| C3-1 | **P0/P1** | Claims órfãos em `usage_records` — $17.50 (e crescendo) nunca cobrados; 192/234 records travados com `claim_token` nunca liberado, sem reaper | `usage-records.repo.ts:218-236`, `charge.ts:332-358`, `process-queue/route.ts:8-21` |
| C3-2 | **P1** | Retry de cobrança roda **1×/dia** dentro de `Promise.all` com `maxDuration=60` → mata o loop de charge no meio e estranda claims | `vercel.json:3-6`, `process-queue/route.ts` |
| C3-3 | **P1** | `cache_creation_tokens` nunca persistido E nunca cobrado a 125% — billed ao FRESH rate (subcobrança ~25% sobre creation tokens); comentário em `charge.ts:40` afirma o contrário (falso) | `charge.ts:48-77`, `usage-records.repo.ts:19-36` |
| C3-4 | **P1** | Cap mensal: valor lido do agent que disparou (`getMonthlySpendCap(agentId)`) mas spend somado da location inteira → location multi-agente tem cap inconsistente | `charge.ts:235-271`, `agents.repo.ts:164-174` |
| C3-5 | **P2** | `audio_model` nunca persistido (90/90 rows de áudio com `audio_model IS NULL`) — auditoria Whisper cega | `charge.ts:60-77`, `usage-records.repo.ts:19-36` |
| C3-6 | **P2** | `/api/settings` PUT sem validação (`daily_message_limit`, `cost_alert_threshold`, `openai_api_key` gravados raw) | `settings/route.ts:46-67` |
| C3-7 | **P2** | `daily_message_limit` e `cost_alert_threshold` são settings MORTOS — gravados pela UI, consumidos em lugar nenhum | grep: só `settings/route.ts:49-50` |
| C3-8 | **P2** | DRIFT cron: vercel.json declara 2 jobs (`process-queue`, `refresh-ghl-token`) e pg_cron tem 5 outros; nenhuma sobreposição, mas `chargeUnbilledRecords` depende do cron diário do Vercel | `vercel.json` vs `cron.job` (prod) |

---

## L3.1 — Billing / cobrança

### WORKS
- **Markup 10% correto.** Amostra de rows reais da prod: `markup_usd / cost_usd = 0.1000` exato; `total_charge = cost + markup`. `MARKUP_PERCENTAGE = 0.10` (`pricing.ts:64`). Math de custo confere por modelo (haiku 12.3K prompt ≈ $0.0126 ✓).
- **Cached tokens (cache READ) cobrados certo.** `llm-client.ts:423` seta `cached_tokens = cache_read_input_tokens`; `calculateCost` cobra cachedInput (10% do input em Anthropic). 1393/2100 rows têm cached>0 e persistem.
- **Cap atinge e bloqueia mas bot continua.** `charge.ts:95-110` — `isMonthlyCapReached` → `markCapBlocked(record.id)` + `return` (não cobra), processamento NÃO é interrompido. `cap_blocked` excluído do retry (`claimUnbilledBatch` `.eq("cap_blocked", false)`). Default prod confirmado `$100.00`, 18/18 configs com cap (0 NULL).
- **Internal-team skip funciona.** `processor.ts:625-640` — `syncRepInternalFlag(rep)` → `usesCustomKey: isInternal` → `markCustomKeyCharged` sem cobrar wallet, audit mantido. 194 rows `uses_custom_key=true` na prod. Detecção em 3 camadas (`identity.ts:269-290`).
- **Idempotência GHL.** `eventId = usage_record.id` (`charge.ts:160,346`). Cobra 1 record/vez (evita estourar Max Price $5 do metered billing — fix Pedro 2026-05-17).
- **UI de Faturamento bate com a fonte.** `loadBilling` (`data.ts:439-468`) soma `total_charge_usd`/`total_tokens`/`audio_seconds`/`image_count` direto de `usage_records` escopado por location+mês. `page.tsx` exibe sem transformação enganosa. (Limita 2000 rows/mês — ok no volume atual: 26 locations ativas, 2100 rows totais.)

### BREAKS / RISK

**C3-1 (P0/P1) — Claims órfãos: revenue uncollected, vazamento permanente.**
- O quê: `claimUnbilledBatch` (`usage-records.repo.ts:218-236`) só pega `claim_token IS NULL`. Quando um record recebe `claim_token` mas NÃO é cobrado nem liberado (lambda morre no meio do loop sequencial de `fetch` ao GHL — `charge.ts:332-358`), fica travado **para sempre**. `releaseClaimForRecord` só roda no `catch` de cada record; se a função inteira é morta (timeout Vercel), os claims já feitos vazam.
- Prova prod: **234 unbilled (`charged_to_wallet=false, uses_custom_key=false, cap_blocked=false, total_charge_usd>0`), $17.4965, oldest 2026-05-05 (3 semanas), TODOS >1h, e 192 com `claim_token` setado ("currently_claimed").** Esses 192 nunca mais serão retentados.
- Porquê: não existe reaper que reseta `claim_token` stale em `usage_records` (o reaper inline do `queue-processor.ts:71` é só pra `message_queue`). Combina com GHL charges falhando desde ~05-05 (bate com a troca de schema de metered billing de 05-17).
- Fix: (a) reaper que zera `claim_token`/`claimed_at` onde `claimed_at < now() - interval '15 min' AND charged_to_wallet=false`; (b) `claimUnbilledBatch` deve incluir `OR claimed_at < cutoff` no filtro; (c) investigar por que o `chargeWallet` está falhando (logar `errorBody` do GHL pros 42 não-claimed antigos).

**C3-2 (P1) — Retry de cobrança subdimensionado.**
- `/api/cron/process-queue` (vercel.json `0 0 * * *` = 1×/dia, `maxDuration=60`) roda `chargeUnbilledRecords()` em `Promise.all` com 3 jobs pesados (queue, followups, summaries) — `process-queue/route.ts:16-21`. Claim de 50/run + charge sequencial ao GHL. Sob carga ou GHL lento, o budget de 60s acaba e o loop morre → C3-1. E mesmo no happy path, 1×/dia × 50 nunca drena 192 presos.
- Fix: cron próprio mais frequente pra billing retry (ex: a cada 5-10min via pg_cron com guarda), separado dos jobs de fila.

**C3-3 (P1) — `cache_creation_tokens`: não persiste e não cobra premium.**
- O quê: `TrackUsageParams` aceita `cacheCreationTokens` e `calculateCost` cobra 125% (`pricing.ts:153`), MAS **nenhum call site passa o campo** (`processor.ts:627`, `dispatcher.ts:578`, `queue-processor.ts:760`, `webhook-handler.ts:607`, etc. — todos omitem). Pior: `LLMResult` nem expõe creation separado — `llm-client.ts:421` dobra creation dentro de `prompt_tokens`.
- Efeito real: em `calculateCost`, `cacheCreationTokens=0` → `freshInputTokens = promptT − cachedRead − 0` = inclui creation tokens → creation é cobrado ao **fresh rate** ($3.00/M Sonnet) em vez do **cache-write** ($3.75/M). **Subcobrança de 25% sobre creation tokens.** Além disso `UsageRecordInsert` (`usage-records.repo.ts:19-36`) não tem a coluna → audit sempre 0.
- Prova prod: **0/2100 rows com `cache_creation_tokens > 0`.**
- Nota: o comentário `charge.ts:40` ("cache_creation cobrado como 125%") está **factualmente errado** — induz a crer que está coberto.
- Fix: expor `cache_creation_tokens` no `LLMResult`, propagar pelos call sites até `insertUsageRecord`, adicionar coluna no insert.

**C3-4 (P1) — Escopo do cap inconsistente (agent vs location).**
- `isMonthlyCapReached` lê o cap de UM agent (`getMonthlySpendCap(agentId)` → `agent_configs` por `agent_id`) mas soma o spend da LOCATION inteira (`getMonthlySpend(locationId)`). CLAUDE.md define cap "$100/sub-account" (per-location). Numa location com SparkBot ($100) + sales agent (cap NULL): charges do sales bypassam cap (NULL = infinito), charges do SparkBot respeitam $100 — ambos contam pro mesmo `spent`. Resultado: o cap efetivo depende de QUAL agent dispara a cobrança. Hoje benigno (todos os 18 configs têm cap $100), mas frágil ao adicionar agente lead-facing sem cap.
- Fix: resolver cap por location (MAX/MIN entre agents, ou coluna em `locations`/`location_settings`), não pelo agent que disparou.

**Falsos-positivos descartados (L3.1):**
- ~~Vision/imagem não cobrado~~: `image_count` é só telemetria; tokens de imagem entram em `prompt_tokens` (multimodal) e são cobrados como input. `queue-processor.ts:770` passa `imageCount` pra audit. Correto. (0 rows com imagem na prod — não validável empiricamente, mas o path está certo.)
- ~~Markup errado~~: confirmado 10% exato em rows reais.
- ~~Double-count de cached~~: `calculateCost` faz `safeCached = min(cached, prompt)` e desconta do fresh (`pricing.ts:147-149`). Correto.

---

## L3.2 — Logs & configs

### WORKS
- `execution_log` registra `prompt_tokens`/`completion_tokens`/`model`/`tools`/`success`/`duration_ms` + `action_payload` jsonb estruturado. Observabilidade de billing redundante (tokens em log E em usage_records) — bom pra cross-check.
- `/api/settings` GET **mascara** a API key (`settings/route.ts:23-25`: `sk-...{last4}`) — sem vazar segredo. Usa `createServerClient` (session-scoped, tenant isolation ok).

### BREAKS / RISK
- **C3-6 (P2)** — PUT sem validação: `daily_message_limit`, `cost_alert_threshold`, `openai_api_key` gravados raw de `body[field]` (`settings/route.ts:54-57`). Sem checagem de tipo/range/formato. `openai_api_key` é BYO key que bypassa wallet billing — gravar string arbitrária quebra silenciosamente a IA do tenant (mas só do próprio tenant). Fix: validar (numérico>0; key `^sk-`).
- **C3-7 (P2)** — `daily_message_limit` e `cost_alert_threshold` são **settings mortos**: gravados pela UI mas consumidos em NENHUM lugar (grep só acha em `settings/route.ts`). UX enganosa — usuário acha que tem limite/alerta de segurança; o único cap real é `monthly_spend_cap_usd`.
- **RISK (P2) — PII em logs:** `execution_log.action_payload` do `send_message` inclui a chave `message` (conteúdo enviado ao lead) e `error_message` pode conter dados. Sem TTL/cleanup visível pra `execution_log` (há cron de cleanup só pra `assistant_scheduled_tasks` e `sparkbot_dedup_locks`). Retenção indefinida de conteúdo de mensagem = exposição LGPD. Fix: redigir conteúdo OU cron de retenção.

**Falso-positivo:** GET `/api/settings` não vaza key (mascarada). OK.

---

## L3.3 — Crons & schedulers

### Estado da prod (`SELECT jobname, schedule, active FROM cron.job`)
| jobname | schedule | guarda |
|---------|----------|--------|
| `process-message-queue` | 10s → `/api/agents/process-batch` | — (reaper inline no processor) |
| `followup-runner` | 30s → `/api/cron/followup-runner` | — |
| `sparkbot-proactive` | 30s → `/api/cron/sparkbot-proactive` | **advisory lock 8675309 + WHERE EXISTS triplo ✓** (confere com CLAUDE.md) |
| `sparkbot-cleanup` | `0 3 * * *` (DELETE tasks antigas) | — |
| `sparkbot-dedup-locks-cleanup` | `*/5 * * * *` (DELETE locks expirados) | — |

### vercel.json (Vercel Cron, sistema separado)
- `/api/cron/process-queue` — `0 0 * * *` (1×/dia) → roda `chargeUnbilledRecords` + queue/followups/summaries.
- `/api/cron/refresh-ghl-token` — `0 6 * * *`.

### WORKS
- `sparkbot-proactive` guards presentes na prod (advisory xact lock + EXISTS em scheduled_tasks/proactive_rules/bulk_recipients) — anti double-exec e anti-DDoS de calls vazias. Bate com migration 00070 + 00053 + CLAUDE.md.
- Sem jobs duplicados em pg_cron (5 jobs, nomes únicos). `followup-runner` usa `claim_token` em tabela DIFERENTE (`followup_messages`) — não conflita com usage_records.

### BREAKS / RISK
- **C3-8 (P2) — DRIFT documental/risco operacional:** os 2 jobs do vercel.json e os 5 do pg_cron são sistemas distintos (esperado), mas **`chargeUnbilledRecords` só roda no cron Vercel 1×/dia** — billing retry é o elo mais fraco e mais crítico (ver C3-1/C3-2). Migrations declaram os 5 pg_cron jobs (00032/00034/00044/00053/00070) — alinhadas com prod. NENHUMA migration declara os Vercel crons (são config de deploy, ok). Drift real é a ausência de um job de billing-retry frequente.
- **RISK** — `process-message-queue` (10s) e `sparkbot-proactive` (30s) NÃO têm advisory lock próprio exceto o proactive. O `process-batch` confia no reaper inline (`queue-processor.ts:71`, cutoff 5min) — aceitável, mas sob backlog 2 execuções de 10s podem sobrepor antes do reaper. Não é o foco (domínio C3 = billing); registrado pra C1/C2.

**Falso-positivo:** secret Bearer hardcoded no `command` de `sparkbot-proactive` em `cron.job` — é design do pg_cron (precisa do header pra chamar o endpoint Vercel autenticado), rotacionado via migration 00041. Tabela `cron.job` só acessível a superuser/service role. Não é leak explorável. OK.

---

## Resumo de contagem
- **P0/P1 (dinheiro):** C3-1 (claims órfãos, $17.50+ uncollected, vazando), C3-2 (retry subdimensionado), C3-3 (cache_creation subcobrado + não auditado), C3-4 (escopo cap inconsistente).
- **P2:** C3-5 (audio_model não persiste), C3-6 (settings sem validação), C3-7 (settings mortos), C3-8 (drift cron / billing-retry ausente), + RISK PII em execution_log.
- **WORKS:** markup 10% exato, cached-read cobrado certo, cap bloqueia c/ bot vivo, internal-skip, idempotência GHL, UI bate com usage_records, guards do sparkbot-proactive.
- **Falsos-positivos descartados:** Vision não-cobrado (é token-based), markup errado, double-count cached, GET vaza key, secret no cron.job.
