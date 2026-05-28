# Plano: Gaps de UX + Prospecção 2.0 (2026-05-28)

> Spark AI Hub — fechar a paridade do hub e implementar prospecção 2.0 *de fato funcional* antes do cutover `PM-F3.I` (/hub vira produção, substitui /dashboard).

---

## 0. Resumo executivo

- **Origem:** Pedro descobriu regressão de targeting no wizard (fix `adb42e8`); pediu auditoria completa de todas as telas.
- **Achado:** 4 auditorias paralelas catalogaram **25 gaps reais** (10 ALTA · 8 MÉDIA · 7 BAIXA) + estado do runtime de bulk/outreach mostra capabilities ricas **sem UI** e `outreach_config` armazenado **sem runner**.
- **Decisões de Pedro (2026-05-28):**
  - Escopo prospecção: **completo** (recorrência + segmentos dinâmicos + sequência + A/B).
  - Order: **ALTAs → MÉDIAs → Prospecção → BAIXAs → Cutover**.
  - Anti-padrão de paridade entra como **Etapa 0**.
- **Estimativa total:** 15-20 sessões. Cutover `PM-F3.I` depende deste plano fechar.

---

## 1. Convenção de responsabilidade (markers)

Cada sub-tarefa carrega um marker:

- 🤖 **Claude executa** — código, schema, migrations, validação, testes.
- 👤 **Pedro / Time** — decisão de negócio, configuração em painel externo (Vercel/Sentry/GHL), recarga manual, smoke real.
- 🤝 **Híbrido** — Claude prepara + Pedro aprova/aplica/valida.

---

## 2. Etapa 0 — Anti-padrão + Handoff *(executar AGORA, mesmo commit do plano)*

Garante que toda sessão futura aplica gate de paridade antes de fechar refeitura de fluxo.

| # | Tarefa | Marker |
|---|---|---|
| 0.1 | Adicionar seção *"Anti-padrão: refazer fluxo sem gate de paridade"* em `CLAUDE.md` | 🤖 |
| 0.2 | Atualizar `_planning/_ultra-review-2026-05-26/HANDOFF.md` com bloco *2026-05-28 — Auditoria de gaps + Plano* (link pra este PLANO.md) | 🤖 |
| 0.3 | Commit único: `docs(planning): plano de gaps + prospecção 2.0 + anti-padrão de paridade` | 🤖 |

**Critério de saída:** CLAUDE.md tem a seção; próxima sessão lê e aplica.

---

## 3. Etapa 1 — 10 Gaps ALTA *(3-4 sessões)*

Bloqueiam cutover. Tudo aqui afeta runtime ou cria footgun que reps vão bater de cara.

### 3.1 Wizard de criação: 4 campos perdidos (paridade vs detail-view)

| # | Gap | Onde | Fix proposto | Marker |
|---|---|---|---|---|
| 1.1.1 | `conversation_examples` não capturado | `agent-wizard.tsx` + `/api/agent-platform/builder/compose` | Adicionar node skippable "exemplos de conversa" (textarea, audio_allowed); composer gera 1 troca como base | 🤖 |
| 1.1.2 | `greeting_style` + `farewell_style` não perguntados | `agent-wizard.tsx` | Node skippable "Como cumprimenta / como se despede" (2 textareas curtos) | 🤖 |
| 1.1.3 | `persona_description` não capturado | `agent-wizard.tsx` | Incluir em node `identity` ou criar node `persona` skippable | 🤖 |
| 1.1.4 | `composer` (builder/compose endpoint) não gera campos acima | `src/app/api/agent-platform/builder/compose/route.ts` | Estender system prompt do composer + JSON response pra incluir os 3 campos | 🤖 |

**Critério de saída:** Criar agente sales pelo wizard → ir no detail-view → os 4 campos vêm populados (não em branco).

### 3.2 Detail-view: 4 missing-UI / dead-write inconsistente

| # | Gap | Onde | Fix proposto | Marker |
|---|---|---|---|---|
| 1.2.1 | `ai_model` **lido na UI mas não no PUT** | `agent-detail-view.tsx:209` (lê) vs linhas 256-280 (PUT sem) | Decidir: A) virar editável (select Sonnet/Haiku/GPT-4) + incluir no PUT, OU B) remover do display (hoje é mentira de UI) | 🤝 (Pedro decide A ou B) |
| 1.2.2 | `fallback_model` zero UI | migration 00047 schema | Adicionar select em CatTone/CatLimits + incluir no PUT (claude-haiku-4-5, gpt-4.1-mini, none) | 🤖 |
| 1.2.3 | `disabled_tools` zero UI | migration 00047 schema | Multi-select de tools desabilitadas em CatLimits (lista dinâmica das tools registradas) | 🤖 |
| 1.2.4 | `system_prompt_override` zero UI (runtime consome em `prompt-builder.ts:87`) | `agent-detail-view.tsx` | Textarea avançada em CatLimits ou aba "Avançado" (com hint "substitui o prompt-base inteiro — use só em modo treinamento") | 🤖 |

**Critério de saída:** Os 4 campos editáveis no hub; smoke: setar `disabled_tools=["send_text"]` → bot recusa enviar texto no test-chat.

### 3.3 Footguns que viram agente mudo silenciosamente

| # | Gap | Onde | Fix proposto | Marker |
|---|---|---|---|---|
| 1.3.1 | CatChannel aceita **0 canais** sem aviso | `agent-detail-view.tsx:659-683` | Card de aviso vermelho "Nenhum canal = bot não responde" (espelha o pattern de CatHours) | 🤖 |
| 1.3.2 | Settings timezone sem validação client-side | `settings-form.tsx:75` | Trocar input livre por `<select>` com timezones válidas IANA (lista filtrada `Intl.supportedValuesOf("timeZone")`); fallback datalist | 🤖 |

**Critério de saída:** Tentar salvar agente sem canal → bloqueia ou alerta. Settings timezone só aceita valores válidos.

### 3.4 Hub: 4 truncagens silenciosas de listas

| # | Gap | Onde | Fix proposto | Marker |
|---|---|---|---|---|
| 1.4.1 | Activity (home + tab) truncada a 40 sem aviso | `lib/hub/data.ts:163-171` | Badge "Últimas N · Ver tudo" + link pra view paginada | 🤖 |
| 1.4.2 | Billing últimas 15 hardcoded | `lib/hub/data.ts:447` | Label "Últimas 15 atividades" + filtro de período (já tem date picker no legado) | 🤖 |
| 1.4.3 | Pausadas: top 200 sem date filter | `lib/hub/data.ts:224-260` | `.gte("ai_paused_at", ...)` 30 dias default + filtro de período | 🤖 |
| 1.4.4 | Access grid: todas as locations sem paginação | `lib/hub/data.ts:357-404` | Filtro server-side por status (`active`/`revoked`/`none`) + paginação cursor | 🤖 |

**Critério de saída:** Em todas as listas, user sabe se tem mais dado + consegue navegar.

**Saída da Etapa 1:** 🤝 Pedro valida 1 criação de agente sales + edita config + abre /hub messages/billing/access — tudo coerente, zero "mudo silencioso".

---

## 4. Etapa 2 — 8 Gaps MÉDIA *(2-3 sessões)*

| # | Gap | Onde | Fix proposto | Marker |
|---|---|---|---|---|
| 2.1 | Wizard sem KB (enabled_kbs + instructions) | `agent-wizard.tsx` | Node `knowledge` skippable: toggle + textarea de instruções | 🤖 |
| 2.2 | Wizard outreach: rate/cap/respect_hours hardcoded (20/100/true) | `agent-wizard.tsx` + `builder-spec.ts:280` | Quando `intakeMode==="outreach"`: node skippable com 3 inputs | 🤖 |
| 2.3 | Footgun outreach: tags vazias + respect_hours=true + hours desligado = nunca dispara | `agent-detail-view.tsx` CatOutreach | Card aviso vermelho similar ao CatChannel/CatHours | 🤖 |
| 2.4 | `confirmation_mode: "always"` sem hint que vira agente passivo | `agent-detail-view.tsx` CatLimits | Hint no radio "Sempre" | 🤖 |
| 2.5 | Embed SparkBot: status pausado/fora-de-horário/cap atingido invisível | `embed/sparkbot/page.tsx:447` | Polling do `/api/sparkbot/check-admin` retorna status; dot vira laranja/vermelho + tooltip | 🤖 |
| 2.6 | Settings: sem `beforeunload` warn em changes não-salvos | `settings-form.tsx` | `useEffect` com `beforeunload` listener gated em `dirty && !saving` | 🤖 |
| 2.7 | KB Manager sem validação de file size client-side (15MB) | `kb-manager.tsx:114` | `if (file.size > 15*1024*1024) { setError(...); return }` antes do upload | 🤖 |
| 2.8 | Activity exibe `"Agente"` + `"Spark Leads"` hardcoded | `lib/hub/data.ts:173-187` | JOIN com `agents` table pra puxar `agent_name` + canal real | 🤖 |

**Critério de saída:** 🤝 Pedro abre cada tela citada + faz uma ação que antes daria footgun — agora todas dão feedback claro.

---

## 5. Etapa 3 — 7 Gaps BAIXA *(1-2 sessões)*

| # | Gap | Onde | Fix proposto | Marker |
|---|---|---|---|---|
| 3.1 | Wizard sem quiet hours | `agent-wizard.tsx` | Node skippable em "hours" agrupando working + quiet | 🤖 |
| 3.2 | KPIs home sem clareza de período exato | `hub/page.tsx:38-42` | Label "Mensagens (últimos 30 dias)" + tooltip com datas | 🤖 |
| 3.3 | Billing "uso este mês" sem período customizável | `lib/hub/data.ts:437` | Reusar date picker do dashboard legado | 🤖 |
| 3.4 | Agents list sem filtro por template | `agents-list.tsx:15-30` | Adicionar abas/dropdown SparkBot/Sales/Recruitment/Custom | 🤖 |
| 3.5 | Embed inbox polling silently catches errors | `embed/sparkbot/page.tsx:135` | `console.warn` + retry exponencial após 3 falhas seguidas | 🤖 |
| 3.6 | Scheduling Prefs: duration órfã quando calendário é limpo | `embed/sparkbot/page.tsx:120-135` | `if (rawCalendarId === "") setDuration("")` no handleSave | 🤖 |
| 3.7 | Test Chat + `error.tsx` do hub: erros genéricos sem contexto | `test-chat.tsx` + `app/hub/error.tsx` | Diferenciar 404/timeout/500 + msg contextual | 🤖 |

**Critério de saída:** Lista de polish fechada; nada bloqueante.

---

## 6. Etapa 4 — Prospecção 2.0 (de fato funcional) *(8-10 sessões)*

> A maior fatia do plano. Bulk-messages-v2 já tem capabilities ricas no runtime (multi-segment, disclaimers tier, interpolação, delivery_strategy `today`/`spread_days`/`custom_window`, dedup, caps daily/weekly, quiet hours, variation, priority queue, snapshot). Falta UI no /hub + runner de outreach_config + sequência multi-toque + recorrência + segmentos dinâmicos + A/B.

### 6.1 — UI "Campanhas" no /hub *(2-3 sessões)*

| # | Tarefa | Marker |
|---|---|---|
| 4.1.1 | Nova rota `/hub/campaigns` (listagem + criar) | 🤖 |
| 4.1.2 | Listagem de jobs (active/scheduled/paused/completed/failed) com filtros — usa `bulk_dashboard` tool por baixo | 🤖 |
| 4.1.3 | Wizard "Nova campanha": **passo 1** selecionar agente (que dispara), **passo 2** lista via Filter Engine UI (FEL builder com chips de tag/stage/custom_field), **passo 3** template(s) + interpolação preview, **passo 4** delivery (hoje/agendar/spread N dias/custom window), **passo 5** disclaimers tier (computado), **passo 6** revisar + agendar | 🤖 |
| 4.1.4 | Preview de destinatários: tabela com 20 primeiros (contact name, phone mascarado, msg interpolada). API nova `/api/hub/campaigns/preview` que chama `preview_bulk_message_v2` | 🤖 |
| 4.1.5 | Detail de job: progresso (sent/total), error rate, recipients table com status + retry, botão **Pausar** / **Retomar** / **Cancelar** / **Reschedule** (reusa tools de bulk-management) | 🤖 |
| 4.1.6 | API REST nova: POST `/api/hub/campaigns` (create), GET `/api/hub/campaigns/:id`, PATCH (pause/resume/reschedule), DELETE (cancel). Autorização: `isAdmin` ou rep dono | 🤖 |
| 4.1.7 | Migration: nada novo (tabelas já existem) | 🤖 |

**Critério de saída:** 🤝 Pedro cria campanha pelo /hub, ela dispara no horário marcado, mostra progresso em real-time, dá pra cancelar.

### 6.2 — UI de Outreach config no agent detail-view *(1 sessão)*

| # | Tarefa | Marker |
|---|---|---|
| 4.2.1 | Nova categoria/Cat **Outreach** no detail-view (só visível se template = sales/recruitment/custom) | 🤖 |
| 4.2.2 | Form: toggle `enabled`, tag_filter (chips + match any/all), rate_per_hour (slider 1-500), daily_cap (input), respect_working_hours (switch), opening_message (textarea com interpolação) | 🤖 |
| 4.2.3 | Validação inline: se enabled=true → tags obrigatórias OU pipeline_stage; se respect_working_hours=true → working_hours tem que ter ≥1 dia ativo (cross-check) | 🤖 |

**Critério de saída:** Ligar outreach via UI; verificar que setting persiste e bate com schema.

### 6.3 — Runner do `outreach_config` *(2 sessões)* ⚠️ GAP CRÍTICO

Hoje o `outreach_config` é **armazenado em DB mas nada executa** — o bot fala "prospecção entra em breve" no wizard porque NÃO HÁ RUNNER.

| # | Tarefa | Marker |
|---|---|---|
| 4.3.1 | Migration nova `0009X_outreach_runner.sql`: tabela `outreach_runs` (id, agent_id, ran_at, contacts_targeted, contacts_sent, status, error) | 🤖 |
| 4.3.2 | Função `runOutreachForAgent(agentId)` em `src/lib/account-assistant/proactive/outreach-runner.ts`: lê outreach_config → query contatos via Filter Engine (tag_filter) → cria 1 bulk_message_job com opening_message como template → enfileira recipients respeitando rate/cap | 🤖 |
| 4.3.3 | Wire no cron `sparkbot-proactive` (a cada 5min): pra cada agente com `outreach_config.enabled=true`, verificar se está na janela de horário → chamar `runOutreachForAgent` | 🤖 |
| 4.3.4 | Dedup: usar `bulk_message_recipients.contact_id` pra não mandar pra mesmo contato 2x na mesma campanha de outreach | 🤖 |
| 4.3.5 | Test guard-rail `scripts/test-outreach-runner.ts`: cria agente fake com config → simula execução → valida que job foi criado + respeitou cap | 🤖 |
| 4.3.6 | 🤝 Smoke supervisionado: Pedro cria agente com outreach em location de teste, com 3 contatos taggeados → dispara → confere envio | 🤝 |

**Critério de saída:** Outreach criado pelo wizard/UI **dispara de fato** num horário marcado, respeita cap, dedupa.

### 6.4 — Sequência multi-toque *(2 sessões)*

> "Msg 1 hoje, msg 2 em 3 dias se não respondeu, msg 3 em 7 dias se ainda não respondeu, pausa em resposta."

| # | Tarefa | Marker |
|---|---|---|
| 4.4.1 | Migration: tabela `bulk_message_sequences` (id, job_id, step_number, template, delay_days, pause_on_reply BOOL) e `bulk_message_sequence_state` (recipient_id, current_step, next_send_at, status) | 🤖 |
| 4.4.2 | Estender wizard "Nova campanha" passo template: opção *"Sequência"* → editor multi-passo (adicionar passo, delay em dias, template) | 🤖 |
| 4.4.3 | Runner: estende `bulk-message-runner.ts` pra processar `bulk_message_sequence_state` (next_send_at vencido + sem resposta entre os steps) | 🤖 |
| 4.4.4 | Pause-on-reply: hook no webhook GHL inbound — ao detectar resposta de contato em sequência ativa, marcar `status='paused_by_reply'` | 🤖 |
| 4.4.5 | UI: detail do job mostra timeline da sequência (Step 1 sent · Step 2 pending) | 🤖 |

**Critério de saída:** Campanha com 3 toques: validar que step 2 dispara só após 3 dias e que pausa quando contato responde.

### 6.5 — Recorrência *(1-2 sessões)*

> "Toda segunda às 9am refaz a query e dispara nova rodada."

| # | Tarefa | Marker |
|---|---|---|
| 4.5.1 | Migration: tabela `recurring_campaigns` (id, agent_id, cron_expression, timezone, filter_config, template_config, enabled, last_run_at, next_run_at) | 🤖 |
| 4.5.2 | UI: "Nova campanha" tem opção *"Recorrente"* — picker de cron (toda seg 9am / todo dia útil 14h / custom cron) + preview de próximas 5 execuções | 🤖 |
| 4.5.3 | Cron `recurring-campaigns` (a cada 10 min): para cada `enabled=true` cuja `next_run_at <= now`, dispara `runRecurringCampaign(id)` que cria novo bulk_message_job + atualiza `next_run_at` (próximo cron tick) | 🤖 |
| 4.5.4 | Migration cron: `cron.schedule('recurring-campaigns', '*/10 * * * *', ...)` | 🤖 |
| 4.5.5 | UI: aba "Recorrentes" na listagem (separada dos one-shot) com histórico das execuções passadas | 🤖 |

**Critério de saída:** Criar campanha "toda 4ª às 9am" → deixa rodar 1 ciclo → confirma execução automática.

### 6.6 — Segmentos dinâmicos (FEL refresh) *(1 sessão)*

> Hoje quando job é criado, recipients são snapshot. Pra recorrentes/sequências, queremos que a query **re-execute** a cada disparo (não usar snapshot velho).

| # | Tarefa | Marker |
|---|---|---|
| 4.6.1 | Em `recurring_campaigns`: flag `refresh_segment_on_run BOOL DEFAULT true` (default true; opt-out pra performance se preciso) | 🤖 |
| 4.6.2 | No `runRecurringCampaign`: se `refresh_segment_on_run`, re-executa o FEL filter → contatos atuais. Diff com última execução: novos contatos entram, removidos não dispararam. Log em `filter_executions` | 🤖 |
| 4.6.3 | UI: opção "Atualizar lista a cada execução (recomendado)" na criação de recorrente | 🤖 |

**Critério de saída:** Campanha recorrente: adicionar tag em 1 contato → próxima execução pega ele.

### 6.7 — A/B de templates *(1 sessão)*

| # | Tarefa | Marker |
|---|---|---|
| 4.7.1 | Estender `bulk_message_jobs.message_template` aceitar array de templates com `weight` (default igual) | 🤖 |
| 4.7.2 | UI: na criação, opção *"Variantes A/B"* — editor com N variantes + peso (default 50/50) | 🤖 |
| 4.7.3 | Runner: ao gerar recipient_personalized_message, sorteia variante segundo peso. Salva `variant_id` em `bulk_message_recipients` | 🤖 |
| 4.7.4 | UI: detail job mostra stats por variante (sent/replied/blocked) | 🤖 |

**Critério de saída:** Campanha com 2 variantes 50/50 → recipients table mostra ~metade pra cada.

### 6.8 — Whitelist / blacklist *(1 sessão)*

| # | Tarefa | Marker |
|---|---|---|
| 4.8.1 | Migration: tabela `outreach_optouts` (location_id, contact_id, source, reason, created_at) UNIQUE(location_id, contact_id) | 🤖 |
| 4.8.2 | Hook no webhook GHL: detectar keywords STOP / SAIR / CANCELAR / "não me manda mais" → inserir em `outreach_optouts` | 🤖 |
| 4.8.3 | Runner: antes de enviar, query LEFT JOIN com `outreach_optouts` → pular | 🤖 |
| 4.8.4 | UI: tab "Opt-outs" em `/hub/campaigns` listando contatos opted-out + botão "Remover do opt-out" (admin only) | 🤖 |
| 4.8.5 | Estender preview/disclaimer: mostra "X destinatários · Y opt-outs serão pulados" | 🤖 |

**Critério de saída:** Contato responde "STOP" → próxima campanha não envia pra ele.

---

## 7. Etapa 5 — Smoke E2E + Cutover PM-F3.I *(1-2 sessões)*

| # | Tarefa | Marker |
|---|---|---|
| 5.1 | 🤝 Smoke test completo: criar agente sales novo (todos os campos), criar campanha bulk one-shot, criar campanha recorrente, criar sequência 3-toques, validar que cada tela do hub não tem regressão | 🤝 |
| 5.2 | 🤖 Rodar todas as guard-rails: `motor-parity`, `sales-parity`, `override-gate`, novo `outreach-runner-test` | 🤖 |
| 5.3 | 🤝 Pedro decide URL do cutover: `/hub` vira default, `/dashboard` fica como `/dashboard-legacy` por 30d até deprecate | 🤝 |
| 5.4 | 🤖 Redirect: `/dashboard/*` → `/hub/*` com `next.config.mjs` rewrites + banner "Você foi migrado pro novo hub" | 🤖 |
| 5.5 | 🤖 Atualizar HANDOFF.md, CLAUDE.md ("dashboard legado deprecated"), `_planning/plataforma-modular/PLANO.md` (Fase 3 fechada) | 🤖 |
| 5.6 | 🤝 Hypercare 48h: monitorar Sentry + admin_signals + reclamações de rep | 🤝 |

**Critério de saída final do plano:** /hub é a URL oficial. Reps usam sem footgun. Prospecção real funciona (não "em breve"). Sentry + Signals coletam erros sem reps reclamarem.

---

## 8. Decisões pendentes (👤 Pedro)

| ID | Decisão | Por quê importa | Default Claude assume se não responder |
|---|---|---|---|
| D1 | **ai_model na UI:** editável OU remover display? (gap 1.2.1) | A) abre flexibilidade mas pode trocar pra modelo ruim sem querer; B) mais honesto mas perde opção | A — virar editável, com guard de modelos permitidos (Sonnet, Haiku, GPT-4.1) |
| D2 | **Cron de recorrência: timezone do agente ou da agência?** | Agente em SP × agência EDT = horário diferente | Timezone do **agente** (já tem `active_hours.timezone`) |
| D3 | **Opt-out: keywords personalizáveis por location?** | Mercado BR usa "PARAR"; US usa "STOP" | Default global PT/EN; admin pode adicionar custom via Settings |
| D4 | **A/B: ratio livre ou só 50/50 inicialmente?** | Free-form é flexível; só 50/50 é simples | Free-form com slider (50/50 padrão) |
| D5 | **Bulk via UI pra todo rep, ou só admin?** | Reps poderem disparar bulk é poderoso mas perigoso (spam risk) | Default: admin + reps com flag opt-in; cada rep tem cap próprio |

---

## 9. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Implementar Etapa 4 e estourar quota Anthropic na variation | Média | Médio | Manter variation `none` como default; alertar custo no preview do hub |
| Bulk recorrente disparar 100k msgs por erro (filter solto) | Baixa | Crítico | Hard cap absoluto por job (configurável, default 5000); confirm extra se >1000 | 
| Cutover empurra reps despreparados | Média | Médio | Banner + 7d preview opcional antes do cutover oficial |
| Outreach runner cria spam em prod por bug | Baixa | Crítico | Flag `OUTREACH_RUNNER_ENABLED` default OFF; ligar só após smoke supervisionado |
| Gap descoberto novo durante implementação | Alta | Médio | Aplicar gate de paridade da §0 — qualquer nova feature passa por checklist |

---

## 10. Critério de saída global

- ✅ 25/25 gaps catalogados endereçados (ou movidos pra "design intencional documentado")
- ✅ Prospecção 2.0: UI no hub + outreach runner + sequência + recorrência + segmentos dinâmicos + A/B + opt-outs — **todos validados em smoke**
- ✅ Anti-padrão de paridade aplicado em qualquer feature nova (§0)
- ✅ Cutover PM-F3.I executado — /hub é a URL oficial
- ✅ Hypercare 48h sem incidente novo

---

## Apêndice A — Inventário de gaps (mapa rápido)

**ALTA (10):** wizard_conversation_examples · wizard_greeting · wizard_persona · ai_model_inconsistente · fallback_model · disabled_tools · system_prompt_override · channel_min_1 · timezone_validation · truncagem_4_listas

**MÉDIA (8):** wizard_kb · wizard_outreach_params · footgun_outreach · confirmation_always · embed_status · settings_beforeunload · kb_size · activity_agent_name

**BAIXA (7):** wizard_quiet · compose_examples · kpi_period · billing_period · agents_filter · embed_polling · scheduling_duration + test_chat_errors + error_tsx_context

**Prospecção (8):** UI_hub_campanhas · UI_outreach_config · runner_outreach · sequencia · recorrencia · segmentos_dinamicos · ab_templates · whitelist_blacklist
