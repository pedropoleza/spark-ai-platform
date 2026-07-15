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
- `tools/index.ts` (`withConfirmationParam`) injeta o param no schema dinamicamente, baseado em `agent_configs.confirmation_mode` (default `high_only` desde migration `00069_confirmation_mode_default_high_only.sql` / decisão D3, 2026-05-20).
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
- **Post-mortem caso Manuela (H42, 2026-06-23)** — admin Flórida montando agenda de outra pessoa: 4 lições no agendamento. (1) **Assignee→dono**: o gate `repIsAdmin` (D1) libera o override mas NÃO basta — ao criar em calendário que o rep ADMIN não participa, o `create_appointment` agora resolve o assignee pro DONO do calendário (1º team member via `getCalendarDetails`), senão GHL 422 "user id not part of calendar team" (o bot dizia "você não faz parte do time" pra um admin — bug). Prompt em `scheduling.ts` ensina a regra + mapeia o erro + anti-bounce. (2) **Confirmação à prova de erro**: confirm de agendamento DEVE mostrar dia-da-semana+data+hora COM fuso explícito e validar weekday↔data (o bot computou "terça 01/07" = quarta). (3) **Nome corrigível**: `set_rep_preferred_name` → `profile.preferences.preferred_name` (mesmo padrão do timezone; bot honra "sou a Manuela, não Manoela"). (4) **Criação em massa**: `create_appointments_batch` (1 tool call cria N reuniões num loop server-side, budget 40s, cap 30, devolve parcial) — NUNCA chamar `create_appointment` N× em sequência (estoura a lambda; foi o timeout de 9h). Testes: `scripts/test-appointments-batch.ts` (11/11) + `test-override-gate.ts` (25/25).
- **Trava weekday↔data (H50, 2026-07-15, caso Caua) — NO AR**: a lição (2) do H42 era só PROMPT e o LLM voltou a furar — o bot marcava no DIA ERRADO. O rep pedia um dia NOMEADO ("segunda-feira 20h"), o LLM calculava a data por aritmética e errava ("segunda"→14/07 que é terça; "quarta"→16/07 que é quinta), e como `create_appointment` recebe `start_time` como ISO 8601 que o PRÓPRIO LLM computa (só valida formato), o ISO errado ia cru pro GHL → booking no dia errado (pior no caminho de override, que Caua usa sempre). Fix DETERMINÍSTICO (módulo novo `weekday-guard.ts`, puro/testável, Intl DST-correct): as 4 tools de horário (`create_appointment`/`create_appointments_batch` [por item]/`block_calendar_slot`/`update_appointment`) ganham param `expected_weekday` (o dia que o REP nomeou); o servidor computa o weekday REAL do `start_time` no fuso do rep e, se não bate, REJEITA (`retryable`) com a correção exata (weekday real da data + próxima data daquele dia) pro LLM re-chamar. Além disso devolve `booked_label` determinístico ("quinta-feira, 16/07/2026 às 20:00") — o bot narra o "Marcado ✅" a PARTIR dele, nunca recalcula (foi o que gerou "Segunda 14/07"). Prompt em `scheduling.ts` (regras 1b/1c) ensina a passar `expected_weekday` sempre que o rep nomear um dia + narrar pelo `booked_label`. Fuso via `ctx.rep.timezone || "America/New_York"` (mesmo padrão do resto do agendamento). Additive/reversível: sem `expected_weekday` = comportamento de antes. Teste `scripts/test-weekday-guard.ts` (28/28, reproduz o bug + borda de fuso + DST).

### Humanização do SparkBot (H43, Pedro 2026-06-24) — Onda 1 no ar
Estudo de uso de 7 dias (2015 msgs/28 reps) em `_planning/sparkbot-humanizacao-2026-06/` (ESTUDO+PLANO, 39 fixes em 5 ondas). **Onda 1 (naturalidade + confiança) DEPLOYADA:** menos cerimônia (silence-warning vira tom de colega; post_meeting varia; mata "quer follow-up?" automático; confirma delta; detector de rajada determinístico em `turn-context.ts`); confiança (`commit_draft` no coherence-gate; repeat-guard lookback 5; force-slot por-rep via `auto_force_slot`; termos não atropela pedido; herda contato pós-call). Detalhe em DECISIONS H43. **Pendente 👤:** ligar `TASK_ORCHESTRATOR_ENABLED` (valida 1 conversa + env Vercel). **Ondas 3-5 não iniciadas** (proatividade: `get_account_pulse`/números da conta, ligar as ~12 scheduled/reactive rules seedadas mas desligadas, templates de mensagem nomeados, inbox triage, extração de apólice). Achado-chave pra retomar: só 2 de ~14 gatilhos proativos rodam hoje.

### Resolução de contato do SparkBot (H45, Pedro 2026-06-26) — no ar
Bug sistêmico "não achei, me passa o telefone" (45/sem, 14 reps, tudo Sonnet). 2 defeitos: (A) o `contact_id` do proativo morria em 3 hops (não chegava ao turno → bot re-buscava do zero); (B) busca exata `GET /contacts/?query=` sem fuzzy/acento/score → "Fernanda Lira" voltava 0 (typo no cadastro: "fernanada"). **11 fixes (F1-F11), módulo novo `account-assistant/contact-resolver/`:** herança de "contato em foco" (proativo F1/F8 grava `contact_id` na metadata → processor injeta bloco "CONTATO EM CONTEXTO" no runtime context, herdado como PISTA que se re-valida via `get_contact` — NUNCA id cego) + `resolveContact()` fuzzy (escada GET-variantes nome completo→primeiro→último + telefone E.164/sufixo, score token-set/Dice + deburr NFD) com `search_contacts` devolvendo `confidence` (high/needs_confirm/ambiguous/low) pro bot decidir (auto-confirma/pergunta/lista/não-achei). **Anti-alucinação preservada:** chave `contact_id` (contato discutido) ≠ `ghl_contact_id` (card do próprio rep); re-valida + confirma nome inline. Detalhe em DECISIONS H45. Stress 36/36 contra CRM real. **Validar pós-deploy 👤:** ver se os "não achei" caem (query de `sparkbot_messages`). **Follow-up (PLANO):** F10 race no profile JSONB, schedule_reminder capturar contact_id.

### Redução de custo do SparkBot (H44, Pedro 2026-06-24) — Fase 1 no ar
Estudo+plano em `_planning/sparkbot-cost-reduction-2026-06/` (ESTUDO/PLANO/BASELINE/baseline-snapshot; 17 fixes F1-F17 em 5 fases). Achado-raiz: o custo do SparkBot (81% da conta, ~$280/mês, 96% INPUT) é **cache mal-aproveitado, não prompt grande** — o maior item é cache-WRITE de 37.9M tok/mês (~$142) = o system de ~22K re-escrito quase todo turno. **Fase 1 (4 cache-fixes "reposicionar, não reescrever") IMPLEMENTADA:** F1 move os 5 blocos voláteis (`conversationalLayer`) do system pro runtime context (user message) → system byte-estável por-conversa; F2 dispatcher proativo com system puro (suffix MODO PROATIVO+JSON vão pra user message; mata o `cache=0` do Resumo matinal); F3 3º cache breakpoint no penúltimo message; F4 TTL 1h no prefixo **só no inbound** (`cacheTtl` threaded; proativo fica 5m). Detalhe em DECISIONS H44. tsc/parity 7-5-14/build verdes + review adversarial (4 frentes). **Validar pós-deploy 👤:** re-rodar as 2 queries de `baseline-snapshot.md` (cache_write deve despencar). **Fases 2-4 não iniciadas:** prefixo enxuto (tool-tiers/seções condicionais) · compressão+memória · 3 tiers por agente (Haiku/Sonnet/Opus) + roteamento.

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

### Lead Awareness + Handoff Inteligente (F37, Pedro 2026-05-29)
Agentes lead-facing (sales/recruitment/custom) podem:
1. **Carregar histórico do contato** do Spark Leads antes de responder — msgs anteriores, notas, opp stage, tags. Bot entende em que ponto a conversa parou (caso humano já tenha conversado). Implementado em `src/lib/queue/lead-history.ts` (cache 5min, fail-soft).
2. **Decidir não responder** baseado em heurísticas (`src/lib/queue/should-respond.ts`):
   - Humano respondeu nas últimas N min → SKIP (não atropela)
   - Lead pediu "humano/atendente/falar com alguém" → SKIP + NOTIFY
   - Opp em status fechado (won/lost) → SKIP silently
3. **Notificar rep humano via SparkBot** quando decide SKIP (`src/lib/queue/handoff-notify.ts`). Reusa `deliverProactiveMessage`. Idempotência: cooldown 4h por (contact, reason). Resolve rep via `contact.assignedTo` → fallback rep_identities da location não-internal.

Toggles em `agent_configs.lead_history_config` e `handoff_policy` JSONB. **Defaults OFF** — opt-in por agente via UI Cat "Memória do lead" (ícone BookOpen, grupo Comportamento). Migration `00096_lead_awareness_handoff.sql` adiciona colunas + tabela `handoff_notifications`. Plano: `_planning/F37-lead-awareness/PLAN.md`.

Wire em `queue-processor.ts` após targeting check, antes do prompt build. Prompt section `buildLeadHistorySection` em `sales-prompt-builder.ts` injeta resumo do histórico antes das instruções do admin. Audit em `execution_log` action_types `lead_history_loaded`, `should_respond_skip`, `handoff_notification`.

Tests: `scripts/test-lead-awareness.ts` (12 cenários cobrindo decisões should-respond, defaults, edge cases).

### Campanhas em Grupo de WhatsApp (H40, Pedro 2026-06-18) — flag OFF
SparkBot posta em GRUPOS de WhatsApp via API Stevo (caso Matheus "2 posts/dia 7:30"). **Tudo atrás de `GROUP_CAMPAIGNS_ENABLED` (default OFF / log-first)** — gateia o REGISTRO das tools em `tools/index.ts`. Reusa o motor Bulk V2 (NÃO criou tabelas novas). Plano: `_planning/group-campaigns-whatsapp/PLANO.md`; copy aprovada: `COPY.md`.

- **Modelo (migrations 00113+00114)**: 1 campanha = 1 `bulk_message_jobs` com `target_type='groups'` + N recipients (1 por grupo; `contact_id`=JID satisfaz `UNIQUE(job_id,contact_id)`; cols novas `bulk_message_recipients.{target_jid,group_name}`). `target_type` é **ortogonal a `delivery_channel`** — grupo segue `'whatsapp_web_sms'` (rota Stevo), NÃO um canal novo. `recurring_campaigns` += `target_type`+`group_targets` jsonb. `stevo_instances` += `kind('shared'|'dedicated')`. `rep_identities` += `group_campaign_terms_{accepted,rejected,pending}_at`. A 00114 relaxou `recurring_campaigns.agent_id` e `outreach_runs.agent_id` pra NULL (grupo não tem agente lead-facing).
- **Envio**: `bulk-message-runner.ts` intercepta no TOPO de `sendToContact` → `if target_type==='groups' return sendToGroup(...)` (resolve instância dedicada → `sendGroupText` JID via `webhook/stevo-groups.ts`, fora do GHL). Contrato `{ok;error?}` idêntico → loop/counters/claim/quiet-hours intactos. `normalizeStevoNumber` (stevo-send.ts) agora PRESERVA JID `@g.us` (antes destruía). Opt-out e cooldown SKIPados pra grupo.
- **Variação anti-ban**: pacing/jitter do runner espaça os grupos de graça (piso `GROUP_INTERVAL_FLOOR_SECONDS=180`); texto varia por grupo via `variation_mode='light'` (variator existente) OU variations explícitas (round-robin em `personalized_message`). Constantes em `group-campaigns/config.ts`.
- **Recorrente (Matheus)**: `recurring-runner.ts` ganhou branch `target_type==='groups'` ANTES da resolução por tag — cada ocorrência = job filho NOVO → o mesmo grupo reaparece dia após dia sem colidir com a UNIQUE. quiet_hours NÃO pula grupo (rep escolheu o horário). **Precisa `RECURRING_CAMPAIGNS_ENABLED=1` também.**
- **5 gates**: (1) flag de registro; (2) **instância DEDICADA** (`getStevoInstanceForRep` exige `kind='dedicated'`; recusa a compartilhada do SparkBot — ban num grupo derrubaria o DM de TODOS os reps; reasons `no_instance`/`shared_only`/`misconfigured`); (3) **Terms & Segurança PARTE 2** (`terms.ts` `GROUP_CAMPAIGN_TERMS_*` + gate determinístico 1b no `processor.ts` reusando `parseTermsResponse`; **reject NÃO silencia o SparkBot** — só bloqueia grupo, é reversível); (4) advisor de spam (`group-campaigns/spam-advisor.ts`, regex, bloqueio duro só em combo extremo); (5) announce-only → warn. `group_campaign` é risk:high (H8). Tools: `group_campaign_info` (safe: list_groups/group_members/preview/list_campaigns) + `group_campaign` (high: schedule/pause/resume/cancel scoped a grupo).
- **Pra ligar em prod (👤)**: provisionar instância Stevo dedicada (row em `stevo_instances` com `kind='dedicated'` + creds, chaveada por `hub_location_id = active_location_id DO REP`) + `GROUP_CAMPAIGNS_ENABLED=1` (+ `RECURRING_CAMPAIGNS_ENABLED=1`). Validar 1 caso real antes de abrir. **Fora do MVP**: UI no `/hub` (só fluxo SparkBot DM existe), anti-ban robusto (cap/warmup/breaker), import de membros, processar replies dentro do grupo.
- Teste: `scripts/test-group-campaign.ts` (43/43). Review adversarial (5 frentes) com 7 achados corrigidos — ver H40 em `docs/DECISIONS.md`.

### Motor de Orquestração de Tarefas (H41, Pedro 2026-06-20) — flag OFF
SparkBot monta fluxos de follow-up GRANDES por chat (N msgs, multi-turno, com mídia/PDF, pra 1 ou N contatos) — vai além do follow-up simples (H33). Resolve o caso **Jussara** (fluxo no-show de ~40 dias que o bot não dava conta): fecha **L7** (perdia o fluxo entre turnos) e **L11** (afirmava "agendado" sem agendar — 7 confirmações falsas). **Tudo atrás de `TASK_ORCHESTRATOR_ENABLED` (default OFF / log-first)** — gateia o REGISTRO das tools em `tools/index.ts` E a seção de prompt. Plano: `_planning/jussara-sparkbot/`. Código: `lib/account-assistant/task-orchestrator/`.

- **Princípio anti-alucinação**: a tarefa é um OBJETO PERSISTENTE no DB (não uma lembrança). O bot relê via `show_draft`, muta via tools determinísticas que devolvem o ESTADO REAL, e **só afirma "agendado" a partir do COUNT REAL** inserido (`commit_draft` devolve as linhas que entraram de fato; INSERT checa error/affected; rollback honesto se parcial).
- **Schema (migrations 00115 + 00116)**: `task_drafts`/`draft_steps`/`task_events` (append-only) + bucket Storage `agent-media` (privado, criado na 00116 — **nunca existia** apesar de documentado; `reaction-engine` send_media já dependia dele). **Materializa em `followup_sequences`/`followup_messages`** (NÃO bulk — `UNIQUE(job_id,contact_id)` bloqueia N-msgs/1-contato), então o cron `followup-runner` (30s) entrega com **pause-on-reply/DND/opt-out de graça**.
- **11 tools** (gated): `start_task_draft`/`show_draft`(safe)/`add_step`/`edit_step`/`remove_step`/`set_task_meta`(medium)/`commit_draft`(**high**)/`get_task_progress`(safe)/`generate_flow_pdf`(medium)/`send_media_to_contact`(**high**)/`apply_flow_to_contacts`(**high**). H8 nas high. PDF via pdf-lib (Helvetica embutida cobre acentos PT-BR; sanitiza emoji WinAnsi).
- **Prompt**: seção `# MONTAR FLUXO DE FOLLOW-UP GRANDE` em `prompt-builder.ts`, GATED pela mesma flag (com OFF nem tools nem prompt aparecem = prompt idêntico ao de hoje). Ensina: rascunho persistente, `show_draft` a cada turno, confirmar-antes-de-commit, só afirmar count real, sub-fluxo PDF→envio, apply a N.
- **Anexo nativo validado (probe prod 2026-06-21)**: PDF chega como ARQUIVO NATIVO no WhatsApp pela rota GHL `/conversations/messages`→Stevo, mesmo type SMS (a nota "SMS puro vira caption" é só da rota Stevo DIRETA `/send/text`). Legenda fica limpa (URL assinada expira; arquivo nativo não). E2E real em prod validado (montagem→materialização→runner→entrega). Repro: `scripts/probe-f5-attachment.ts`, `scripts/e2e-orchestrator-live.ts`.
- **Ultra-review (2026-06-21, 37 agentes/7 dimensões, ver H41 em `docs/DECISIONS.md`)**: 24 achados confirmados. Fix-now aplicados: IDOR (resolvers travam `rep_id` quando `draft_id` é explícito), cap anti-spam no apply (200 contatos/2000 msgs + validateGhlId), idempotência (não duplica sequência pro mesmo draft+contato), `intra_day_delay_s` (era ignorado → multi-msg/dia do caso Jussara saía junto), signals de falha (materialize/PDF). **Fora do MVP** (de propósito): tag-trigger automático, recorrência cíclica, `send_condition` per-passo, UI no /hub, `assignedTo` no runner compartilhado.
- **Interpolação de `[nome]` (fix prod 2026-06-29, caso Jussara) — NO AR**: a tool `add_step` SEMPRE prometeu `[nome]` na description, mas a substituição NUNCA existia (estava como "fora do MVP") → o lead recebia `[nome]` cru; pior, sem placeholder o bot cravava um nome de exemplo ("Isabela"/"Hermes") que ia pra TODO contato (inclusive no apply a N). Fix: módulo `task-orchestrator/interpolate.ts` (`interpolateContactName`) troca `[nome]`/`{nome}`/`{first_name}`/`{primeiro_nome}`/`[name]` pelo 1º nome real — aplicado POR-CONTATO no `materializer.ts` (cada sequência usa o nome do SEU contato) E como defesa no envio (`followup-runner.ts`, pega placeholder que escapou de qualquer motor; não toca `{tags[0]}`/`{custom.*}`; idempotente). Guard suave anti-duplicata no `addStep` (passo de texto idêntico → `note`, sem bloquear). Prompt ensina: SEMPRE `[nome]`, NUNCA nome literal + variar cada toque + reusar fluxo. Teste `scripts/test-task-orchestrator.ts` 69/69. Cleanup do incidente: 2 sequências vivas (Matheus/Lunna) corrigidas+retomadas; 2 rascunhos-mina ("Fluxo Triagem"/"Fluxo de Triagem") defusados (nome literal → `[nome]`).
- **Biblioteca de Fluxos Salvos (F7, fix prod 2026-06-29, caso Jussara) — NO AR**: a Jussara queria montar um fluxo 1 vez e depois só dizer "manda o fluxo X pra fulano". O orquestrador resolvia fluxo por RECÊNCIA (último draft), sem busca por NOME → pegava o errado / dizia "não encontrei, monto do zero?" (buscava no transcript, não numa biblioteca). Fix (migration **00117** `task_drafts.saved_at`, aditiva): `flow-resolver.ts` reusa o scorer fuzzy do H45 (`nameScore`/`dice`/`deburr`) → `confidence` (high/needs_confirm/ambiguous/low), mesmo padrão do `search_contacts`. 4 tools novas (gated): `save_flow` (medium), `list_flows`/`find_flow` (safe), `apply_saved_flow` (**high**, reusa `applyFlowToContacts` — não consome o template; ambíguo NÃO aplica, devolve candidatos). Prompt: "buscar antes de remontar" + "oferecer salvar" + confirmar nome antes de disparar (anti-alucinação). Sinergia: só é seguro reaplicar template a N porque o `[nome]` agora interpola por-contato. Rollout: biblioteca da Jussara seedada (`Triagem` 12 passos + `No-show` 3 passos). Teste `scripts/test-task-orchestrator.ts` 84/84. Estudo: `_planning/jussara-sparkbot/ESTUDO-fluxos-salvos.md`. **Fora do MVP**: editar fluxo salvo (reusa edit_step apontando pro draft salvo), biblioteca compartilhada na location, UI no /hub.
- **Pra ligar em prod (👤)**: `TASK_ORCHESTRATOR_ENABLED=1` na Vercel (JÁ LIGADA — a Jussara usa em prod) + validar **1 conversa real com o LLM dirigindo as tools**. Teste: `scripts/test-task-orchestrator.ts` (84/84) + `scripts/smoke-task-orchestrator.ts` (18/18, via `executeTool`).

### SparkBot Cron Guards (Pedro 2026-05-05)
- pg_cron `sparkbot-proactive` agendado a cada 30s com:
  - `pg_try_advisory_xact_lock(8675309)` — **NÃO serializa as execuções do endpoint** (corrigido 2026-06-10; ver NB-7 em `docs/DECISIONS.md`). O lock é xact-scoped e `net.http_post` (pg_net) é ASSÍNCRONO: o tick só ENFILEIRA o POST e a transação commita (soltando o lock) em ms, antes do Vercel receber o request. Só evita que duas transações de DISPARO do MESMO instante co-enfileirem em paralelo — cenário ~impossível no schedule de 30s. A idempotência real (anti double-execution sob ticks sobrepostos, já que `maxDuration=60` > 30s) vem dos **claims atômicos CAS por linha nos runners**: `fireScheduledReminders` (`UPDATE … SET status='running' WHERE status='pending'`, `reminder-runner.ts`) e `claimBulkRecipients` (RPC `claim_bulk_recipients` com `FOR UPDATE SKIP LOCKED`, ou fallback `UPDATE … SET status='sending' WHERE status='pending'`, `bulk-message-runner.ts`). **NÃO remover esses claims achando que o lock cobre** — o lock fica só como guard barato.
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
- ❌ **Push sem conferir o deploy da Vercel** (incidente 2026-07-10→14): 3 builds de prod falharam em SILÊNCIO por 4 dias (o commit `d647d5d` levou junto código não-commitado de outra sessão — uso de `manual_context` sem o campo no tipo; tsc local passava porque o working tree TINHA o tipo). Regra dupla: (1) depois de todo `git push origin HEAD:main`, rodar `npx vercel ls --prod` até o deploy novo aparecer **Ready** — "pushed" ≠ "deployado"; (2) antes de commitar num working tree com mudanças de outra sessão, validar tsc/build num **worktree limpo do commit** (`git worktree add`), não no working tree misturado.
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
