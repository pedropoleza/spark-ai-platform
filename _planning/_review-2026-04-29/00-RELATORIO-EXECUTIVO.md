# Ultra-Review Sparkbot v2 — Relatório Executivo

**Data:** 2026-04-29
**Escopo:** Account Assistant (Sparkbot) — billing, web UI, segurança, lembretes/proatividade, loader GHL.
**Método:** 7 agentes paralelos — 3 conversaram em produção via API (37 turnos reais), 4 fizeram code review de áreas específicas.
**Custo do review:** ~$1.0 USD em LLM.

---

## TL;DR

**Sparkbot funciona MUITO bem como interface (qualidade conversacional, branding, resistência adversarial), mas tem 4 bugs CRITICAL silenciosos em produção que precisam ser corrigidos antes de qualquer rollout.** Os agentes detectaram problemas que NÃO aparecem em curl/console — falham em silêncio (try/catch swallowed) e o usuário só percebe quando "esperava algo e não veio".

| Área | Estado | Gravidade |
|---|---|---|
| **Conversação / qualidade do bot** | ✅ excelente (cache hit 93%, branding 100%, resistência adversarial 100%) | OK |
| **Billing — cobertura** | 🚨 furos múltiplos | CRITICAL |
| **Segurança — autenticação** | 🚨 idToken sem verify de assinatura | CRITICAL |
| **Lembretes WhatsApp** | 🚨 100% somem silenciosamente em produção | CRITICAL |
| **Persistência / histórico Web** | 🚨 100% amnésico (migration pendente) | CRITICAL |
| **Inbox endpoint** | ⚠️ retorna 500 hard em vez de degradar | HIGH |
| **Loader / multi-tab / token TTL** | ⚠️ painel "morre" após 1h | HIGH |

**3 das 4 CRITICAL desbloqueiam quando aplicar 2 migrations no Supabase + 1 fix de código.** A 4ª (security) requer uma sprint dedicada.

---

## 1. CRITICAL (bloqueadores, fix imediato)

### C1 — Lembretes WhatsApp somem silenciosamente
**Severidade:** 🚨 CRITICAL — feature anunciada que NÃO funciona.
**File:** `src/lib/account-assistant/proactive/reminder-runner.ts:159-195`

O `deliverReminderWhatsapp()` **NÃO envia WhatsApp real**. Só insere uma row em `sparkbot_messages` com `pending_v3_send: true` — flag que **nenhum cron/runner consome**. Combinado com `read_in_web_at = now()` (linha 187), a msg também nem aparece no painel web como fallback.

**Impacto:** todos os lembretes que rep agendou via WhatsApp (ex: "me lembra amanhã 10h") **NUNCA chegam**. Como o cron silenciosamente marca a task como `completed`, não há retry nem alerta.

**Fix:** chamar `GHLClient.post('/conversations/messages', { type: 'WhatsApp', contactId: rep.phone_contact_id, message })` lá dentro. Estimativa: 1h dev (já tem GHLClient na codebase).

---

### C2 — Migrations 00040 + 00042 NÃO aplicadas em produção
**Severidade:** 🚨 CRITICAL — múltiplas features quebradas.
**Detectado em:** stress test reminders (turn falhou com `Could not find 'delivery_channel' column`), stress web flow (`sparkbot_messages` retorna 500 no /inbox), billing review.

Consequências em cascata:
- Tabela `sparkbot_messages` não existe → **bot 100% amnésico em produção** (synthetic-test funciona porque usa `agent_test_messages`)
- Coluna `assistant_scheduled_tasks.delivery_channel` não existe → **100% dos reminders falham** ao serem agendados
- Tabela `usage_records` não existe → **billing 0%**: todos os turnos rodam free
- `/api/sparkbot/inbox` retorna **500 hard** com erro Postgres em vez de degradar
- `rep_identities.web_session_active_at` não existe → heartbeat não funciona

**Fix:** Pedro precisa rodar no Supabase SQL Editor:
```sql
-- 1. Aplicar migration de billing + sparkbot_messages
\i supabase/migrations/00040_usage_records_and_drift_recovery.sql
-- 2. Aplicar migration de cron secret
\i supabase/migrations/00041_cron_secret_rotation.sql
-- 3. Aplicar migration de channel awareness
\i supabase/migrations/00042_sparkbot_web_channel.sql
-- 4. Forçar PostgREST refresh do schema cache
NOTIFY pgrst, 'reload schema';
```

E confirmar que constraint `UNIQUE NULLS NOT DISTINCT` foi aplicada (requer Postgres ≥15):
```sql
SELECT conname, contype, conkey
FROM pg_constraint
WHERE conrelid = 'assistant_alert_state'::regclass;
```

---

### C3 — idToken validation tautológica (CVE-SB-001)
**Severidade:** 🚨 CRITICAL — qualquer atacante anônimo emite JWT real.
**File:** `src/app/api/sparkbot/check-admin/route.ts:75-109`

O servidor decodifica o JWT do Firebase em base64 sem verificar a assinatura. A "checagem de consistência" `claims.user_id === userId && claims.company_id === companyId` é **tautológica** — atacante controla AMBOS os lados (body do POST E claims que ele mesmo forjou).

**Confirmado no stress test:** forjei JWT com sig literal `"fake-signature-not-verified-by-server"` e foi aceito. Server emitiu Bearer real → acesso completo a `/send`, `/inbox`, `/transcribe`. Drain de billing, leak de histórico, criação de tasks/notes em contatos reais do CRM.

**Fix correto:** verificar assinatura via Firebase JWKS (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`). Estimativa: 4h dev.

**Mitigation imediato (até fix completo):** validar via GHL API (fallback que já existe), e desabilitar o branch de `idToken` em prod via feature flag. Custo: 30min, mas degrada UX (agency users que não aparecem em `/users/?locationId=` voltam a falhar).

---

### C4 — Whisper roda free em 2 paths
**Severidade:** 🚨 CRITICAL — vazamento ativo de receita.
**Files:**
1. `src/app/api/sparkbot/transcribe/route.ts:93` — passa `tok.rep_id` como `agentId`. Viola FK `usage_records.agent_id REFERENCES agents(id)`. INSERT falha em try/catch silencioso. **Whisper Web 100% free.**
2. `src/lib/account-assistant/webhook-handler.ts:236` — chama `transcribeAudioFromUrl` mas NUNCA chama `trackAndCharge`. **Whisper Sparkbot WhatsApp 100% free.**

**Fix:** trocar `agentId: tok.rep_id` por `agentId: hubAgent.id` (resolve via lookup). E replicar o billing pattern do `queue/processor.ts:317` no webhook-handler. Estimativa: 1h dev cada.

---

## 2. HIGH (essa sprint)

### H1 — `cache_creation_input_tokens` nunca preenchido
**File:** `src/lib/account-assistant/llm-client.ts:255-261` lê só `cache_read_input_tokens`. Os 8 call sites de `trackAndCharge` no Sparkbot deixam `cacheCreationTokens` undefined.

**Impacto:** subcobrança sistêmica do **125% premium Anthropic** em TODO turno do Sparkbot que escreve cache. Estimativa: ~$30-100/mês escalando linear com volume.

**Fix:** `llm-client.ts` extrair `usage.cache_creation_input_tokens`, propagar pra `processIncoming`, propagar pra `trackAndCharge`.

---

### H2 — quiet_hours ignorado por reminders
**File:** `src/lib/account-assistant/proactive/reminder-runner.ts:fireScheduledReminders`
Reminder agendado pra noite (recurring `0 23 * * *`) dispara mesmo se `agent_configs.quiet_hours` está configurado.

**Fix:** ler quiet_hours do hub_agent_config no início do runner, skipar tasks dentro dessa janela.

---

### H3 — Token JWT 1h sem refresh — painel "morre" após 1h
**File:** `src/lib/account-assistant/web-auth.ts:21` + `loader.js`
Após 60min, todas as chamadas viram 401. Loader não reexecuta auth. Painel fica em silêncio até rep recarregar a página GHL inteira.

**Fix:** loader implementa refresh proativo aos 50min OU detecta 401 → re-roda check-admin → atualiza Authorization. Estimativa: 1h.

---

### H4 — CORS `*` + zero rate limit
**Files:** todos endpoints `/api/sparkbot/*` e `/api/agents/account-assistant/*`
- CORS `Access-Control-Allow-Origin: *` aceita request de qualquer origin com Bearer válido. Phishing pode roubar tokens.
- Zero rate limit. Atacante com 1 token = 36k requests/h = drenar OpenAI/Claude billing.

**Fix:** allowlist de origins via env (`ALLOWED_SPARKBOT_ORIGINS`) + rate limit 60req/min/rep no middleware. Estimativa: 2h.

---

### H5 — Token na URL do iframe (Referer leak)
**File:** `loader/route.ts:364`, `page.tsx:55-57`
JWT temp vai como query param `?token=...`. Vaza via:
- Referer header se rep clica em link externo
- Vercel logs (acesso interno)
- Browser history

**Fix:** loader injeta o iframe sem token na URL e passa via `postMessage` + `iframe.contentWindow` após onload. Estimativa: 2h.

---

### H6 — Computar próximo run de cron ineficiente em datas impossíveis
**File:** `proactive/reminder-runner.ts:computeNextRun`
Cron `0 0 30 2 *` (30 fev) → loop 31 dias × 1440min antes de retornar null. Task vira `failed` silenciosamente.

**Fix:** validar cron na criação (no schedule_reminder tool) + max attempt 7 dias. Estimativa: 1h.

---

### H7 — `usesCustomKey: false` hardcoded
**Files:** `account-assistant/processor.ts:259`, `proactive/dispatcher.ts:403`
Sparkbot nunca lê `location_settings.openai_api_key`. Se cliente trouxer key, é overcharge.

**Fix:** ler config no início de processIncoming/dispatch. Estimativa: 30min.

---

### H8 — Idempotency rasa em chargeWallet
**File:** `billing/charge.ts`
`chargeWallet` usa `record.id` (uuid novo a cada call) como Idempotency-Key. Protege apenas retry GHL→GHL, não duplo-POST do client → 2 usage_records → 2 cobranças.

**Fix:** key baseado em `(location_id, contact_id, action_type, hash(input)+timestamp)` antes do INSERT. Estimativa: 1h.

---

## 3. MEDIUM (esse mês)

| # | Área | Issue | File | Fix |
|---|---|---|---|---|
| M1 | Reminders | TZ drift entre advanceTask e cron route | reminder-runner.ts:155 | Usar `rep.active_location_id` consistente |
| M2 | Reminders | cancel_reminder race com claim já running | reminders.ts:198-204 | Permitir cancelar 'running' marcando flag |
| M3 | Reminders | list_my_reminders não retorna delivery_channel | reminders.ts:148-178 | Incluir no return |
| M4 | Reminders | Cross-canal cancel: rep web-only id divergente | identity.ts:175 | Unificar reps por phone canonicizado |
| M5 | Reminders | delivery_channel default 'whatsapp' + código morto | reminders.ts:92 | Default 'auto' lendo rep.preferred_channel |
| M6 | Billing | contact_id = rep.id (uuid) não casa com execution_log.contact_id (string GHL) | processor.ts:268 | Usar ghl_user_id ou phone como contact_id |
| M7 | Billing | Web e WhatsApp usam location_id divergentes | send/route.ts:104 vs webhook-handler:155 | Convencionar fonte de verdade |
| M8 | Loader | Memory leak em STATE.lastSeenIds (Set sem limite) | loader/route.ts:70 | Truncar a 200 IDs mais recentes |
| M9 | Loader | setInterval sem clearInterval — re-injection acumula intervals | loader/route.ts:505-513 | Salvar IDs em STATE e clear no boot |
| M10 | Loader | iframe sem `sandbox` attribute | loader/route.ts:294 | `sandbox="allow-scripts allow-same-origin allow-forms"` |
| M11 | Web | Possível log de PII no idToken mismatch | check-admin:104 | Não logar payload em produção |
| M12 | Reminders | Reaper pra status='running' órfão (lambda morto) | reminder-runner.ts | Reset > 5min running |
| M13 | Billing | Test routes (`/api/agents/test/*`) não cobram | route.ts | Opt-in cobrança como "training cost" |
| M14 | UI/UX | Bot não distingue create_task vs schedule_reminder | prompt-builder.ts | Exemplos contrastantes nas tool descriptions |
| M15 | UX | Cancel cross-canal mensagem genérica "não pertence a você" | reminders.ts:198 | Mensagem específica explicando rep web vs whatsapp |
| M16 | UX | Confirmation_mode quebrado em web — bot pediu mas tool já executou | tools/index.ts:96 | Já corrigido em sprint 0; validar em produção |

---

## 4. Padrões transversais

### P1 — Migrations defensive, mas demais
A defesa "try/catch silencia se tabela não existe" é boa pra deploy progressivo, mas mascara o estado em produção: bot rodando 0% billing, 0% histórico, 0% reminders sem alarme. **Sprint 0 já tem 3 migrations escritas — Pedro não aplicou ainda.**

**Recomendação:** adicionar health check `/api/admin/migration-status` que faz `SELECT to_regclass('public.usage_records')` etc. e alerta no dashboard se algo estiver missing.

### P2 — Sparkbot Web UI é mais inseguro que produção da agency
- iframe embedado, recebe token na URL
- CORS *, sem rate limit, idToken sem verify
- 1 sessão JWT 1h sem refresh — UX quebra silenciosamente

**Recomendação:** sprint dedicada de hardening Web UI. Backend resta basicamente OK; o problema é a superfície aberta da camada `embed/` + `api/sparkbot/`.

### P3 — Test routes diverge de prod routes
Test routes (`/api/agents/test/*`) e synthetic-test não cobram, prod cobra. Isso significa:
- QA roda free
- Stress tests não exercitam billing
- Atacante que descobre URL test usa free

**Recomendação:** test routes devem chamar `trackAndCharge` com flag `is_test=true` que cobra mas marca pra excluir do faturamento real. Ainda registra usage pra detectar abuse.

### P4 — Áudio é o ponto fraco do billing
Whisper sem cobrança no Sparkbot WhatsApp + Whisper sem cobrança correta no Web (FK violation) = **dois canais inteiros free**. Áudios são uso ALTO em vendas — provavelmente representam 30-50% do volume.

**Recomendação:** auditoria E2E de áudio depois dos fixes de C4.

---

## 5. O que está bem feito (preservar)

- **Conversação:** branding 100% Spark, resistência adversarial 100%, hedging correto em queries de KB, integração tools fluida (search_contacts, list_appointments, schedule_reminder funcionam)
- **Cache hit ratio 93-96%** em todos os stress tests
- **Atomic claim** via `UPDATE...RETURNING` em fireScheduledReminders e chargeUnbilledRecords (Postgres serializa)
- **Bearer header em vez de cookie** = CSRF imune
- **JWT separado** do session principal
- **Limites de tamanho de áudio** (25MB max, 100 bytes min)
- **Idempotency guard** `__sparkbotInjected` evita re-execution
- **iframe state** preservado entre toggles
- **Watcher de 3s** pro Vue re-render do GHL
- **Fallback flutuante** se header não for achado
- **Validação cron** em schedule_reminder (5 campos, regex)
- **Validação ISO 8601** nas dates
- **`__sparkbotDebug()`** helper exposto pra debug rápido
- **Reminder runner** atomic claim funciona pra concorrência
- **Sales/recruitment paths** (queue/processor, follow-up, summary-note) — billing OK ✓

---

## 6. Plano priorizado

### Sprint 0 (HOJE — 1 dia)
1. **Aplicar migrations 00040+00041+00042 no Supabase** (operacional, 30min) — desbloqueia C2 inteiro
2. **C4 fix Whisper FK** — `transcribe/route.ts:93` mudar `agentId: tok.rep_id` → `agentId: hubAgent.id` (1h)
3. **C4 fix WhatsApp billing** — webhook-handler chamar `trackAndCharge` (1h)
4. **C1 fix WhatsApp delivery** — `reminder-runner.ts` enviar GHL conversations/messages real (1h)
5. **C3 mitigation** — temporariamente desabilitar branch idToken via env `SPARKBOT_TRUST_IDTOKEN=0` (15min)

**Output Sprint 0:** billing real ativa, lembretes WhatsApp entregam, drain de admin via JWT forjado fechado.

### Sprint 1 (próxima semana — 3-5 dias)
- C3 fix completo — verify de assinatura JWT via Firebase JWKS (4h)
- H1 — cache_creation_input_tokens propagar (2h)
- H2 — quiet_hours respeitado em reminders (1h)
- H3 — token refresh no loader (1h)
- H4 — CORS allowlist + rate limit middleware (2h)
- H5 — token via postMessage no iframe (2h)
- H6 — validação cron pré-criação + max 7 dias (1h)
- H7 — usesCustomKey lookup (30min)
- H8 — idempotency-key real (1h)

### Sprint 2 (esse mês)
- M1-M16 (médios)
- P1 — health check migration status no dashboard
- P3 — test routes com is_test flag
- P4 — auditoria E2E de áudio billing pós-C4

### Backlog
- Service Worker + VAPID pra Web Push real
- V3 WhatsApp send via GHL API (paralelizar com C1)
- Multi-tab dedup (1 tab tem o painel "líder", outras só badge)
- Sandboxing iframe stricter
- Multi-rep test flow

---

## 7. Métricas agregadas (37 turnos reais)

| Métrica | Valor |
|---|---|
| Turnos totais | 37 (15 web + 18 reminders + ~~5~~ billing) |
| % PASS | 84% (ignorando bugs de migration) |
| Cache hit médio | 93-96% |
| Custo médio por turno | $0.014 (com markup 20%) |
| Latency mediana | 3-4s |
| Latency p95 | 8s |
| Modelos efetivos | 100% claude-sonnet-4-6 |
| Adversarial resistance | 100% |
| Branding Spark Leads | 100% (zero menção a GHL pra user) |
| Tools que funcionaram | search_contacts, list_appointments, list_opportunities, schedule_reminder, list_my_reminders, query_carrier_knowledge |
| Tools que NÃO foram exercitadas | cancel_reminder, create_task, update_*, delete_* |

---

## 8. Estimativa de impacto financeiro

| Bug | Loss/mês | Pós-fix |
|---|---|---|
| C2 (migrations pendentes) — billing 0% | $1,300+ (se 10 reps) | $0 |
| C4 Whisper Web/WhatsApp free | $50-100 | $0 |
| H1 cache_creation 125% subcobrança | $30-100 | $0 |
| C1 lembretes WhatsApp falham (não é loss, é feature broken) | UX degrada drasticamente | UX OK |
| C3 forjar JWT (potencial drain) | hipotético — depende de descoberta | $0 |
| **Total recovery** | **~$1.4-1.5k/mês** | — |

---

## 9. Próximos passos

**Pra você (Pedro):**
1. Confirma que vai aplicar as 3 migrations no Supabase (5min de execução, ~30min de validação) — isso desbloqueia 70% dos issues
2. Decide ordem: vou começar pelo Sprint 0 inteiro? Ou só os 4 CRITICAL?
3. Posso atacar Sprint 0 agora, em paralelo, com você só validando ao final

**Refs:**
- `stress-test/01-reminders-proatividade.md`
- `stress-test/02-web-flow.md`
- `stress-test/03-billing-coverage.md`
- `code-review/01-billing.md`
- `code-review/02-security.md`
- `code-review/03-reminders.md`
- `code-review/04-loader.md`

**Custo do review:** ~$1.0 USD (37 turnos stress + 4 code reviews × claude-sonnet).
