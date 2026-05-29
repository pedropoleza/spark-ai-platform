# CLAUDE.md — instruções pra Claude Code/Cursor sessions

> **Toda nova sessão Claude começa lendo este arquivo.** Idioma do projeto é PT-BR.

---

## Quem é o user

Pedro Poleza — agency owner BR, dono da Brazillionaires (sub-agência da Five Rings Financial / National Life). Programa em PT, comentários em PT, commits em PT. Operação principal nos EUA mas atende mercado brasileiro.

Stack mental: prefere **velocidade > rigor inicial**, mas reage rápido quando reporta bug em prod. Solo dev — bus factor = 1. Testa em prod com a própria conta.

---

## Convenções

### Commits
- **Conventional Commits em PT-BR**: `fix(sparkbot): notes não sendo persistidos no import`, `feat(carrier-kb): wave 3 — threshold 0.4`, `chore: trigger redeploy`
- Body explica **por que**, não o quê. Cita arquivos quando útil.
- Co-author footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Nunca pular hooks** (`--no-verify`) sem permissão explícita.

### Comentários inline
- **PT-BR**, explicam decisão (não o óbvio).
- Padrão de **decision codes**: `H1 (review 2026-04-28)`, `C4 fix:`, `P0 (review 2026-04-28)`, `NB-6 do agent de validação 2026-05-02`. Veja `docs/DECISIONS.md` pro mapping completo.
- Quando fix de bug observado em prod, anota data: `// Fix bug observado em prod 2026-05-03: ...`.

### Naming user-facing: Spark Leads, NUNCA "GHL" / "GoHighLevel"
**Regra inviolável** (Pedro reiterou 2026-05-04): em qualquer string que rep ou admin VEJA — UI labels, error messages, system prompts, tool descriptions, terms of service — usa "**Spark Leads**" (ou "Spark" curto) pra se referir ao CRM. NUNCA "GHL" nem "GoHighLevel".
- ✅ OK manter "GHL" em: comentários técnicos, var/type/function names (`GHLClient`, `ghl_user_id`, `ghl_users`), env var names (`GHL_API_BASE`), `console.log/warn/error` (dev-only), file paths (`@/lib/ghl/*`).
- ❌ NÃO em: tool descriptions (LLM repassa), system prompts, error msgs que rep vê, UI labels, termos de uso, badges.

Quando criar nova string user-facing, escolhe um:
- "Spark Leads" — nome completo do CRM
- "Spark" — curto, dentro de contextos onde já é claro
- "no Spark Leads" / "do Spark Leads" — referindo dados/operação no CRM

### Estrutura
- Path aliases `@/...` em todos os imports — zero `../../../`.
- Tipos compartilhados em `src/types/{ai,agent,ghl,account-assistant}.ts`.
- Tools do Sparkbot: 1 arquivo por categoria, exporta `{def, handler}[]`. Registry em `tools/index.ts`.

---

## Padrões críticos (não viole sem discussão)

### Sparkbot — Confirmation gate (H8)
- Tools com `risk: "medium" | "high"` exigem `confirmed_by_rep: true` no input.
- `tools/index.ts` (`withConfirmationParam`) injeta o param no schema dinamicamente, baseado em `agent_configs.confirmation_mode` (default `medium_and_high`).
- `executeTool()` enforça: bloqueia execution se não vier o flag.
- LLM é instruído a perguntar "Confirma?" → esperar "sim/ok/pode/👍" → re-chamar tool com flag.

### Sparkbot — Test mode gate
- `ctx.testSessionId !== null` + `risk !== "safe"` → tool retorna mock JSON `{simulated: true}`.
- Read-only tools (`search_*`, `get_*`, `list_*`, `analyze_tabular_data`) sempre executam pra preservar análises.
- **NÃO bypass nunca.** Test em prod já causou estrago no passado.

### Sparkbot — Idempotency (7 camadas)
Em ordem de precedência:
1. **In-memory mutex** (`inFlightMessages` em webhook-handler.ts) — sub-segundo intra-lambda.
2. **SELECT por `ghl_message_id`** — retry sequencial.
3. **`sparkbot_dedup_locks`** UNIQUE PK — race <100ms multi-provider.
4. **CONTENT-MATCH** (15s window) — texto idêntico do mesmo rep.
5. **TIMING-MATCH** (5s window) — qualquer kind, multi-provider audio/imagem com bodies diferentes.
6. **UNIQUE constraint** em `sparkbot_messages.ghl_message_id` — captura via `error.code === "23505"`.
7. **rep_identity 23505 capture** em `identifyRep` (Track 1 C3 fix 2026-05-05) — 2 webhooks Stevo+GHL <100ms ambos chegam ao INSERT, segundo bate UNIQUE phone constraint, código captura `code === "23505"` e re-fetch rep criado pelo competidor.

**Placeholder rejection** (`Audio Message.`, `Image`, etc): só rejeita se NÃO tem attachment processável (Stevo manda placeholder + audio_url juntos).

### Sparkbot — Silence tracking
- Counter em `rep_identities.consecutive_proactive_without_reply`.
- Threshold: 0/1=normal, 2=warning soft, 3=warning hard, ≥4=pause.
- **Reset em qualquer inbound** (web ou WhatsApp). Implementação em `silence-gate.ts`.
- Aplica só a proativos (modo `real`), nunca a respostas a inbound do rep.

### Sparkbot — LLM fallback chain
- Primary: Claude Sonnet 4.6
- Secondary: Claude Haiku 4.5 (se primary falhar)
- Tertiary: GPT-4.1 OpenAI (se ambos Claude falharem)
- `STRICT_CLAUDE_ONLY=1` desativa OpenAI fallback (~85% piora compliance no fallback OpenAI per stress test).
- Erro propaga via `result.primary_error` / `result.secondary_error` pra debug.

### Phone normalization (BR-aware)
- `normalizePhone(raw, defaultCountry)`: 10/11 dígitos sem `+` → +55 se BR, +1 se US.
- Country detectado via `inferCountryFromTimezone(location.timezone)`.
- BUG histórico: antes assumia US sempre, quebrava import de listas BR.

### Outbound channel routing
- `pickOutboundChannel()` lê `ASSISTANT_OUTBOUND_CHANNEL` env (default SMS).
- `SMS` agora (Stevo/Evolution roteia pro WhatsApp).
- `WhatsApp` quando API for liberada (Meta review).
- `auto` (futuro) — checa janela 24h + fallback SMS.

### Migrations
- **Sempre criar arquivo em `supabase/migrations/`** mesmo aplicando via MCP em prod.
- Fresh staging branches dependem disso.
- Header com bloco comentado explicando motivação.

### História do conversation
- Sparkbot: lê `sparkbot_messages` (last 30 turns), filtra `content !== ""` (Claude rejeita user msg vazio com 400).
- Sales/Recruitment: lê `messages` table com `compressHistory` (gpt-4.1-nano summarizer) acima de 25 turns.
- **Nunca persistir `content=""`**: usa `"[mensagem vazia]"` como placeholder.

### Webhook GHL
- Multi-tenant: `isSparkbotHub(locationId)` query a `agents` table com cache 5min em memória.
- Hub é qualquer location com agent ativo `type='account_assistant'`.
- **Não usar mais env var `ASSISTANT_HUB_LOCATION_ID` pra detectar hub** — só pra fallback de cron/billing.

### SparkBot Onboarding (Pedro 2026-05-04)
- Nome user-facing: **SparkBot** (camelCase). Variable/type names podem manter `sparkbot_*` no DB e código.
- Ao aceitar termos, bot lê `location.timezone` do GHL e auto-confirma fuso. NUNCA pergunta fuso pro rep upfront.
- `runOnboardingAfterTerms` em processor.ts encadeia: terms → confirm fuso silencioso → guia rápido com 4 exemplos.
- Helper `formatTimezoneHumanFriendly` mapeia IANA → "Cidade (Abrev)" (ex: "Florida (EDT)").
- Agente pode mudar fuso depois ("to em SP agora") via tool `confirm_rep_timezone`.

### SparkBot Billing (Pedro 2026-05-04)
- **Markup**: 10% (em `pricing.ts:MARKUP_PERCENTAGE`). Foco em adoção, não margem.
- **Hard cap mensal**: default $100/sub-account em `agent_configs.monthly_spend_cap_usd`. NULL = sem cap.
- **Internal team**: `is_internal=true` em rep_identities. Detecção em camadas: env `INTERNAL_TEAM_PHONES` → role `agency`/`agency_owner` → heurística "5+ ghl_users". Skipa charge mas mantém audit.
- **Cap atingido**: `cap_blocked=true` em usage_records, charge skipado, bot CONTINUA respondendo (UX preservada).
- **Schema usage_records**: tem `cached_tokens, cache_creation_tokens, audio_seconds, audio_model, image_count, claim_token, claimed_at, charged_at` (migration 00056 fixou drift). Sem essas cols, Whisper/Vision/cache billing fica silenciosamente quebrado.

### SparkBot Termos (Pedro 2026-05-05)
- **Aceite** persiste `terms_accepted_at` via `acceptTerms()`.
- **Rejeição** persiste `terms_rejected_at` via `rejectTerms()` (fix Track 1 C1 — antes era loop infinito reenviando termos).
- **Reset**: admin precisa `UPDATE rep_identities SET terms_rejected_at = NULL WHERE id = X` pra rep poder retomar.
- **parseTermsResponse**: regex anti-falso-positivo (NEGATION_PATTERN check ANTES de ACCEPT, normaliza acentos). Antes "não tá ok pra mim" virava ACCEPT — LGPD risk.

### Filter Engine (H27, Pedro 2026-05-15)
Sistema unificado de filtros em `src/lib/account-assistant/filter-engine/`. Toda busca/lista de contatos/opps com critério múltiplo passa por ele. DSL JSON (FEL) com AND/OR/NOT, aliases auto (stageName→ID), customField por slug ou UUID, paginação ilimitada (cap defensivo 5000), cache 10min, audit em `filter_executions`. Tools expostas ao LLM: `get_contacts_filtered`, `get_opportunities_filtered`, `count_filtered`, `describe_filter_capabilities`. Legacy (`search_contacts`, `list_opportunities`, `list_birthdays_today`) viram wrappers retrocompat. Pra capability matrix das ops × fields, ver `filter-engine/capabilities.ts`. Plano: `_planning/filter-engine-and-bulk-v2.md`.

### Bulk Messages V2 (H28, Pedro 2026-05-15)
Em `tools/bulk-messages-v2.ts`. Multi-segment (N filters × N templates num job único, dedup por contact_id), disclaimers tier obrigatórios (`computeDisclaimers`: SEMPRE pergunta quente/fria; risk em >50 quentes ou >10 frios), interpolação rica (`{first_name}`, `{tags[0]}`, `{custom.slug}`, `{opportunity.stage_name}`), snapshot do texto final em `bulk_message_recipients.personalized_message`. Bulk V1 segue funcional. Resolve caso Gustavo 2026-05-15 (mensagem diferente por stage).

### Agendamento V2 (H34, Pedro 2026-05-22)
Fluxo de agendamento "resolve tudo → 1 confirm (override-aware) → pronto". Em `tools/calendar.ts` + `prompt-builder.ts` (seção "# AGENDAR REUNIÃO"). Regras:
- **Override self-aware (D1, afrouxa H26)**: `buildOverridePayload` libera `ignoreFreeSlotValidation`/`ignoreDateRange` quando o appointment é do PRÓPRIO rep (assignee self/`me`/`eu`/não-setado/round-robin OU `== getRepGhlUserId(ctx)`). Agenda de OUTRO user = admin-only. `toNotify=false` (client-facing) = admin-only SEMPRE. Teste: `scripts/test-override-gate.ts`.
- **Preferência de calendário (D2)**: `profile.preferences.scheduling.{default_calendar_id, default_calendar_name, default_duration_min}`. Resolução nome-dito > pref salva > único calendário (`resolveCalendarChoice`, exportado+testado). `list_calendars` retorna `resolved_calendar_id`+`resolution` ('default_pref'/'only_calendar'/'ambiguous'). Bot aprende no 1º uso via tool `set_scheduling_pref`; surfaceado na memória do prompt (`buildMemorySection`). Setting na UI: engrenagem no painel web (`embed/sparkbot/page.tsx`) → `GET/POST /api/sparkbot/scheduling-prefs` (JWT per-rep).
- **Prompt**: resolve contato+calendário+assignee(=self)+slot ANTES; 1 `present_options` no fim; conflito na própria agenda → "Confirmar mesmo assim ✅ / Editar ✏️" embutido (1 passo, não 2); sub-fluxo Editar (Horário/Dia/Pessoa/Calendário). Plano: `_planning/agendamento-v2/PLANO.md`.

### Plataforma Modular de Agentes (H35, Pedro 2026-05-24) — EM CONSTRUÇÃO
Reestruturação grande: SparkBot incluso/grátis; venda/recrut/custom = upsell pago montado de **módulos** sobre **motor único** (o do SparkBot). Plano: `_planning/plataforma-modular/PLANO.md`.
- **Eixo audiência**: `agents.audience` = `rep` (SparkBot, fala com o user) × `lead` (venda/recrut/custom, fala com leads; cada um na sua sub-account/canal). Provisioning da sub-account+canal é manual (agência); cliente só compõe módulos.
- **Schema (00075, aditivo)**: `agent_templates`, `agent_modules` (catálogo; `prompt_fragment` NULL = registry TS provê), `agent_module_instances` (composição por agente + `prompt_override`), `agent_entitlements` (capacidade paga por location). Colunas novas em `agents`: `audience`, `template_key`, `expires_at` (agente temporário→pausa).
- **Entitlement**: `checkAgentEntitlement`/`decideEntitlement` em `lib/agent-platform/entitlements.ts`. SparkBot (account_assistant) sempre liberado; lead-facing exige entitlement ativo OU admin. **Flag `AGENT_ENTITLEMENTS_ENFORCED` (default OFF = log-first)** — só bloqueia quando ligada. Liberação manual: `scripts/grant-entitlement.ts`. Wire em `POST /api/agents`.
- **Motor unificado (Fase 1)**: `lib/agent-platform/assembler.ts` (`assembleSystemPrompt`) é o ponto único de montagem; pro template `sparkbot` DELEGA pro `buildSparkbotSystemPrompt` (paridade). Flag `AGENT_MOTOR_UNIFIED` (default OFF) escolhe o caminho no processor — com OFF segue o builder legado; output idêntico nos dois. Guard rail: `scripts/test-motor-parity.ts` (assembler === legado, 7/7).
- **Módulos decompostos (Fase 1)**: `lib/agent-platform/modules/{behavior,scheduling,channel,knowledge}.ts` + `registry.ts` (índice key×audience). São as seções CONTÍGUAS do prompt do SparkBot movidas pra módulos (rep-facing) — o builder faz `...spread` (fonte única, zero fork, parity-guarded). As seções restantes ou são NÃO-contíguas (extrair exigiria REORDENAR o prompt = risco de comportamento, precisa eval supervisionado) ou COMPUTADAS (`buildTonesSection`/`buildMemorySection`/conversational/guided — já são funções). Não force mais extração verbatim sem alinhar com o Pedro.
- **Lead-facing no motor (Fase 2 base)**: `assembleSystemPrompt` trata `sales`/`recruitment` delegando pro `buildSystemPrompt` do `sales-prompt-builder.ts` (paridade — `test-sales-parity.ts` 5/5). `queue-processor.ts` roteia pelo assembler quando `AGENT_MOTOR_UNIFIED` ON (default OFF = legado idêntico). `templateKeyForAgentType()` mapeia agent.type→template. Módulo de catálogo `bulk` adicionado (migration 00076). O sales builder JÁ é modular por dentro (section functions) → decompor lead-facing é mapear, não mover texto.
- **Status**: Fase 0 + Fase 1 (motor/4 módulos/registry/resolver) + Fase 2 base (lead-facing seam) PRONTAS e deployadas, **zero mudança de comportamento** (flags OFF). Próximo (precisa do Pedro): compor prompt A PARTIR do registry (habilita custom agents) + multicanal (IG DM) + wizard de onboarding (Fase 3). **NÃO** ligar `AGENT_ENTITLEMENTS_ENFORCED` (até UI de liberação) nem `AGENT_MOTOR_UNIFIED` em prod sem validar 1 conversa real primeiro.

### Ativação de agente lead-facing (F27, Pedro 2026-05-28)
Regras de targeting enforced em `src/lib/queue/targeting.ts` (`checkContactMatchesTargeting`). Antes do F27, `agent_configs.targeting_rules` era salvo mas IGNORADO no runtime — agente respondia a todos os contatos da location. Agora:
- **Gate inserido no `queue-processor.ts`** após `ai_paused_at`, antes do processamento de áudio. Skip + audit em `execution_log.action_type='targeting_skip'`.
- **3 tipos de regra** (AND lógico): `tag` (match exato), `custom_field` (valor exato OU qualquer-valor se vazio), `pipeline_stage` (contato tem opp na pipeline+stage).
- **Fail-OPEN**: erro de fetch GHL = assume match (pior cenário responder pra 1 contato que não devia, vs. agente mudo silencioso).
- **UI**: detail-view tem Cat própria "Ativação" no rail (`CatActivation`, ícone Crosshair, grupo Comportamento). Wizard custom step `intake` renomeado pra "Quando esse agente deve atender?" com chip novo "Quando entra na etapa do funil" (modo `stage`).
- **F27.D pendente**: trigger reativo "lead entrou em estágio Y" → dispara agente proativo. Requer setup webhook GHL externo + schema `activation_triggers` + listener PRE-LLM. Diferente do `reaction-engine.ts` (POST-LLM).
- **SparkBot rep-facing não usa**: `LEAD_ONLY` inclui `activation`; targeting só faz sentido pra lead-facing.

### SparkBot Cron Guards (Pedro 2026-05-05)
- pg_cron `sparkbot-proactive` agendado a cada 30s com:
  - `pg_try_advisory_xact_lock(8675309)` — anti double-execution sob backlog
  - `WHERE EXISTS` triplo (assistant_scheduled_tasks + assistant_proactive_rules enabled + bulk_message_recipients pending) — evita auto-DDoS de calls vazias
- **Apenas `post_meeting` reactive rule é IMPLEMENTADO** — outros 3 (Lead esfriando, Tarefa atrasada, Task vencendo) eram stub mas estavam `enabled=true` em prod. Disabled em 2026-05-05 até implementação real (admin sees no UI). Activación: implementar polling em `processReactivePolling` + reativar enabled.

---

## Anti-patterns conhecidos (não cair de novo)

- ❌ **Try/catch em supabase-js insert**: NÃO captura erros, devolve `{error}`. Use `if (result.error?.code === "23505")`.
- ❌ **Hardcoded contact_id no LLM**: bot alucinava IDs de turns antigos. Sistema prompt agora exige re-search antes de cada tool com contact_id.
- ❌ **Persistir `content=""`**: Claude rejeita histórico com user msg vazio (400 invalid_request). Filtra ao carregar + "[mensagem vazia]" no insert.
- ❌ **Single hub via env var**: `ASSISTANT_HUB_LOCATION_ID` legacy. Multi-hub via DB query.
- ❌ **In-memory state cross-lambda**: `inFlightMessages` Map só funciona intra-lambda. Use UNIQUE constraint pra cross-lambda.
- ❌ **`extractAudioUrl` sem `extractMediaAttachments`**: Stevo manda audio_url em `attachments` array, não em `mediaUrl` direto. Cobrir ambos.
- ❌ **Esquecer Conventional Commits**: nunca `git commit -m "fix"`. Sempre `fix(<escopo>):`.
- ❌ **Refazer fluxo sem gate de paridade vs legado** (Pedro 2026-05-28): quando refazermos qualquer fluxo (wizard de criação, página de config, dashboard, embed), **NÃO marcar a task como done sem antes:**
  1. Listar literalmente os CAMPOS/AÇÕES do flow anterior (legado ou equivalente — `detail-view` se for criação, `/dashboard/*` se for /hub, etc).
  2. Listar os do flow novo.
  3. Marcar cada delta como (a) **decisão de design intencional documentada**, (b) **bug a resolver agora**, ou (c) **follow-up rastreado em `_planning/`**.

  Sem esse cruzamento, regressões silenciosas escapam dos guard-rails automáticos (tsc/build/parity-tests). **Caso histórico:** wizard novo (PM-F3.2/RV-W) perdeu `targeting` (pipeline_stage + custom_field) que existia no detail-view — só ficou tag simples. Descoberto em prod por reclamação do Pedro, não pelas revisões. Fix em `0d43bf8` → `adb42e8`. Auditoria subsequente (2026-05-28) achou +24 gaps similares — plano em `_planning/_gaps-prospeccao-2026-05-28/PLANO.md`.

### Cutover PM-F3.I (Pedro 2026-05-28): `/dashboard` deprecated

- **`/hub` é o painel canônico**. `/dashboard/*` virou redirect 308 pra `/hub/*` via `next.config.mjs` `redirects()`.
- Mapping: `/dashboard` → `/hub`, `/dashboard/settings` → `/hub/settings`, `/dashboard/billing` → `/hub/billing`, `/dashboard/activity` → `/hub/messages`.
- Arquivos de `/dashboard/*` ficam por enquanto em `src/app/dashboard/*` (fallback emergencial — rollback = remover redirects + 1 deploy).
- **Não adicione mais features no `/dashboard`.** Toda UI nova entra em `src/app/hub/*`.
- Hypercare 48h: monitorar Sentry + admin_signals + reclamações de rep. Issues de cutover marcadas com `Fix bug cutover 2026-05-28:` no comment.

---

## Quando inserir comments / decision codes

- Bug observado em prod e fixado → comment `Fix bug observado em prod <data>: <causa> → <fix>`
- Decisão arquitetural não-óbvia → comment + entrada em `docs/DECISIONS.md` com código (próximo H/C/NB disponível)
- Stress test descobriu issue → `<código> (review <data>):` no comment

---

## Onde achar contexto adicional

| Pergunta | Onde olhar |
|----------|-----------|
| Schema do DB | `supabase/migrations/00043_*.sql` (último) + grep nos anteriores |
| Decisão histórica (H8, C4...) | `docs/DECISIONS.md` |
| Como rollback | `docs/RUNBOOK.md` |
| Stress test results | `_planning/_review-2026-04-2[89]/stress-test/` |
| Tool catalog completo | `_planning/account-assistant-v2.md` |
| Endpoints GHL usados | `_planning/ghl-api-reference.md` |
| Filter Engine (H27) | `_planning/filter-engine-and-bulk-v2.md` + `src/lib/account-assistant/filter-engine/` |
| Capability matrix GHL × FEL | `src/lib/account-assistant/filter-engine/capabilities.ts` |
| RAG/pgvector setup | `_planning/nlg-kb-implementation-plan.md` |
| Estado de bugs fixados | `_planning/_review-*/00-RELATORIO-EXECUTIVO.md` |
