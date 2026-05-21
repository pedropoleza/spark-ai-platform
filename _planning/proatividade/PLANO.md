# SparkBot — Proatividade configurável (plano de implementação)
### FORGE-3 · 2026-05-21

> Convenção de responsável: 🤖 Claude · 👤 Pedro · 🤝 Híbrido (Claude prepara, Pedro valida/configura).
> Saiu do diagnóstico read-only deste dia (código + dados de prod) + direção do Pedro:
> "todas as proatividades funcionais, configuráveis por rep; úteis ligadas por padrão,
> as de nicho desligadas mas disponíveis (UI + chat). Lembrete de task = 15min antes, configurável."

---

## 1. Diagnóstico (estado REAL hoje — verificado)

### ✅ Funciona (confirmado em prod)
| Proatividade | Evidência |
|---|---|
| **Pós-reunião** (`post_meeting`) | 114 disparos, último hoje 14:30 UTC. Via polling do calendário no cron. |
| **Resumo matinal** (`scheduled`, cron 0 8 * * 1-5) | 13 disparos, último hoje 12:00 UTC (8h EDT). Handler dedicado (`daily-briefing.ts`). |
| **Lembrete pedido pelo rep** ("me lembra de X") | `schedule_reminder` → `assistant_scheduled_tasks.next_run_at` → `reminder-runner.ts`. kind=`requested` (não conta silêncio, respeita pausa). |

### ❌ Não funciona / não existe
| Proatividade | Causa-raiz |
|---|---|
| **Lembrete de TAREFA do GHL** | Regras `task_due_soon`/`task_overdue` **off** + reactive polling é **stub** (`route.ts:335` "ainda não implementado") + **webhook `TASKCREATE` é DESCARTADO** (`isRealMessage` → `invalidTypes` → return false, `inbound-message/route.ts:744-754`). A task nunca entra no bot. |
| Resumo fim do dia / Reflexão semanal / Pipeline review (`scheduled`) | Off; e mesmo ligadas caem no `else` → `skipped_disabled` (`route.ts:159-171`). Só "Resumo matinal" tem handler. Precisam context loader + template cada. |
| deal_won, novo lead, no-show, briefing pré-reunião (`reactive`) | Off + polling stub. **Mas os webhooks chegam** (OPPORTUNITY*/CONTACT*/APPOINTMENT*) e são descartados. |
| opportunity_stale, lead esfriando, inbound não respondida | Off + stub. São "ausência de atividade" → **sem webhook**. Precisam polling do GHL ou automação por conta. |

### 🔑 Descoberta-chave
GHL **já manda** webhooks de `TASK*`, `OPPORTUNITY*`, `APPOINTMENT*`, `CONTACT*` pro nosso endpoint — a gente **descarta** hoje (`isRealMessage` retorna false pra eles). Logo, a MAIORIA da proatividade pode ser **event-driven** (parar de descartar + rotear), **sem automação por conta no GHL**. Só o balde "ausência" (stale/esfriando/inbound) precisa polling. E o lembrete de task **reusa** o agendador que já existe (`assistant_scheduled_tasks`).

---

## 2. Visão (o que vamos entregar)

Toda regra de proatividade **funcional** e **configurável por rep**, com dois eixos:
- **Master global (admin)**: `assistant_proactive_rules.enabled` — quais regras existem/estão disponíveis (UI já existe em `/agents/account-assistant` + API `/api/agents/sparkbot/rules`).
- **Opt-in por rep**: cada rep escolhe o que quer — **via chat** (generalizar `set_daily_briefing` → tool de proatividade) e **via UI** (admin no dashboard, por rep). Defaults: úteis ON, nicho OFF-mas-disponível.

Uma regra dispara pro rep **sse** (global enabled) **E** (rep opt-in, com default por regra).

---

## 3. Decisões (fechadas 2026-05-21 + pendências operacionais)

| ID | Decisão | Estado |
|----|---------|--------|
| D1 | **Superfície de config = a UI que JÁ existe** (`embed/sparkbot/page.tsx`, custom menu link do Spark, que já lista as regras). NÃO cria tela nova. Modelo de 2 camadas: **UI global** (por agente/hub — você ajusta o que está disponível + default) **+ chat por rep** (cada rep liga/desliga pra si, padrão `set_daily_briefing`). | ✅ Fechada |
| D3 | **Task sem due date → NÃO lembra** (sem prazo, sem agendamento). "Tarefa atrasada" é regra separada configurável (default OFF). | ✅ Fechada |
| D2 | **Matriz de defaults** (seção 5) segue "útil ON, nicho OFF". **Briefing pré-reunião = ON, mas CONTEXTUAL**: só dispara se houver conteúdo real (notes/última conversa/opp no contato); briefing vazio → pula (padrão `skipped_empty` do resumo matinal). Respeita anti-spam (silence-gate). | ✅ Fechada |
| D4 | **Payload do webhook GHL de task** tem `dueDate`/`contactId`? | 🟡 Verificar nos logs (🤝: Pedro cria 1 task, 🤖 lê o log da Vercel) — 1º passo da Etapa 0 |

---

## 4. Arquitetura

**4.1. Roteador de eventos (novo — o miolo).** Antes do `isRealMessage` descartar, um `routeProactiveEvent(payload)` capta `TASK*`/`OPPORTUNITY*`/`APPOINTMENT*`/`CONTACT*` e mapeia evento → ação. Fire-and-forget, **non-fatal**, **gated por env** (`PROACTIVE_EVENTS_ENABLED`) pra ser reversível e não afetar o path de mensagem.

**4.2. Camada de config.**
- `rep_identities.profile.preferences.proactivity` (JSONB): `{ <rule_key>: { enabled: bool, params?: {...} } }` (ex: `task_reminder: { enabled: true, lead_min: 15 }`). Migration aditiva; ausência = default da regra.
- `resolveProactivityPref(rep, ruleKey)`: master global AND opt-in do rep (com default). Único ponto de decisão, reusado por router + cron.
- Tool de chat `set_proactivity` (generaliza `set_daily_briefing`): "ativa lembrete de tarefa", "me lembra das tasks 30min antes", "desliga resumo". Prompt treina o uso.

**4.3. Timing reusa `assistant_scheduled_tasks`.** Eventos com hora futura (task due−15min, briefing −15min) viram linha em `assistant_scheduled_tasks` (`next_run_at`, `task_type` novo) → `reminder-runner` entrega. Eventos imediatos (deal_won, novo lead) → `dispatchRule` na hora. Cancelamento (TASKCOMPLETE/DELETE) → marca o scheduled_task cancelado.

**4.4. Anti-spam preservado.** Todo proativo continua passando pelo silence-gate (warn 2/3, pausa ≥4) e pelo signal de pausa. Lembrete pedido/configurado pelo rep usa kind=`requested` (não ameaça).

---

## 5. Matriz de defaults (proposta — assinar em D2)

| Regra | Categoria | Default | Fonte do evento |
|---|---|---|---|
| Resumo matinal | scheduled | **ON** | cron (já ok) |
| Pós-reunião | reactive | **ON** | polling calendário (já ok) |
| **Lembrete de tarefa** (due − 15min) | event-driven | **ON** | webhook TASKCREATE |
| Tarefa atrasada | event-driven | OFF | webhook + scheduled |
| Briefing pré-reunião (−15min) | event-driven | **ON** (contextual: pula se vazio) | webhook APPOINTMENTCREATE |
| Deal fechado | event-driven | OFF | webhook OPPORTUNITYSTATUSUPDATE=won |
| Novo lead atribuído | event-driven | OFF | webhook CONTACTCREATE/assigned |
| No-show | event-driven | OFF | webhook APPOINTMENTUPDATE=no-show |
| Resumo fim do dia | scheduled | OFF | cron |
| Reflexão semanal | scheduled | OFF | cron |
| Pipeline review | scheduled | OFF | cron |
| Opp parada (stale) | polling | OFF (build depois) | polling GHL |
| Lead esfriando | polling | OFF (build depois) | polling GHL |
| Inbound não respondida | polling | OFF (build depois) | polling GHL |

Briefing pré-reunião: ON mas só dispara com contexto (notes/conversa/opp); vazio → pula.

---

## 6. Etapas

### Etapa 0 — Decisões + rede de segurança 👤🤝
- 👤 Fechar D1–D4 (seção 3).
- 🤝 Confirmar payload real do webhook de task no GHL (`dueDate`, `contactId`, `assignedTo`) — Pedro dispara 1 task, 🤖 lê o log.
- 🤖 Env gate `PROACTIVE_EVENTS_ENABLED` (default OFF) + migration aditiva de `proactivity` prefs.
- **Saída:** decisões assinadas; gate criado; deploy não muda nada até ligar (👤✅ + 🤖✅).

### Etapa 1 — Camada de config (per-rep + chat) 🤖
- Schema `profile.preferences.proactivity` + `resolveProactivityPref` + generalizar tool → `set_proactivity` (mantém `set_daily_briefing` como alias retrocompat) + treino no prompt.
- **Saída:** rep liga/desliga qualquer regra por chat; cron/router consultam a pref (🤖✅ unit test do resolver).

### Etapa 2 — Roteador de eventos 🤖
- `routeProactiveEvent` capta os webhooks hoje descartados (sem quebrar `isRealMessage`/path de msg), gated por env, non-fatal.
- **Saída:** webhooks task/opp/appt logados como evento (sem disparar ainda) — observabilidade antes de agir (🤖✅).

### Etapa 3 — Lembrete de tarefa (P0 — pedido do Pedro) 🤖
- TASKCREATE/UPDATE → agenda `assistant_scheduled_tasks` em `due − lead_min` (default 15, configurável). TASKCOMPLETE/DELETE → cancela. `reminder-runner` entrega via gate de confiabilidade/anti-spam.
- (Se D3 incluir) tarefa atrasada → 2º agendamento.
- **Saída:** task criada no GHL com due → rep recebe lembrete 15min antes; completar/apagar cancela. 🤝 smoke do Pedro (cria task real, confere lembrete).

### Etapa 4 — Eventos restantes (default OFF, configuráveis) 🤖
- deal_won, novo lead atribuído, no-show, briefing pré-reunião — via router (imediato ou agendado). Cada um respeita opt-in.
- **Saída:** rep que ativa cada um recebe; quem não ativou, não (🤝 smoke por regra ativada).

### Etapa 5 — Resumos agendados restantes 🤖
- Context loader + template pra fim do dia / reflexão semanal / pipeline review (copiar padrão `daily-briefing`), branch no handler scheduled, opt-in.
- **Saída:** rep que ativa recebe o resumo no horário (🤝 smoke).

### Etapa 6 — UI admin per-rep 🤖🤝
- Dashboard (aba Reps): ver/togglar prefs de proatividade por rep + garantir master toggles das regras. (Conforme D1.)
- **Saída:** admin liga/desliga por rep pela UI (👤 valida no painel).

### Etapa 7 — Polling/ausência (design, build depois) 🤖
- opportunity_stale / lead esfriando / inbound não respondida: especificar o poller (query GHL por location, custo, cooldown) — **não** construir nesta leva (Pedro: stale fora por ora). Deixar a regra disponível na UI marcada como "em breve".

### Etapa 8 — Teste + smoke + deploy 🤖🤝
- 🤖 `tsc` 0, suites verdes, `next build`. Deploy gated. 🤝 smoke supervisionado do Pedro por regra ligada. Ligar `PROACTIVE_EVENTS_ENABLED` no fim.

---

## 7. Rollback / segurança
- Tudo atrás de `PROACTIVE_EVENTS_ENABLED` (off → comportamento idêntico ao de hoje). Reverter = desligar env.
- Migration de prefs é aditiva (coluna/JSONB nova). Router é non-fatal (try/catch, nunca bloqueia mensagem). Nenhuma operação de cliente afetada.
- Defaults conservadores: só task+resumo matinal+pós-reunião ON; resto opt-in.

## 8. Riscos
| Risco | Prob | Impacto | Mitigação | Resp |
|---|---|---|---|---|
| Webhook de task sem `dueDate` | médio | alto (lembrete não agenda) | D4 confirma payload; se faltar, fallback (avisa na criação) | 🤝 |
| Spam ao ligar muitas regras | médio | alto (ban WhatsApp) | silence-gate + signal de pausa já cobrem; defaults OFF | 🤖 |
| Router quebrar path de mensagem | baixo | alto | gate env + non-fatal + Etapa 2 só loga antes de agir | 🤖 |
| Dupla execução de evento (webhook repetido) | médio | médio | dedup por event id em `assistant_alert_state`/scheduled_tasks (claim atômico, padrão post_meeting) | 🤖 |
