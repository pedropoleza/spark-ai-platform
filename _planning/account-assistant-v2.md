# Account Assistant V2 — Design Doc

**Status:** Aguardando validação do Pedro antes de codar.
**Data:** 2026-04-24
**Filosofia:** IA decide tudo dinamicamente. Sistema configurável. Pronto pra migrar pra WhatsApp real (V3) sem mudar lógica.

---

## 1. Resumo executivo

V1 entregou: 8 tools básicas, sessões persistentes, termos de uso, UI com aba de teste. Funciona end-to-end no chat.

V2 transforma o Sparkbot de **reativo apenas** em **copiloto completo**:

1. **Tool catalog expandido** — ~30 tools cobrindo todo o GHL relevante pra um rep (CRUD de contato/note/task/appointment/opportunity, mensagens, calendário, custom fields).
2. **Sistema de proatividade dinâmico** — em vez de hardcodar 14 alertas com templates fixos, criamos um sistema baseado em **regras**. Cada regra tem trigger + prompt instruction. A IA decide o que dizer e quais tools usar. Admin pode criar regras customizadas.
3. **Chamadas agendadas** — resumo matinal, fim do dia, semanal, qualquer cron customizado.
4. **Configuration UI** — aba Proatividade com toggles + editor de regras + simular.
5. **Test mode** — alertas aparecem na sessão de teste com badge especial. Lógica idêntica à V3 (WhatsApp real); só muda o canal de output.

**Estimativa:** ~25-35h de implementação. Sugiro implementar em 5 fases sequenciais, cada uma testável.

---

## 2. Tool Catalog Expandido

### 2.1 Princípios

- **Risk levels:** safe (leitura, executa direto), medium (escrita leve, executa + confirma), high (irreversível ou afeta lead, sempre confirma).
- **validateGhlId** continua bloqueando IDs inventados.
- **Tool descriptions** explícitas sobre formatos (ISO 8601 com Z, IDs reais via search, etc).

### 2.2 Tools por categoria

#### 📇 Contatos (10 tools)

| Tool | Risk | Endpoint | Notas |
|---|---|---|---|
| `search_contacts` | 🟢 | GET /contacts/?query | Já existe (deprecated mas funciona) |
| `get_contact` | 🟢 | GET /contacts/{id} | Já existe |
| `create_contact` 🆕 | 🟡 | POST /contacts/ | locationId obrigatório, dedup automático por phone/email |
| `update_contact` 🆕 | 🟡 | PUT /contacts/{id} | Substitui update_field (suporta múltiplos campos de uma vez) |
| `delete_contact` 🆕 | 🔴 | DELETE /contacts/{id} | Sempre exige confirmação explícita |
| `get_contact_notes` 🆕 | 🟢 | GET /contacts/{id}/notes | |
| `get_contact_tasks` 🆕 | 🟢 | GET /contacts/{id}/tasks | |
| `get_contact_appointments` 🆕 | 🟢 | GET /contacts/{id}/appointments | |
| `add_tag` 🆕 | 🟡 | POST /contacts/{id}/tags | Substitui modify_tag (separado) |
| `remove_tag` 🆕 | 🟡 | DELETE /contacts/{id}/tags | |

#### 📝 Notas (4 tools)

| Tool | Risk | Endpoint |
|---|---|---|
| `create_note` | 🟡 | POST /contacts/{id}/notes (já existe) |
| `update_note` 🆕 | 🟡 | PUT /contacts/{id}/notes/{noteId} |
| `delete_note` 🆕 | 🔴 | DELETE /contacts/{id}/notes/{noteId} |
| `get_note` 🆕 | 🟢 | GET /contacts/{id}/notes/{noteId} |

#### ✅ Tarefas (5 tools)

| Tool | Risk | Endpoint | Notas |
|---|---|---|---|
| `create_task` | 🟡 | POST /contacts/{id}/tasks (já existe) | `completed: false` obrigatório |
| `update_task` 🆕 | 🟡 | PUT /contacts/{id}/tasks/{taskId} | Mudar título/due/body |
| `complete_task` 🆕 | 🟡 | PUT /contacts/{id}/tasks/{taskId}/completed | Endpoint dedicado |
| `delete_task` 🆕 | 🔴 | DELETE /contacts/{id}/tasks/{taskId} | |
| `get_task` 🆕 | 🟢 | GET /contacts/{id}/tasks/{taskId} | |

#### 📅 Calendário & Agendamentos (5 tools)

| Tool | Risk | Endpoint | Notas |
|---|---|---|---|
| `list_appointments` | 🟢 | GET /calendars/events (já existe) | |
| `list_calendars` 🆕 | 🟢 | GET /calendars/ | Ver quais calendários o rep tem |
| `get_free_slots` 🆕 | 🟢 | GET /calendars/{id}/free-slots | startDate/endDate em ms |
| `create_appointment` 🆕 | 🔴 | POST /calendars/events/appointments | Sempre confirma — afeta lead/calendário |
| `update_appointment` 🆕 | 🔴 | PUT /calendars/events/appointments/{id} | Reschedule |
| `delete_appointment` 🆕 | 🔴 | DELETE /calendars/events/appointments/{id} | Cancelar reunião |

#### 💰 Oportunidades (5 tools)

| Tool | Risk | Endpoint | Notas |
|---|---|---|---|
| `list_opportunities` | 🟢 | GET /opportunities/search (já existe) | |
| `get_opportunity` 🆕 | 🟢 | GET /opportunities/{id} | |
| `create_opportunity` 🆕 | 🟡 | POST /opportunities/ | |
| `update_opportunity` 🆕 | 🟡 | PUT /opportunities/{id} | Mudar valor, nome, atribuir |
| `update_opportunity_status` 🆕 | 🟡 | PUT /opportunities/{id}/status | Mover stage / fechar won/lost |
| `delete_opportunity` 🆕 | 🔴 | DELETE /opportunities/{id} | |
| `list_pipelines` 🆕 | 🟢 | GET /opportunities/pipelines | Admin precisa pra montar move |

#### 💬 Mensagens / Conversas (3 tools)

| Tool | Risk | Endpoint | Notas |
|---|---|---|---|
| `get_conversation_history` 🆕 | 🟢 | GET /conversations/{id}/messages | Ler histórico de conversa com lead |
| `search_conversations` 🆕 | 🟢 | GET /conversations/search | Achar conversa por contactId |
| `send_message_to_contact` 🆕 | 🔴 | POST /conversations/messages | **Sempre** confirma — afeta lead. SMS/WhatsApp/Email |

#### 🏷 Metadata (3 tools)

| Tool | Risk | Endpoint |
|---|---|---|
| `list_custom_fields` 🆕 | 🟢 | GET /locations/{id}/customFields |
| `list_tags` 🆕 | 🟢 | GET /locations/{id}/tags |
| `list_users` 🆕 | 🟢 | GET /users/ |

### 2.3 Total e validações

- **Total V2: ~32 tools** (8 V1 + 24 novas).
- Preço de manutenção: alto, mas cobre 95% do que rep precisa.
- Cada tool valida `validateGhlId` em IDs.
- Tools de risco 🔴 forçam confirmação independente do `confirmation_mode` global.

---

## 3. Sistema de Proatividade Dinâmico

### 3.1 Modelo conceitual

Em vez de hardcodar 14 alertas, criamos um **sistema de regras**. Cada regra é uma linha em `assistant_proactive_rules` com:

- **trigger** (quando dispara)
- **prompt instruction** (o que o bot deve fazer/dizer)
- **scope** (quais tools pode usar pra coletar contexto)

A IA recebe a instruction + contexto do trigger + tools disponíveis e gera a mensagem dinamicamente. Admin escreve a regra em linguagem natural.

**Exemplo concreto:**

```
Regra: "Briefing pré-reunião"
Trigger: 15min antes de qualquer appointment do rep
Prompt instruction: "Em 15min o rep tem essa reunião. Faça um briefing curto:
  - Quem é o lead (use get_contact)
  - Última conversa que tiveram (use get_conversation_history)
  - Opportunity associada se houver (use list_opportunities)
  - 1 sugestão prática pra essa conversa"
Tools allowed: [get_contact, get_conversation_history, list_opportunities, get_contact_notes]
```

A IA executa a chain: get_contact → get_conversation_history → list_opportunities → gera msg.

### 3.2 Schema do DB (migration 00030)

```sql
CREATE TABLE assistant_proactive_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rule_type       TEXT NOT NULL CHECK (rule_type IN ('reactive', 'scheduled')),
  name            TEXT NOT NULL,
  description     TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  -- Trigger config (formato depende do rule_type)
  trigger_config  JSONB NOT NULL,
  -- Reactive: { event: "appointment_upcoming", offset_minutes: -15 }
  --           { event: "appointment_no_show" }
  --           { event: "opportunity_stale", days_threshold: 7 }
  --           { event: "task_due_soon", offset_minutes: -60 }
  --           { event: "inbound_unanswered", hours_threshold: 4 }
  --           { event: "deal_won" }
  --           { event: "contact_assigned_to_rep" }
  -- Scheduled: { cron: "0 8 * * 1-5", timezone: "America/New_York" }
  prompt_instruction TEXT NOT NULL,
  -- Lista de tools que a IA pode usar pra cumprir a regra. NULL = todas.
  tools_allowed   JSONB,
  -- Cooldown configurável (anti-spam)
  cooldown_minutes INT NOT NULL DEFAULT 60,
  -- Origem: system (pré-configurada) ou custom (admin criou)
  source          TEXT NOT NULL DEFAULT 'custom',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proactive_rules_agent ON assistant_proactive_rules(agent_id, rule_type, enabled);

CREATE TABLE assistant_alert_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  rule_id         UUID NOT NULL REFERENCES assistant_proactive_rules(id) ON DELETE CASCADE,
  target_id       TEXT, -- ex: appointment_id, opportunity_id
  last_fired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rep_id, rule_id, target_id)
);

CREATE INDEX idx_alert_state_lookup ON assistant_alert_state(rep_id, rule_id);
```

`assistant_scheduled_tasks` (já planejada na 00029, agora ativada) — usada pra futures custom recurrences que rep cria via chat (V3+). V2 usa `assistant_proactive_rules` com rule_type='scheduled'.

### 3.3 Regras pré-configuradas (seed)

Criadas automaticamente na migration ou no primeiro provisionamento de Sparkbot por agency. Admin pode editar/desabilitar mas não deletar (são `source='system'`).

| Nome | Tipo | Trigger | Tools sugeridas |
|---|---|---|---|
| Briefing pré-reunião | reactive | appointment_upcoming -15min | get_contact, get_conversation_history, list_opportunities |
| Pós-reunião | reactive | appointment_ended +20min | get_contact, get_contact_appointments |
| No-show | reactive | appointment_no_show | get_contact, list_appointments |
| Opportunity parada | reactive | opportunity_stale 7 days | get_opportunity, get_contact, get_contact_notes |
| Task vencendo | reactive | task_due_soon -60min | get_task, get_contact |
| Tarefa atrasada | reactive | task_overdue +1h | get_task |
| Msg inbound não respondida | reactive | inbound_unanswered 4h | get_contact, get_conversation_history |
| Lead esfriando | reactive | contact_inactive 7d | get_contact, get_conversation_history |
| Deal fechado | reactive | deal_won | get_opportunity, get_contact |
| Novo lead | reactive | contact_assigned_to_rep | get_contact |
| Resumo matinal | scheduled | 08:00 mon-fri | list_appointments(today), list_opportunities, get_contact_tasks |
| Resumo fim do dia | scheduled | 18:00 mon-fri | list_appointments(today), get_contact_notes |
| Reflexão semanal | scheduled | Fri 17:00 | list_opportunities, list_appointments(week) |
| Pipeline review | scheduled | Mon 09:00 | list_pipelines, list_opportunities |

**14 regras pré-configuradas.** Admin pode adicionar quantas customizadas quiser.

### 3.4 Dispatcher (lógica de execução)

```
async function dispatchAlert(rule, repId, context, mode='real'|'simulated') {
  1. Verifica enabled
  2. Verifica quiet_hours do agent_config
  3. Verifica cooldown via assistant_alert_state
  4. Monta prompt: persona Sparkbot + rule.prompt_instruction + context
  5. Filtra tools allowed (rule.tools_allowed ou todas se null)
  6. Chama runWithTools (loop multi-turn como V1)
  7. Resultado:
     - mode='real': envia msg via WhatsApp (V3+)
     - mode='simulated': insert agent_test_messages com metadata.alert_type=rule.name
  8. Update assistant_alert_state.last_fired_at
}
```

### 3.5 Triggers reativos (webhook wiring)

Webhook principal `/api/webhooks/inbound-message` já recebe vários eventos GHL. Vou rotear pra um novo handler `assistant-alerts/router.ts` que:

1. Detecta tipo de evento (appointmentCreate, opportunityUpdate, etc)
2. Busca regras `reactive` ativas
3. Identifica rep dono da entidade (lookup por assignedTo, contactId, etc)
4. Pra cada regra match, chama dispatcher

**Eventos GHL relevantes pra capturar:**
- `AppointmentCreate` → checa se há briefing scheduled
- `AppointmentUpdate` → status no-show, completed
- `ContactCreate` → novo lead alert
- `OpportunityCreate`, `OpportunityUpdate`, `OpportunityStatusUpdate`
- `TaskCreate`, `TaskUpdate` (completed)
- `InboundMessage` → checar não-respondidas (timer-based)

Pra alguns alertas (briefing -15min, opportunity_stale 7d), não há evento específico. Aí precisamos de **scheduler interno** que roda periodicamente e detecta condições.

### 3.6 Triggers agendados (Vercel Cron)

Novo cron `/api/cron/assistant-proactive` roda **a cada 5 min**:

1. Lê `assistant_proactive_rules` com `rule_type='scheduled'` ativas
2. Pra cada regra, calcula próximo run (cron parsing)
3. Se já passou e não disparou ainda, dispara
4. Lê regras `reactive` que precisam de polling (briefing -15min, opportunity_stale, task_due_soon)
5. Identifica rep + target, chama dispatcher

Pra economizar: cron tem batch limit (max 100 disparos por execução, prioriza mais antigos).

---

## 4. UI — Aba "Proatividade"

### 4.1 Layout

Tabs internas: **Reativos** | **Agendadas** | **Quiet hours**

#### Reativos (cards)

Cada regra é um card:
- Nome + ícone do tipo
- Toggle on/off
- Descrição (1 linha)
- Trigger config (resumido, ex: "15min antes do appointment")
- Botão **"Editar"** → modal com prompt_instruction (textarea), tools allowed (multi-select), cooldown
- Botão **"Simular"** → modal com mock data + dispara
- Indicador "🔧 Customizado" se source='custom'
- Botão **"Adicionar regra customizada"** no fim

#### Agendadas (cards)

Igual, mas trigger config mostra cron parsed em humano ("Toda manhã 08:00 dias úteis"). Edit modal tem cron picker visual:
- Horário (time picker)
- Dias da semana (checkbox seg-dom)
- Ou modo avançado (textbox cron expression)

#### Quiet Hours (form simples)

- Enabled toggle
- Janela: time picker "de" e "até" (ex: 22:00 - 07:00)
- Dias: checkbox dom-sab
- Timezone: dropdown (default location timezone)

### 4.2 Editor de regra customizada

Modal:
1. **Nome** (curto, ex: "Lembrete de prospecção semanal")
2. **Tipo**: reactive | scheduled
3. **Trigger config**:
   - Reactive: dropdown de evento + offset
   - Scheduled: cron picker
4. **Prompt instruction** (textarea livre, com sugestões/templates)
5. **Tools allowed** (multi-select de todas as 32 tools, default = todas)
6. **Cooldown** (slider: 1min a 24h)

### 4.3 Botão "Simular" — UX

1. Abre modal compacto
2. Pre-fills com mock data sensato (pega um appointment/opp real do GHL se houver, senão fixed mock)
3. Permite admin editar mock data
4. Click "Disparar" → API call → mensagem aparece na sessão de teste atual com badge especial

---

## 5. Test Mode

### 5.1 Como aparece no chat

Mensagens de alerta aparecem com:
- Badge especial **"⚡ Proativo"** (amarelo/laranja, distinto do Bot normal azul)
- Subtítulo com nome da regra (ex: "Briefing pré-reunião")
- Botão "Simular igual" pra disparar de novo com mock parecido

### 5.2 Endpoint

`POST /api/agents/account-assistant/simulate-rule`
```json
{
  "session_id": "...",
  "rule_id": "...",
  "mock_data": {
    "appointment_id": "abc123",  // ou nome do lead, etc
    ...
  }
}
```

Resposta: igual ao `/test` normal, mas insert ocorre com metadata.alert_type=rule.name.

### 5.3 Migração pra WhatsApp real (V3)

Apenas troca o canal de output:
- `mode='simulated'` → insert agent_test_messages
- `mode='real'` → POST /conversations/messages no GHL Hub

Isso é a única mudança. Toda lógica (regras, prompts, tools, dispatcher) é idêntica.

---

## 6. Plano de Implementação

### Fase A — Tool Catalog (~8h)

1. Estender `src/lib/account-assistant/tools.ts` com 24 tools novas
2. Reorganizar em arquivos por categoria (contacts.ts, tasks.ts, etc) pra não virar 2000 linhas num só
3. Cada tool: definition + handler + validação
4. Atualizar prompt-builder pra mencionar todas as capacidades (versão resumida no system prompt)
5. Build + testar 3-4 tools novas via chat

### Fase B — Migration + Modelo de Dados (~3h)

1. Migration `00030_assistant_proactive_rules.sql`
2. Seed das 14 regras pré-configuradas no `provisionSparkbot()` helper (chama na primeira vez)
3. Tipos TypeScript

### Fase C — Dispatcher Core (~5h)

1. `assistant-alerts/dispatcher.ts` — função genérica
2. Integração com runWithTools (filtro de tools allowed)
3. Cooldown check via assistant_alert_state
4. Quiet hours check
5. Modo simulated vs real (canal de output)

### Fase D — Trigger Wiring (~6h)

1. Cron `/api/cron/assistant-proactive` (Vercel Cron 5min)
2. Polling logic pra alertas que precisam de checagem ativa (briefing, stale opps, task due)
3. Webhook handler routing — eventos GHL → alert router → dispatcher
4. Schedule resolver (cron expression parser)

### Fase E — Configuration UI (~6h)

1. Nova aba "Proatividade" com sub-tabs
2. Cards das regras (list + filter)
3. Modal de edit
4. Editor de regra customizada
5. Quiet hours editor
6. Botões "Simular"

### Fase F — Test Mode + Polish (~3h)

1. Endpoint simulate-rule
2. Badge "⚡ Proativo" no chat tester
3. Atualizar `Sobre` tab com lista de capacidades V2
4. Final tests + commits

**Total: ~31h.**

### Ordem sugerida

1. **A → B → C** primeiro (backend funcional). Aí já dá pra disparar regras via cURL e testar.
2. **D** (triggers) — agora reativos e agendados rodam de verdade.
3. **E** (UI) — admin gerencia tudo visualmente.
4. **F** (test mode + simular) — fecha o loop.

Cada fase: build + commit + push + checkpoint. Pedro testa entre fases se quiser.

---

## 7. Decisões pendentes (preciso da sua opinião)

### 7.1 Custom rules: regular ou avançado?

- 🟢 **Simples:** admin escolhe trigger de uma lista fixa + escreve prompt em linguagem natural
- 🟡 **Avançado:** admin pode criar trigger composto (AND/OR de condições)

Minha recomendação: simples no V2, avançado pode vir no V3 se realmente precisar.

### 7.2 Custos de tokens

Cada alerta dispara 1 chamada de LLM (com tools = mais turns). Pra 14 regras × N reps × M eventos por dia, custo escala. Sugestões:

- Cada regra tem `cooldown_minutes` (default 60min)
- Modelo Haiku 4.5 ($0.80/$4) pode ser default pros alertas — bem mais barato que Sonnet, e pra textos curtos é suficiente
- Logging via execution_log pra acompanhar custos por regra

Minha recomendação: **default Haiku 4.5 pros alertas, Sonnet pros resumos longos** (matinal, semanal). Configurável por regra (campo `ai_model`).

### 7.3 Prioridade de regras conflitantes

Se 2 regras dispararem ao mesmo tempo (ex: briefing + tarefa vencendo), Sparkbot manda 2 msgs separadas ou 1 consolidada?

- 🟢 **2 separadas:** simples, mais útil
- 🟡 **Consolidada:** mais "humano", mais complexo

Minha recomendação: 2 separadas (com pequeno delay entre elas).

### 7.4 Formato do cron

Pra scheduled rules, admin pode:

- 🟢 Usar UI visual (time picker + checkbox de dias)
- 🟡 Modo avançado: textbox cron expression

Recomendo ambos — UI default, link "modo avançado" pra cron expert.

### 7.5 Histórico de alertas disparados

- Mostro histórico no UI? Ex: "Sparkbot disparou Briefing 23x semana passada"
- Onde: aba Proatividade → seção "Histórico recente" (últimas 50 disparos)

Recomendo sim. Útil pra admin ver se alertas estão sobrando ou faltando.

### 7.6 Send_message_to_contact (tool 🔴 high risk)

A tool de mandar msg pro lead em nome do rep é poderosa mas perigosa. Opções:

- 🟢 Sempre exige confirmação dupla ("Tem certeza? A msg vai pro João Silva.")
- 🟡 Bloqueia em V2 (tool não disponível ainda) — só V3+ quando lógica de approval estiver mais robusta
- 🔴 Permite normal (admin assume risco)

Recomendo 🟢 confirmação dupla + log explícito em execution_log.

---

## 8. Migration path V2 → V3 (WhatsApp real)

V3 é literalmente:
1. Trocar `mode='simulated'` por `mode='real'` no dispatcher
2. Configurar webhook GHL pra apontar pro hub e número WhatsApp ser comprado
3. Pequeno fix: priorizar Cloud API dentro de 24h, Evolution fora

**Zero refactor de regras, prompts, tools.** Toda a lógica V2 já roda igual.

---

## 9. Riscos & Mitigações

| Risco | Mitigação |
|---|---|
| Spam de alertas (rep recebe demais) | Cooldown por regra (default 60min). Quiet hours. Limite de 5 alertas/dia por rep configurável. |
| LLM gera msg ruim em alerta proativo | Cada regra tem prompt_instruction explícita. Eval set de cada tipo de regra antes de ativar pra cliente. Botão "simular" pra admin testar antes. |
| Custo explode | Default Haiku pros alertas. Cooldown. Logging por regra com custo agregado. Alerta automático se custo passa de $X/mês. |
| LLM chama tool errada (delete em vez de update) | Risk levels + confirmação obrigatória pra 🔴. tools_allowed por regra (regra de "lembrete" não tem acesso a delete_*). |
| Regras conflitam (2 ao mesmo tempo) | Dispatcher serializa por rep+session. Pequeno delay (5s) entre msgs. |
| Cron falha em produção | Vercel Cron tem retry. execution_log marca falhas. Alerta no dashboard se cron não roda há >15min. |

---

## 10. Pergunta final pra você

Antes de eu codar, preciso de:

- **OK no plano geral** (ou ajustes)
- Respostas pras 6 decisões da seção 7
- Ordem de fases OK ou prefere outra?

Dou o OK e mergulho. Estimativa: 1.5-2 semanas de trabalho focado.
