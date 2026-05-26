# C2 — Funcionalidades dos Agentes (ultra-review 2026-05-26)

Coordenador C2. READ-ONLY (código + queries SELECT na prod). Domínio: round-trip de
config (L2.2), tools/ações (L2.5), audience/entitlement/IDOR (L2.6), wizard→spec→commit
(L2.1), fidelidade do prompt (L2.3).

Builder de lead REAL = `src/lib/ai/sales-prompt-builder.ts`. Runtime de lead =
`src/lib/queue/queue-processor.ts`. Config UI = `src/app/hub/agents/[agentId]/agent-detail-view.tsx`.
Wizard = `src/app/hub/agents/new/[template]/agent-wizard.tsx` → `builder-spec.ts` →
`/api/agent-platform/builder/{compose,commit}`. Zod = `src/lib/utils/validation.ts`.

---

## TOP P0/P1 (resumo)

Sem P0. Os achados são P1 funcionais (features prometidas na UI que não funcionam ponta-a-ponta)
e P2 (campos mortos / inconsistências). Nenhum IDOR aberto — os dois principais (KB, modules)
já foram fechados nesta mesma rodada de fixes.

---

## BREAKS

### P1 — Agendamento quebrado ponta-a-ponta no fluxo do hub novo (calendar_id nunca é setado)
- **Onde**: `agent-detail-view.tsx:714` (aba Agendamento diz literalmente *"A escolha de calendário
  entra em breve aqui"* — não há editor), `builder-spec.ts:specToConfig` (não escreve `calendar_id`),
  `builder/commit/route.ts` (não seta), `queue-processor.ts:391`
  (`shouldFetchSlots = !!config.calendar_id && objective !== "qualification_only"`),
  `action-executor.ts:188` (`book_appointment` usa `ctx.calendarId || action.calendar_id`).
- **O quê**: o wizard oferece objetivo "Qualificar + agendar" / "Só agendar" e a UI de config tem
  toda a aba Agendamento (especialista, post-booking, reagendamento), mas **nada popula `calendar_id`**.
  Sem ele: o runtime NUNCA busca free-slots (injeta zero horários no prompt) e o `book_appointment`
  cai com `calendarId:""`. O prompt (`buildBookingSection`) instrui o modelo a "consultar HORÁRIOS
  DISPONÍVEIS" que nunca chegam → modelo ou inventa, ou trava.
- **Porquê**: o editor de calendário existe só na UI LEGADA (`src/app/agents/sales/sales-config-content.tsx:294`).
  O hub novo regrediu essa capacidade.
- **Evidência prod**: os 3 `custom_agent` (template_key='custom', criados pelo wizard) têm
  `objective='qualification_and_booking'` e `calendar_id=null`. Vários sales/recruitment novos
  (template_key=null, audience='lead') idem. Só os agentes antigos (criados pela UI legada) têm calendar_id.
- **Fix**: expor seletor de calendário na aba Agendamento do hub (`GET /api/.../calendars`) e gravar
  `calendar_id` no `specToConfig`/commit; ou bloquear objetivo de booking até calendário escolhido.

### P1 — Automações com ações `send_text_fixed`/`send_media`/`pause_ai`/`webhook` em gatilho de EVENTO são silenciosamente descartadas
- **Onde**: UI oferece as 8 ações (`agent-detail-view.tsx:808-813`) pra qualquer gatilho, inclusive
  eventos (qualified/booked/handed_off/disqualified). Runtime event-based `executeAutomations`
  (`queue-processor.ts:933-966`) só trata 4: `add_tag`, `remove_tag`, `move_pipeline`, `update_field`.
- **O quê**: ao escolher gatilho de evento + ação "Enviar mensagem"/"Enviar mídia"/"Pausar IA"/"Webhook",
  a regra salva (zod aceita) mas **nada acontece** quando o evento dispara. As mesmas ações FUNCIONAM
  no gatilho "Campo preenchido…" (`on_data_field_set` → `reaction-engine.ts:145-237` cobre as 8).
- **Porquê**: o switch de `executeAutomations` ficou defasado em relação ao `reaction-engine`.
- **Fix**: rotear o ramo event-based pelo `executeReactionRules` (já cobre tudo) ou completar o switch.

### P1 — Notificações por email do agente de lead são dead-write
- **Onde**: UI `agent-detail-view.tsx:1007-1011` (Avisos por email: on_qualified/on_booked/on_handed_off +
  notification_email). Zod aceita (`validation.ts:188`). **Nenhum leitor** fora de validation/UI —
  grep por `on_qualified|on_booked|on_handed_off|notification_email` em `src/lib` e `src/app/api` retorna
  só validation.ts. `notify.ts` só exporta `notifyCriticalError` (erro técnico), não lê esses flags.
- **O quê**: admin liga "avisar quando qualificar/agendar" e informa email; **nunca chega email**.
- **Fix**: implementar consumo (no `objectiveCompleted` do `queue-processor.ts:805`) ou esconder a seção
  até existir.

---

## RISKS

### P1/P2 — custom_agent roda com framing de VENDAS hardcoded
- **Onde**: `queue-processor.ts:588` — `agentType: (agent.type==='recruitment_agent' ? 'recruitment_agent' : 'sales_agent')`.
  `sales-prompt-builder.ts:324` injeta seção "NATUREZA DO ATENDIMENTO: VENDAS" com regras invioláveis
  ("trate como CLIENTE", "NUNCA use linguagem de recrutamento…").
- **O quê**: todo `custom_agent` (o template "personalizado" do wizard) ganha o enquadramento de vendas
  independentemente do propósito. Para um custom não-comercial, as "regras invioláveis de vendas" brigam
  com o `custom_instructions`. O comentário no código reconhece o gap ("motor modular dedicado entra depois").
- **Fix**: para `custom_agent`, não forçar typeFraming de vendas (passar agentType neutro/derivar do propósito).

### P2 — `preferred_time_slot="morning"` é no-op; e o campo é morto para sales
- **Onde**: UI oferece "Qualquer/Manhã/Tarde-Noite" (`agent-detail-view.tsx:717`). Prompt só lê em
  `buildRecruitmentSection` (`sales-prompt-builder.ts:439`) e SÓ trata `afternoon_evening`; "morning" cai no
  else genérico ("horários de qualquer período"). Para `sales_agent` o campo **não é lido em lugar nenhum**.
- **Fix**: tratar "morning" no prompt e/ou ler o campo no caminho de vendas (ou ocultar p/ sales).

### P2 — `max_messages_per_conversation` não é aplicado para agentes de lead
- **Onde**: UI `agent-detail-view.tsx:984` (mostrado p/ lead E rep). Zod ok. Grep em `queue/`,`ai/`,
  `webhooks/` = sem leitura no runtime de lead (só `account-assistant/followup/settings-loader.ts`, que é SparkBot).
- **O quê**: o limite de mensagens por conversa não tem efeito em sales/recruitment/custom.
- **Fix**: aplicar cap no `queue-processor` (cortar/handoff ao exceder) ou esconder p/ lead.

### P2 — `custom_instructions`/`conversation_examples` truncados muito abaixo do limite da UI
- **Onde**: zod permite 10000 / 20000 (`validation.ts:101-102`), mas o prompt usa só 3000
  (`sales-prompt-builder.ts:847`) e 2000 (`:866`). System_prompt_override e KB têm caps próprios maiores.
- **O quê**: admin cola instruções/exemplos longos achando que valem inteiros; >3k/2k é silenciosamente cortado.
- **Fix**: alinhar caps UI↔prompt ou avisar o truncamento na UI.

### P2 — DST: offset de timezone hardcoded no agendamento
- **Onde**: `sales-prompt-builder.ts:693-696` (`ET:-04:00, CT:-05:00, MT:-06:00, PT:-07:00`).
  Offsets de horário de verão fixos → no inverno o `start_time` ditado ao modelo fica 1h errado.
- **Fix**: derivar offset real da data corrente (Intl/tz lib) em vez de mapa fixo.

### P2 — Inconsistência de escopo na config do SparkBot (account_assistant) vs outras rotas
- **Onde**: `config/route.ts:30,76` libera GET/PUT da config de `account_assistant` pra QUALQUER admin
  autenticado (sem checar company). As rotas de módulos (`modules/route.ts:40`) e KB
  (`knowledge-base/route.ts:111`) foram endurecidas nesta rodada pra exigir MESMA company
  (`assertLocationInCompany`).
- **O quê**: admin de outra company poderia ler/editar a config do SparkBot de uma location alheia
  (service-role bypassa RLS). SparkBot é "global por design", mas as outras rotas já restringiram à company.
- **Fix**: aplicar `assertLocationInCompany` também no config/route.ts para account_assistant (consistência).

### P2 — Outreach: o spec do wizard NÃO sela `opening_message` no commit quando vem vazio; e disparo é manual
- **Onde**: `builder-spec.ts:262-270` monta `outreach_config` com `rate_per_hour:20/daily_cap:100` fixos
  (wizard não pergunta ritmo). Mensagem de abertura só na review se preenchida. O disparo real é manual
  (avisado na UI). Não é break, mas a expectativa "o agente vai atrás" não vira ação automática.
- **Fix**: nada urgente; documentar que outreach nasce desligado/supervisionado (já avisado na UI).

---

## WORKS (verificado)

- **Round-trip OK** (UI↔zod↔DB↔prompt) para: personality (name/identity_mode/persona/greeting/farewell/
  language), tons (4 eixos), objective, data_fields (key/label/required/type/options/sync_to_ghl),
  targeting_rules, enabled_channels, follow_up_config, working_hours, post_booking, specialist_name,
  check_legal_docs, knowledge_base_instructions, enabled_kbs, debounce_seconds, quiet_hours,
  daily_proactive_limit, no_response_threshold, enable_audio/image/pdf/summary, confirmation_mode (rep-only).
- **Tools/ações**: `book_appointment`, `reschedule_appointment` (calendar_id à parte — ver P1),
  `update_field`, `add_tag`, `remove_tag`, `move_pipeline`, `send_message` ligados em `action-executor.ts`.
  KB doc (`knowledge_base` table) + carrier RAG (`enabled_kbs` → `retrieveCarrierKnowledge`,
  `queue-processor.ts:565-581`) ligados e fail-safe. Follow-up IA+manual ligados (`scheduleFollowUps`).
  Pausa/handoff (auto_pause_on_human_message + handoff_messages) ligados em
  `inbound-message/route.ts:338-449`. deactivation_rules aplicadas em `inbound-message/route.ts:599`.
  enable_summary_notes gated dentro de `summary-note-generator.ts:75`.
- **Gates**: lead agents corretamente SEM confirmation/test-mode gate (são autônomos; gates são do SparkBot).
  test-chat isola por `testSessionId` (`/api/agents/test`).
- **Entitlement**: `decideEntitlement` correto; flag `AGENT_ENTITLEMENTS_ENFORCED` OFF=log-first.
  Wire em `POST /api/agents` e `builder/commit`. account_assistant sempre liberado.
- **IDOR**: KB (`resolveKbLocation`) e modules (location/company) fechados. `PUT/DELETE /api/agents/[agentId]`
  e `/api/agents/test` escopados por location. entitlements POST admin-only + company-scoped.
- **Wizard→commit**: agente nasce `inactive`; **rollback presente** (`builder/commit:124-128` apaga o agente
  se a config falhar); fuso do horário herda da location (`:92-95`); módulos = derivados ∪ baseline do template.
- **Motor unificado** (`assembler.ts`): paridade — sparkbot/sales/recruitment delegam aos builders legados.

---

## FALSOS-POSITIVOS descartados (com motivo)

- `enable_summary_notes` "ignorado": **falso** — `generateSummaryNote` é chamado sempre mas faz SKIP interno
  se o toggle estiver OFF (`summary-note-generator.ts:75`).
- `send_text_fixed/send_media/pause_ai/webhook` "não implementados": **parcial** — funcionam no gatilho
  `on_data_field_set` (reaction-engine). Só o ramo de EVENTO os descarta (= o P1 acima).
- `auto_pause_on_human_message`/`handoff_messages` "dead-write": **falso** — lidos/aplicados em
  `inbound-message/route.ts:338-449`.
- `deactivation_rules` "dead-write": **falso** — lidos em `inbound-message/route.ts:599` (`checkDeactivationRules`).
- Agentes legados (audience/template_key NULL) "viram rep e perdem abas de lead": **falso** — `lib/hub/data.ts:81,295`
  faz fallback `audience = templateKey==='sparkbot' ? 'rep' : 'lead'`, e `typeToTemplateKey` deriva de `agent.type`.
- `conversation_examples` do wizard "perdido": tecnicamente sim (o `/compose` não retorna o campo, vira `""`),
  mas é **inofensivo** (campo opcional, editável depois na UI) — não conta como break.
- Drift de schema em `agent_configs`: **não há** — todas as colunas suspeitas (notifications, deactivation_rules,
  handoff_messages, max_messages_per_conversation, calendar_id, enabled_kbs, outreach_config) existem na prod.

---

## Latente (flag OFF hoje, mas quebra se ligar)

- **`AGENT_MOTOR_UNIFIED` ON + custom_agent → throw**: `queue-processor.ts:604` roteia pelo
  `assembleSystemPrompt` com `templateKey=templateKeyForAgentType('custom_agent')='custom_agent'` (default case),
  mas NÃO passa `moduleKeys`. O assembler default exige `audience==='lead' && leadArgs && moduleKeys`
  (`assembler.ts:100-105`) → senão `throw`. Como a flag é OFF (default), roda o builder legado. Antes de ligar
  a flag em prod, custom_agent quebra. (CLAUDE.md já alerta pra não ligar sem validar.)
