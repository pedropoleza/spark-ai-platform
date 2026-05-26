# 00 — RELATÓRIO EXECUTIVO · Ultra-Análise da Plataforma Spark AI Hub

> Data: 2026-05-26 · Síntese (Tier 0) consolidando C1 (Front-end/UX), C2 (Funcionalidades de Agentes), C3 (Billing/Módulos), C4 (Segurança/Código).
> Fonte: `C1-SINTESE.md`, `C2-SINTESE.md`, `C3-SINTESE.md`, `C4-SINTESE.md`. READ-ONLY — nenhum código/git/deploy tocado nesta consolidação.
> Marcadores de responsabilidade: 🤖 Claude aplica sozinho (código/UI puro) · 👤 Pedro decide/age (prod/dinheiro/migração/secret) · 🤝 Claude prepara, Pedro aprova/aplica.

---

## 1. Sumário executivo

A plataforma está **estruturalmente sólida e bem-acabada**, mas a varredura profunda achou **2 P0 de segurança reais** (forja de sessão SSO fail-open + edição cross-company da config do SparkBot global) que, combinados, dão a um atacante anônimo o controle do prompt do bot que fala com todos os reps — e como o **RLS está dormente** (todas as rotas usam service-role), o isolamento multi-tenant é 100% aplicacional, sem rede de segurança. No dinheiro, há **revenue vazando agora**: ~$17.50 em `usage_records` travados por claims órfãos sem reaper (192 records nunca mais serão cobrados) e uma subcobrança silenciosa de ~25% sobre cache-creation tokens. Em funcionalidade de agente, a regressão mais séria é o **agendamento quebrado ponta-a-ponta no hub novo** (`calendar_id` nunca é populado) e ações de automação descartadas em gatilhos de evento. O front-end não tem P0 — os P1 são gaps de a11y/estados ausentes, não falhas. As correções de segurança da rodada anterior (isUserAdmin, IDOR de KB/módulos, SSRF, upload limits, JWT/JWKS) foram verificadas e **seguram**.

### Contagem por domínio

| Domínio | P0 | P1 | P2 | Total |
|---------|:--:|:--:|:--:|:-----:|
| C4 — Segurança & Código | **2** | 3 | 5 | 10 |
| C3 — Billing & Módulos | **1*** | 3 | 5 | 9 |
| C2 — Funcionalidades de Agentes | 0 | 4 | 5 | 9 |
| C1 — Front-end & UX | 0 | 8 | 8 | 16 |
| **TOTAL** | **3** | **18** | **23** | **44** |

\* C3-1 está classificado pelo coordenador como **P0/P1** (dinheiro vazando agora, mas valor pequeno e crescendo). Tratado aqui como **P0** por ser perda de receita ativa + vazamento permanente sem reaper. C2-RISK "custom framing" foi marcado P1/P2 pelo coordenador → contado em P1.

---

## 2. P0 — Crítico (ordenado por severidade real)

> Ordem: auth bypass / vazamento cross-tenant primeiro, depois dinheiro vazando.

### P0-1 · 🤝 SSO fail-open: forja de sessão para QUALQUER location (sem auth) — C4
- **file:line:** `src/lib/auth/sso.ts:62-70` (`validateGHLUser`) + `src/app/api/auth/sso/route.ts:15-61`; encadeia com `src/lib/ghl/auth.ts:31-33`.
- **O quê / porquê:** `POST /api/auth/sso` é público. Quando a GHL API falha (e ela **falha de cara** para um `company_id` sem token OAuth — `getCompanyToken` dá throw), o código cai num bloco fail-open que **retorna um user fabricado** (`isAdmin:false`) em vez de `null`. A rota emite cookie `spark_session` válido para o `location_id` arbitrário (enumerável na URL do GHL). Com RLS dormente, essa sessão passa em todos os `.eq(location_id)` → leitura cross-tenant de billing, settings, conversas, KB, contatos.
- **Fix (1 linha):** `validateGHLUser` deve **retornar `null`** quando a GHL não confirma o user (remover o fallback "acesso limitado"); a rota já trata `null`→403. Idealmente, exigir verificação de assinatura/JWT do GHL no `/sso` como o `/check-admin` faz.
- **Marcador:** 🤝 — fix é código puro, mas mexe no caminho de auth de produção; Claude prepara, Pedro valida 1 login real antes de mergear.

### P0-2 · 🤝 `agents/[agentId]/config`: edição do SparkBot global por QUALQUER sessão (cross-company) — C4 (= C2-P2 escopo config)
- **file:line:** `src/app/api/agents/[agentId]/config/route.ts:30` (GET) e `:76` (PUT).
- **O quê / porquê:** para `agent.type === "account_assistant"` a rota **pula** a checagem de location/company — basta `getSession()` (qualquer autenticado). Sem `isAdmin`, sem `assertLocationInCompany` (compare com `modules/route.ts:40-43`, já corrigido). `system_prompt_override`/`custom_instructions`/`disabled_tools`/`confirmation_mode` do SparkBot (que fala com TODOS os reps) ficam graváveis por sessão de outra conta. Encadeado com P0-1 → controle total do prompt do bot global. (C2 reportou o mesmo como P2 "inconsistência de escopo"; C4 corretamente eleva a P0 pelo impacto.)
- **Fix (1 linha):** trocar o gate por `assertLocationInCompany(agent.location_id, session.companyId)` **e** exigir `session.isAdmin`, igual ao `modules/route.ts`.
- **Marcador:** 🤝 — código puro, mas é authz de prod do bot global; Pedro aprova/valida.

### P0-3 · 👤 Claims órfãos em `usage_records`: receita vazando agora, sem reaper — C3 (C3-1)
- **file:line:** `src/lib/.../usage-records.repo.ts:218-236` (`claimUnbilledBatch`), `charge.ts:332-358`, `process-queue/route.ts:8-21`.
- **O quê / porquê:** `claimUnbilledBatch` só pega `claim_token IS NULL`. Quando um record recebe `claim_token` mas não é cobrado nem liberado (lambda morre no loop sequencial de `fetch` ao GHL), fica travado **para sempre** — `releaseClaimForRecord` só roda no `catch` de cada record, não quando a função inteira é morta por timeout. **Prova prod:** 234 records unbilled, **$17.4965** não cobrados, oldest 2026-05-05 (3 semanas), **192 com `claim_token` setado** que nunca mais serão retentados. Não existe reaper que reseta `claim_token` stale (o reaper inline do `queue-processor.ts:71` é só pra `message_queue`).
- **Fix (1 linha):** reaper que zera `claim_token`/`claimed_at` onde `claimed_at < now() - interval '15 min' AND charged_to_wallet=false` + `claimUnbilledBatch` incluir `OR claimed_at < cutoff`; e investigar por que `chargeWallet` falha desde ~05-05.
- **Marcador:** 👤 — toca billing/dinheiro real em prod + investigação do GHL charge; Pedro decide/age (Claude pode preparar o reaper, mas a aplicação e a investigação de cobrança são do Pedro).

---

## 3. P1 — Degrada (agrupado por domínio)

### C4 — Segurança (3)
- **P1-1 · 🤝 IDOR nas regras de proatividade do SparkBot (PUT/DELETE por ruleId)** — `src/app/api/agents/sparkbot/rules/[ruleId]/route.ts:24-29` (PUT), `:100-105` (DELETE). Busca `assistant_proactive_rules` só por `id`, sem amarrar ao agent do hub, sem location/company, sem `isAdmin`. As irmãs GET/POST escopam certo; só o `[ruleId]` ficou. `ruleId` é UUID (não enumerável), mas exploitável com o id em mãos (vaza no GET). **Fix:** exigir `existing.agent_id === <hub agent id>` (resolvePrimaryHub) + `session.isAdmin`. Mesma classe do IDOR de KB já corrigido.
- **P1-2 · 👤 `next@15.5.15` com CVEs HIGH de Middleware bypass** — GHSA-267c-6grr-h53f / GHSA-26hh-7cqf-hhc6 / GHSA-492v-c6pp-mqqv. O **único** gate de `/admin/*` e `/api/admin/*` é o `src/middleware.ts` (Basic Auth); bypass = painel admin + `/api/admin/dashboard` (billing de TODAS as locations, PII) sem senha. **Fix:** `npm i next@latest` (15.x patched). 👤 porque é bump de dependência + verificar build em prod.
- **P1-3 · 👤 `xlsx@0.18.5` (SheetJS) HIGH, sem patch no npm** — Prototype Pollution (GHSA-4r6h-8v6p-xvw6) + ReDoS (GHSA-5pgg-2g8v-p4x9), "No fix available" via npm. Parseia upload não-confiável em `src/app/api/knowledge-base/route.ts:43` e `file-processor.ts`. **Fix:** migrar pro tarball oficial do SheetJS (cdn.sheetjs.com) ou trocar por `exceljs`. 👤 decisão de dependência.

### C3 — Billing (3)
- **C3-2 · 👤 Retry de cobrança subdimensionado** — `vercel.json:3-6` (`process-queue` `0 0 * * *` = 1×/dia, `maxDuration=60`) roda `chargeUnbilledRecords()` em `Promise.all` com 3 jobs pesados. Budget de 60s acaba → loop de charge morre no meio → estranda claims (causa raiz de P0-3). E 1×/dia × 50 nunca drena os 192 presos. **Fix:** cron próprio frequente (5-10min via pg_cron com guarda) só pra billing-retry. 👤 — cron de prod.
- **C3-3 · 👤 `cache_creation_tokens` nunca persistido e nunca cobrado a 125%** — `charge.ts:48-77`, `usage-records.repo.ts:19-36`. `calculateCost` cobra 125% (`pricing.ts:153`) mas **nenhum call site passa o campo** (`processor.ts:627`, `dispatcher.ts:578`, `queue-processor.ts:760`, `webhook-handler.ts:607`); `LLMResult` nem expõe creation separado (`llm-client.ts:421` dobra no `prompt_tokens`). Efeito: creation cobrado ao **fresh rate** ($3.00/M) em vez de cache-write ($3.75/M) → **subcobrança de ~25% sobre creation tokens**; coluna ausente no insert → audit sempre 0 (0/2100 rows). O comentário `charge.ts:40` afirma o oposto (falso). **Fix:** expor `cache_creation_tokens` no `LLMResult`, propagar até `insertUsageRecord`, adicionar coluna no insert. 👤 — dinheiro + migração de coluna.
- **C3-4 · 👤 Escopo do cap inconsistente (agent vs location)** — `charge.ts:235-271`, `agents.repo.ts:164-174`. `isMonthlyCapReached` lê o cap de UM agent (`getMonthlySpendCap(agentId)`) mas soma o spend da location inteira. CLAUDE.md define cap per-location. Hoje benigno (18/18 configs com cap $100), mas frágil ao adicionar agente lead-facing sem cap. **Fix:** resolver cap por location (não pelo agent que disparou). 👤 — lógica de billing.

### C2 — Funcionalidades de Agentes (4)
- **C2-1 · 🤝 Agendamento quebrado ponta-a-ponta no hub novo (`calendar_id` nunca setado)** — `agent-detail-view.tsx:714` (aba diz *"A escolha de calendário entra em breve aqui"* — sem editor), `builder-spec.ts:specToConfig` (não escreve `calendar_id`), `builder/commit/route.ts`, runtime `queue-processor.ts:391` (sem `calendar_id` → nunca busca free-slots), `action-executor.ts:188` (`book_appointment` cai com `calendarId:""`). Wizard oferece "Qualificar + agendar"/"Só agendar" mas nada popula `calendar_id`. **Prova prod:** os 3 `custom_agent` e vários sales/recruitment novos têm `calendar_id=null`; só os criados pela UI legada (`sales-config-content.tsx:294`) têm. O hub novo regrediu a capacidade. **Fix:** expor seletor de calendário na aba Agendamento + gravar `calendar_id` no `specToConfig`/commit; ou bloquear objetivo de booking até calendário escolhido. 🤝 — UI+código, Pedro valida fluxo.
- **C2-2 · 🤖 Automações de EVENTO descartam ações `send_text_fixed`/`send_media`/`pause_ai`/`webhook`** — UI oferece as 8 ações p/ qualquer gatilho (`agent-detail-view.tsx:808-813`), mas o runtime event-based `executeAutomations` (`queue-processor.ts:933-966`) só trata 4 (`add_tag`/`remove_tag`/`move_pipeline`/`update_field`). As mesmas ações funcionam no gatilho "Campo preenchido" (`on_data_field_set`→`reaction-engine.ts:145-237`). Regra salva mas nada acontece no evento. **Fix:** rotear o ramo event-based pelo `executeReactionRules` (já cobre tudo) ou completar o switch. 🤖 — bug de código puro.
- **C2-3 · 🤖 Notificações por email do agente de lead são dead-write** — `agent-detail-view.tsx:1007-1011` (on_qualified/on_booked/on_handed_off + notification_email), zod aceita (`validation.ts:188`), mas **nenhum leitor** fora de validation/UI (grep confirma). `notify.ts` só tem `notifyCriticalError`. Admin liga "avisar quando qualificar/agendar" e nunca chega email. **Fix:** implementar consumo no `objectiveCompleted` (`queue-processor.ts:805`) ou esconder a seção até existir. 🤖 — código/UI (Claude pode esconder a seção sozinho; implementar envio real é maior).
- **C2-4 · 🤝 `custom_agent` roda com framing de VENDAS hardcoded** (coordenador: P1/P2) — `queue-processor.ts:588` força `agentType` sales/recruitment; `sales-prompt-builder.ts:324` injeta "NATUREZA DO ATENDIMENTO: VENDAS" com regras invioláveis que brigam com `custom_instructions` de um custom não-comercial. O próprio comentário reconhece o gap. **Fix:** para `custom_agent`, não forçar typeFraming de vendas (agentType neutro/derivar do propósito). 🤝 — muda comportamento do prompt; Pedro valida.

---

## 4. P2 — Polish (1 linha cada)

### C4 — Segurança
- **P2-1 · 🤖** `.or()` por string-interp em `tools/followup.ts:499` (não é cross-tenant — `.eq` em AND antes; rep distorce só o próprio filtro). Fix: sanitizar `,()%*\` em `contact_query`.
- **P2-2 · 🤖** Dependência morta `pdf-parse@^2.4.5` (zero refs em `src/`, tudo migrou pra `unpdf`). Fix: remover de `package.json`.
- **P2-3 · 🤖** Código órfão `seedSystemRules` em `proactive/seed.ts` (nada chama). Fix: remover ou ligar num provisioning real.
- **P2-4 · 👤** Stevo webhook fail-open de origem (`webhooks/stevo/route.ts:67-79`): sem `STEVO_INSTANCE_TOKEN` aceita qualquer payload. Fix: garantir a env em prod.
- **P2-5 · 🤖** `synthetic-test/route.ts:39` compara secret sem timing-safe. Fix: padronizar via `isAuthorizedCron`.

### C3 — Billing
- **C3-5 · 👤** `audio_model` nunca persistido (90/90 rows Whisper com NULL) — auditoria cega (`charge.ts:60-77`, `usage-records.repo.ts:19-36`). Fix: propagar + coluna.
- **C3-6 · 🤖** `/api/settings` PUT sem validação (`daily_message_limit`/`cost_alert_threshold`/`openai_api_key` raw) — `settings/route.ts:46-67`. Fix: validar (numérico>0; key `^sk-`).
- **C3-7 · 🤖** `daily_message_limit` e `cost_alert_threshold` são settings MORTOS (gravados pela UI, consumidos em lugar nenhum) — UX enganosa. Fix: implementar consumo ou esconder.
- **C3-8 · 👤** Drift cron: `chargeUnbilledRecords` só roda 1×/dia no Vercel (elo mais fraco; ver C3-2/P0-3). Fix: job de billing-retry frequente.
- **C3-RISK · 👤** PII em `execution_log.action_payload` (conteúdo de `message` ao lead, sem TTL/cleanup) — exposição LGPD. Fix: redigir conteúdo ou cron de retenção.

### C2 — Funcionalidades de Agentes
- **C2-P2a · 🤝** `preferred_time_slot="morning"` é no-op no prompt (só `afternoon_evening` tratado em `buildRecruitmentSection`, `sales-prompt-builder.ts:439`); campo morto p/ sales. Fix: tratar "morning" ou ocultar p/ sales.
- **C2-P2b · 🤖** `max_messages_per_conversation` não aplicado p/ agentes de lead (`agent-detail-view.tsx:984`; sem leitor no runtime de lead). Fix: aplicar cap no `queue-processor` ou esconder.
- **C2-P2c · 🤖** `custom_instructions`/`conversation_examples` truncados a 3000/2000 (`sales-prompt-builder.ts:847,866`) bem abaixo do limite da UI (10000/20000, `validation.ts:101-102`). Fix: alinhar caps ou avisar truncamento.
- **C2-P2d · 👤** DST: offset de timezone hardcoded no agendamento (`sales-prompt-builder.ts:693-696`) → 1h errado no inverno. Fix: derivar offset real via Intl/tz lib.
- **C2-P2e · 🤝** Outreach nasce com `rate_per_hour:20`/`daily_cap:100` fixos e disparo manual (`builder-spec.ts:262-270`) — não urgente; documentar que nasce supervisionado (já avisado na UI).

### C1 — Front-end & UX
- **C1-P2a · 🤖** 7 `<select>` em `agent-detail-view.tsx` (targeting/automations/deactivation) sem `aria-label`.
- **C1-P2b · 🤖** Preço `$50` hardcoded (`primitives.tsx:70`, `new-agent-flow.tsx:72`) vs `monthly_price_usd` real → drift. Fix: `PriceBadge` receber `price`.
- **C1-P2c · 🤖** Var CSS errada `--warn-soft` (correto `--warning-soft`) em `agent-detail-view.tsx:573` → callout de aviso cai no fallback cinza.
- **C1-P2d · 🤖** Billing mostra `action_type`/`ai_model` crus (`send_message`, `claude-sonnet-...`) sem humanizar (`lib/hub/data.ts:461-466`, `billing/page.tsx:82`).
- **C1-P2e · 🤖** CTA "Novo agente" global na topbar repete em toda tela, inclusive no próprio wizard (`topbar.tsx:45-47`). Fix: ocultar quando `pathname` começa com `/hub/agents/new`.
- **C1-P2f · 🤖** CSS órfão: `.sb__loc`, `.sb__foot*`, `.searchbox`/`kbd` (markup removido) — `hub.css:159-161,170-172,179-182`.
- **C1-P2g · 🤖** Access grid esconde locations sem `location_name` (`.not(... is null)`, `lib/hub/data.ts:363`) → escritórios somem silenciosamente. Fix: incluir todos, exibir `location_id` como fallback.
- **C1-P2h · 🤖** Status "online"/tags (`proativa`,`WhatsApp`) e dot verde dependem de cor (têm `title`, sem texto p/ SR) — `embed/sparkbot/page.tsx:447,1056-1058`.

---

## 5. Plano de correção faseado

> Esforço: P = pequeno (<1h), M = médio (1-3h), G = grande (>3h / multi-arquivo).

### Fase 1 — P0 SEGURANÇA (URGENTE, antes de tudo)
| Item | Esforço | Marcador | Precisa ok do Pedro? |
|------|:--:|:--:|:--:|
| P0-1 SSO fail-open → `validateGHLUser` retorna `null` | P | 🤝 | **Sim** (caminho de auth de prod — validar 1 login real) |
| P0-2 config SparkBot → `assertLocationInCompany` + `isAdmin` | P | 🤝 | **Sim** (authz do bot global) |
| P1-1 IDOR rules `[ruleId]` → escopar agent + `isAdmin` | P | 🤝 | Recomendado (mesma classe do P0-2; cabe junto) |

> Os 3 são correções de código pequenas e da mesma família (authz). Claude prepara o diff dos 3; Pedro aprova e valida um login/uma edição real antes de mergear. Bloqueio dos 3 dá superfície de ataque cross-tenant.

### Fase 2 — P1 DINHEIRO / BILLING
| Item | Esforço | Marcador | Precisa ok do Pedro? |
|------|:--:|:--:|:--:|
| P0-3 + C3-2 Reaper de claims órfãos + cron de billing-retry frequente | M | 👤 | **Sim** (cron de prod + recupera os 192 travados) |
| C3-3 `cache_creation_tokens` (expor no `LLMResult`→propagar→coluna) | M | 👤 | **Sim** (dinheiro + migração de coluna) |
| C3-4 Cap por location (não por agent) | M | 👤 | **Sim** (lógica de billing) |
| Investigar falha do `chargeWallet` desde ~05-05 (logar `errorBody` GHL) | M | 👤 | **Sim** (diagnóstico prod) |

> Bundle "dinheiro": Claude pode preparar o reaper (migration + função) e o patch de `cache_creation`, mas a aplicação em prod, a investigação do GHL charge e a recuperação dos $17.50 são decisão do Pedro. Migrações sempre em `supabase/migrations/`.

### Fase 3 — P1 FUNCIONALIDADE DE AGENTE
| Item | Esforço | Marcador | Precisa ok do Pedro? |
|------|:--:|:--:|:--:|
| C2-1 Agendamento: seletor de calendário na aba + gravar `calendar_id` | G | 🤝 | **Sim** (UI+spec+commit; validar fluxo de booking) |
| C2-2 Automações de evento → rotear pelo `reaction-engine` | M | 🤖 | Não (bug de código; parity com o ramo on_data_field_set) |
| C2-3 Email notifications: esconder seção OU implementar envio | P/G | 🤖/🤝 | Esconder = 🤖 não; implementar envio = 🤝 sim |
| C2-4 `custom_agent` sem framing de vendas forçado | M | 🤝 | **Sim** (muda comportamento do prompt — validar 1 conversa) |

### Fase 4 — P1/P2 FRONT-END + LIMPEZA
| Item | Esforço | Marcador | Precisa ok do Pedro? |
|------|:--:|:--:|:--:|
| C1 P1 a11y/estados: `loading.tsx`+`error.tsx` no `/hub`; a11y do `SchedulingSettingsModal`; `title`/`aria-label` sidebar colapsada; `aria-label` sliders+textarea; `aria-live` nos chats | M | 🤖 | Não |
| C1 P1 feed de atividade: nome real do agente + alinhar copy "agentes de leads" + filtrar por audiência | M | 🤖 | Não |
| C1 P2 (todos a-h): `--warning-soft`, `$50` dinâmico, humanizar billing, CSS órfão, locations sem nome, CTA no wizard, selects/aria | P-M | 🤖 | Não |
| C2 P2 (b,c): `max_messages` cap, alinhar caps de truncamento | M | 🤖 | Não |
| C3 P2 (6,7): validar PUT `/api/settings`, settings mortos | P | 🤖 | Não |
| C2 P2 (a,d), C3-5, C3-RISK PII: morning slot, DST offset, `audio_model`, redação de PII em log | M | 🤝/👤 | DST+PII recomendam ok do Pedro |
| C4 P2 limpeza: remover `pdf-parse`, `seed.ts` órfão, timing-safe synthetic-test, sanitizar `.or()` | P | 🤖 | Não |
| C4 P2-4 Stevo `STEVO_INSTANCE_TOKEN` em prod | P | 👤 | **Sim** (env de prod) |

> A maior parte da Fase 4 é 🤖 (código/UI puro) e pode ser aplicada por Claude direto, em lotes pequenos por tema.

---

## 6. Falsos-positivos descartados (não re-investigar)

**Billing (C3):**
- ~~Vision/imagem não cobrado~~ — `image_count` é só telemetria; tokens de imagem entram em `prompt_tokens` (multimodal) e são cobrados como input (`queue-processor.ts:770`). Path correto.
- ~~Markup errado~~ — confirmado 10% exato em rows reais (`markup_usd/cost_usd = 0.1000`).
- ~~Double-count de cached~~ — `calculateCost` faz `safeCached = min(cached, prompt)` e desconta do fresh (`pricing.ts:147-149`).
- ~~GET `/api/settings` vaza key~~ — mascarada `sk-...{last4}` (`settings/route.ts:23-25`).
- ~~Secret Bearer no `cron.job` do sparkbot-proactive~~ — design do pg_cron, rotacionado via migration 00041, tabela só acessível a superuser/service-role. Não explorável.

**Funcionalidades de Agente (C2):**
- ~~`enable_summary_notes` ignorado~~ — `generateSummaryNote` sempre chamado, faz SKIP interno se OFF (`summary-note-generator.ts:75`).
- ~~`auto_pause_on_human_message`/`handoff_messages` dead-write~~ — lidos/aplicados em `inbound-message/route.ts:338-449`.
- ~~`deactivation_rules` dead-write~~ — lidos em `inbound-message/route.ts:599`.
- ~~Agentes legados (audience/template_key NULL) viram rep e perdem abas de lead~~ — fallback em `lib/hub/data.ts:81,295`.
- ~~`conversation_examples` do wizard perdido~~ — tecnicamente vira `""` no `/compose`, mas é campo opcional editável depois — inofensivo.
- ~~Drift de schema em `agent_configs`~~ — todas as colunas suspeitas existem na prod.

**Segurança/Código (C4):**
- ~~`stevo-handler.ts`, `daily-briefing-prompt.ts` órfãos~~ — são **dynamic imports** (`await import(...)`). Não são dead code.
- ~~`.or()` em followup.ts é IDOR cross-tenant~~ — não é; `.eq(rep_id).eq(location_id)` em AND antes. Rebaixado a P2.
- ~~Migrations RLS (00007/00028) são drift~~ — corretas, só dormentes porque o runtime nunca usa a anon key (ver Fato Transversal).
- ~~`loader/route.ts` `ACAO:*` / CORS `*`~~ — JS público sem credenciais. Benigno.

**Histórico (PLANO §0):** os 3 "bugs" reportados antes desta rodada (cron "1×/dia" genérico, persona "não usada", override "ignora tudo") já tinham sido derrubados como falsos-positivos.

---

## 7. O que está OK / sólido (verificado e passou)

**Fato transversal a registrar (C4):** RLS está **dormente** — `createServerClient` e `createAdminClient` usam ambos o `SUPABASE_SERVICE_ROLE_KEY`; `createBrowserClient` (anon) nunca é chamado. Migrations RLS (00007/00028) são letra morta no runtime. **Todo isolamento multi-tenant é aplicacional** (`.eq(location_id)`). Não é um bug por si, mas amplifica qualquer rota que esqueça o `.eq` (daí a gravidade dos P0/IDORs). Vale uma decisão de arquitetura com o Pedro.

**Segurança (boa higiene — não mexer):**
- Webhook GHL inbound: HMAC SHA-256 + `timingSafeEqual` + fail-closed opcional (`WEBHOOK_REQUIRE_SIGNATURE`).
- JWT SparkBot Web + JWKS GHL: RS256 verify real contra JWKS Firebase, checa `iss` + `user_id`/`company_id` match (corrige o exploit do review 04-29).
- cron-auth: constante-time + rejeita secret vazado explicitamente.
- SSRF KB: `isSafeHttpUrl` bloqueia localhost/privados/link-local/CGNAT/IPv6 ULA + `redirect:"error"` + timeout. GHLClient não é SSRF (base constante).
- IDOR scoping correto na maioria das rotas (agents/[agentId], media, feedback, settings, billing, conversations/resume, agents/test, entitlements, módulos).
- Upload limits: KB 15 MB, media 25 MB + MIME allowlist, transcribe 25 MB.
- Secrets: nenhum hardcoded; `.env.local` gitignored; logs não imprimem token/key.
- **Schema drift: NENHUM** nas colunas suspeitas (00085 fechou o gap do `ai_paused_at`).

**Billing (C3):** markup 10% exato em rows reais; cached-read (cache READ) cobrado certo; cap atinge e bloqueia **mas o bot continua** (UX preservada); internal-team skip funciona (3 camadas de detecção); idempotência GHL (`eventId = usage_record.id`, 1 record/charge); UI de Faturamento bate com `usage_records`; guards do `sparkbot-proactive` presentes (advisory lock 8675309 + WHERE EXISTS triplo).

**Funcionalidades de Agente (C2):** round-trip OK (UI↔zod↔DB↔prompt) para personality, 4 tons, objective, data_fields, targeting, channels, follow-up, working_hours, post_booking, KB doc + carrier RAG, quiet_hours, thresholds, confirmation_mode; tools `book/reschedule/update_field/add_tag/remove_tag/move_pipeline/send_message` ligadas; lead agents corretamente SEM confirmation/test-mode gate; entitlement (`decideEntitlement`, flag OFF=log-first) e wire em `POST /api/agents`/`builder/commit`; wizard→commit nasce `inactive` com **rollback** se a config falhar; motor unificado (`assembler.ts`) com paridade aos builders legados. **Latente (não é bug hoje):** `AGENT_MOTOR_UNIFIED` ON + `custom_agent` → throw no assembler (`queue-processor.ts:604` não passa `moduleKeys`); flag está OFF por default — CLAUDE.md já alerta pra não ligar sem validar.

**Front-end (C1):** base sólida — design system maduro (`hub.css`), tokens consistentes, `:focus-visible` global com ring, `--ink-4` escurecido pra passar 4.5:1, switches com `role="switch"`+aria+teclado, modais do hub (`test-chat`, `access-table`) com focus-trap+Esc+restore exemplares, escopo multi-tenant defensivo (`loadHubAgentDetail` filtra `location_id`), clamp de números no save, **ZERO violação user-facing de "GHL"/"GoHighLevel"**, breakpoints responsivos pensados (inclusive iframe estreito do Spark Leads), `prefers-reduced-motion` respeitado, estados vazios bem cobertos. **Zero P0 no front-end.**
