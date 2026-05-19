# Follow-up Feature (SparkBot) — Plano de Implementação

> Status: **draft pra aprovação**
> Autor: Pedro + Claude, 2026-05-18
> Decisões tomadas (perguntas 1–4):
> - Schema: tabelas próprias em diretório dedicado (não reusar bulk)
> - Spam score: híbrido (regras → LLM se ambíguo) + LLM lê conversa pra contexto
> - Approval: adaptive por risk + override config
> - MVP: completo + arquitetura modular pra webhook futuro

---

## 1. Visão arquitetural

A feature é construída como um **domínio próprio** (`src/lib/account-assistant/followup/`)
que serve um **core service reutilizável** chamado por múltiplas entradas (hoje chat,
futuro webhook/proactive rule).

```
┌─────────────────────────────────────────────────────────────────┐
│                    Entradas (futuro: várias)                     │
├──────────────┬──────────────────┬──────────────────────────────┤
│ chat command │  proactive_rule  │   webhook (stage_changed)    │
│   (MVP)      │  (post_meeting)  │   (preparação, não no MVP)   │
└──────┬───────┴────────┬─────────┴─────────────┬────────────────┘
       │                │                       │
       v                v                       v
       ┌────────────────────────────────────────┐
       │   followup/core.ts (single entry)       │
       │   createFollowupRequest(input)          │
       └────────────────────┬───────────────────┘
                            │
       ┌────────────────────┴────────────────────┐
       │                                          │
       v                                          v
┌──────────────────┐                  ┌──────────────────────┐
│  resolveContext  │                  │  loadFollowupSettings│
│  (contato +      │                  │  (agent_configs +    │
│   conversation)  │                  │   per-stage rules)   │
└────────┬─────────┘                  └────────┬─────────────┘
         │                                      │
         v                                      v
       ┌─────────────────────────────────────────┐
       │  runSafetyChecks (plan/wallet/opt-out)  │
       └────────────────┬────────────────────────┘
                        │
                        v
       ┌─────────────────────────────────────────┐
       │  computeSpamScore (regras → LLM ambíguo)│
       └────────────────┬────────────────────────┘
                        │
                        v
       ┌─────────────────────────────────────────┐
       │  generateSequence (LLM, 1-3 msgs)       │
       └────────────────┬────────────────────────┘
                        │
                        v
       ┌─────────────────────────────────────────┐
       │  decideFlow(score, settings)            │
       │   ├─ low risk → auto-schedule           │
       │   ├─ medium  → request approval         │
       │   └─ high    → bloqueia + lembr.interno │
       └────────────────┬────────────────────────┘
                        │
                        v
       ┌─────────────────────────────────────────┐
       │  scheduler + runner + pause-on-reply    │
       │  (rodando contra followup_messages)     │
       └─────────────────────────────────────────┘
```

---

## 2. Estrutura de arquivos

```
src/lib/account-assistant/
├── followup/                          # NOVO domínio
│   ├── core.ts                        # createFollowupRequest (entry único)
│   ├── context-resolver.ts            # resolve contato + busca conversa
│   ├── conversation-summarizer.ts     # LLM resume conversa
│   ├── spam-score.ts                  # regras → LLM ambíguo
│   ├── settings-loader.ts             # agent_configs.followup_* + per-stage
│   ├── safety-checks.ts               # opt-out, wallet, plan, dedup
│   ├── sequence-generator.ts          # LLM gera 1-3 msgs
│   ├── sequence-scheduler.ts          # cria followup_sequences + messages
│   ├── sequence-monitor.ts            # onContactReply → pausa
│   ├── sequence-notifier.ts           # avisa rep on completed/paused
│   └── types.ts
│
├── proactive/
│   └── followup-runner.ts             # claim atomic + send (cron 30s)
│
└── tools/
    └── followup/                       # NOVO subdiretório de tools
        ├── create-followup.ts          # entry point conversacional
        ├── approve-followup.ts
        ├── edit-followup.ts
        ├── cancel-followup.ts
        ├── pause-followup.ts
        ├── resume-followup.ts
        ├── list-my-followups.ts
        └── get-followup-progress.ts
```

---

## 3. Schema (migration nova)

### `followup_sequences`
```sql
CREATE TABLE followup_sequences (
  id UUID PK,
  rep_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  agent_id UUID,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  conversation_id TEXT,

  -- Quem pediu (origem do request)
  source TEXT NOT NULL,   -- 'chat' | 'proactive_rule' | 'webhook' (futuro)
  source_metadata JSONB,

  -- Goal & contexto
  goal TEXT,
  sequence_type TEXT,     -- 'sales' | 'service' | 'reschedule' | 'pos_sale' | 'internal_reminder' | 'recurring'
  tone TEXT,
  context_source TEXT,    -- 'manual_only' | 'conversation_used' | 'mixed' | 'none'
  context_summary TEXT,   -- resumo do que bot leu da conversa (auditável)

  -- Spam scoring
  spam_score INT,         -- 0-100
  spam_risk TEXT,         -- 'low' | 'medium' | 'high'
  spam_flags JSONB,
  spam_recommendation TEXT,

  -- Approval
  approval_status TEXT NOT NULL DEFAULT 'pending_approval',
                          -- 'pending_approval' | 'approved' | 'edited' | 'rejected' | 'auto_approved'
  approved_at TIMESTAMPTZ,
  approved_by_rep BOOLEAN,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'draft',
                          -- 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled' | 'skipped_reply' | 'failed'
  stop_on_reply BOOLEAN NOT NULL DEFAULT true,
  delivery_channel TEXT NOT NULL DEFAULT 'whatsapp_web_sms',

  -- Counters
  total_messages INT DEFAULT 0,
  sent_messages INT DEFAULT 0,
  skipped_messages INT DEFAULT 0,

  -- Timestamps
  scheduled_first_at TIMESTAMPTZ,
  scheduled_last_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_followup_seq_rep_status ON followup_sequences (rep_id, status);
CREATE INDEX idx_followup_seq_loc_status ON followup_sequences (location_id, status);
CREATE INDEX idx_followup_seq_contact_active
  ON followup_sequences (contact_id, location_id)
  WHERE status IN ('scheduled','running','paused');
```

### `followup_messages`
```sql
CREATE TABLE followup_messages (
  id UUID PK,
  sequence_id UUID NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  position INT NOT NULL,      -- 1, 2, 3...

  message_text TEXT NOT NULL,         -- texto após interpolation
  message_text_original TEXT,         -- texto pré-edits do rep
  tone_hint TEXT,

  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
                              -- 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'cancelled'
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  ghl_message_id TEXT,

  -- Spam recheck antes do envio
  requires_final_check BOOLEAN DEFAULT true,
  spam_score_at_send INT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_followup_msg_seq_pos ON followup_messages (sequence_id, position);
CREATE INDEX idx_followup_msg_pending ON followup_messages (status, scheduled_at)
  WHERE status = 'pending';
```

### `followup_events` (audit trail)
```sql
CREATE TABLE followup_events (
  id UUID PK,
  sequence_id UUID NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
              -- 'created'|'approved'|'auto_approved'|'edited'|'rejected'|'paused'|'resumed'
              -- 'cancelled'|'message_sent'|'message_failed'|'contact_replied'
              -- 'spam_recalc'|'completed'|'skipped'|'safety_blocked'
  event_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_followup_evt_seq ON followup_events (sequence_id, created_at DESC);
```

### `agent_configs` — novas colunas
```sql
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  followup_feature_enabled BOOLEAN DEFAULT true,
  followup_approval_mode TEXT DEFAULT 'adaptive',
                              -- 'adaptive' | 'always_ask' | 'auto_low_risk' | 'auto_all'
  followup_default_sequence_length INT DEFAULT 2,
  followup_max_sequence_length INT DEFAULT 3,
  followup_default_interval_hours INT DEFAULT 48,
  followup_max_messages_without_response INT DEFAULT 2,
  followup_allow_conversation_context BOOLEAN DEFAULT true,
  followup_allowed_channels JSONB DEFAULT '["whatsapp_web_sms"]',
  followup_stage_triggers JSONB;   -- futuro webhook
```

---

## 4. Tools expostas ao LLM (MVP)

### `create_followup_request` (medium risk — adaptive sobe pra high)
**Trigger frases:** "cria follow-up com X", "manda mensagem pro X em N dias", "faz uma sequência leve pra X", "me lembra de falar com X sexta".

Args:
- `contact_query` (string) — nome/phone/id (resolve via disambiguation H30.2)
- `goal` (string opcional)
- `manual_context` (string opcional)
- `use_conversation_context` (bool — default false, bot pergunta se não fornecido)
- `requested_at` (ISO ou texto natural — "sexta 9h", "daqui 3 dias")
- `sequence_length` (int 1-3, default 1 se simples, 2 se "sequência")
- `tone` (opcional — "leve"/"direto"/"casual")
- `type` (default `sales` — pode ser `internal_reminder`)

Comportamento:
1. Resolve contato (disambiguation se múltiplos)
2. Se `use_conversation_context=undefined` E não tem manual_context → PERGUNTA "Quer que eu use as últimas conversas?"
3. Resolve contexto (busca + summarizer LLM)
4. Roda spam_score
5. Gera sequência
6. Decide fluxo conforme `decideFlow`:
   - low risk + `auto_low_risk` config → auto-schedule + notif "Agendei"
   - medium / config `always_ask` → cria draft + retorna `sequence_id` + texto pra LLM apresentar pro rep
   - high risk → recomenda `type=internal_reminder` ao invés
7. Retorna estrutura clara pra LLM apresentar:
```json
{
  "sequence_id": "...",
  "approval_required": true,
  "spam_risk": "medium",
  "spam_reason": "Contato não responde há 5 dias e já recebeu 2 msgs sem retorno",
  "messages_preview": [
    {"position": 1, "text": "...", "scheduled_at": "..."},
    {"position": 2, "text": "...", "scheduled_at": "..."}
  ],
  "next_action_prompt": "Confirma agendar? Pode editar ou cancelar."
}
```

### `approve_followup` (high — confirmed_by_rep gate)
Args: `sequence_id`. Marca approved, schedula messages no DB, runner pega.

### `edit_followup` (medium)
Args: `sequence_id`, `changes` (string em PT — "troca o tom pra mais casual", "manda só a primeira", "muda pra terça 10h").
LLM reformula → atualiza messages no DB → mostra novo preview.

### `cancel_followup` / `pause_followup` / `resume_followup` (high/medium/medium)
Args: `sequence_id` ou `contact_query`.

### `list_my_followups` (safe)
Args: `status` filter opcional. Retorna sequences ativas/recentes do rep.

### `get_followup_progress` (safe)
Args: `sequence_id`. Detalhe completo + events.

---

## 5. Spam score híbrido — implementação

**Camada 1: regras determinísticas** (em `spam-score.ts`)

Sinais:
- `unanswered_outbound_count`: msgs outbound sem inbound posterior
- `days_since_last_inbound`: dias desde último inbound do contato
- `inbound_outbound_ratio_30d`
- `has_optout_tag`: contato com tag `dnc`/`stop`/`opt_out`/`não enviar`
- `last_inbound_sentiment`: usado só se camada 2 ativar
- `existing_active_sequences`: já tem sequence rodando pra esse contato?

Score base:
```
score = 100  # parte do topo
- unanswered_count * 12
- min(days_since_last_inbound, 30) * 1.5
+ has_recent_appointment ? 10 : 0
+ is_active_client ? 15 : 0
- has_optout_tag ? 100 : 0  # zera
- existing_active_sequences * 20
+ inbound_outbound_ratio_30d > 0.5 ? 15 : 0
```

Risk thresholds:
- `score >= 70` → low
- `40 <= score < 70` → medium (**chama LLM pra refinar**)
- `score < 40` → high

**Camada 2: LLM refinamento** (só se medium)
Manda últimas 5 msgs (in+out) + score base → Claude Haiku retorna:
```json
{ "adjusted_score": 55, "risk": "medium", "rationale": "Contato pediu pra falar depois do feriado, mas sem sinal de desinteresse" }
```

Output final unified:
```typescript
interface SpamScoreResult {
  score: number;
  risk: "low" | "medium" | "high";
  flags: string[];           // ["3 msgs sem resposta", "última inbound 5d"]
  recommendation: "auto_schedule" | "request_approval" | "internal_reminder_only";
  max_suggested_messages: number;
  rationale: string;         // pra LLM passar pro rep se needed
}
```

---

## 6. Conversation context (LLM lê conversa)

Função `resolveConversationContext(contactId, locationId)`:

1. Busca últimas N (default 20) msgs via GHL `/conversations/messages` + sparkbot_messages (web channel)
2. Filtra ruído (msgs do sistema, auto-replies)
3. Manda pra Claude Haiku resumir em 1-2 parágrafos:
```
SUMMARY PROMPT:
Resuma essa conversa entre rep e contato em ≤200 palavras, focando em:
- Estado atual da negociação/relacionamento
- Última coisa discutida
- Compromissos pendentes (rep prometeu algo? contato prometeu?)
- Tom da última resposta do contato
- Pontos sensíveis (objeções, dúvidas, hesitações)

Mensagens:
{lista de msgs}
```

Saída salva em `followup_sequences.context_summary` (auditável — admin pode ver depois).

---

## 7. Pause-on-reply

Hook no `webhook-handler.ts:processInbound` (ANTES do bot processar):

```typescript
// Já existe um inbound do contato? Pausa sequences ativas
const { onContactInboundReceived } = await import("./followup/sequence-monitor");
await onContactInboundReceived(contactId, locationId);
```

`sequence-monitor:onContactInboundReceived`:
1. Busca sequences `(contact_id, location_id, status IN [scheduled, running], stop_on_reply=true)`
2. Pra cada: marca status=`skipped_reply`, cancelled_reason=`contact_replied_at_*`
3. Marca pending messages como `status=skipped`
4. Insere `followup_events` row `event_type=contact_replied`
5. Cria sparkbot system message pra IA ter contexto na próxima call do rep:
   "[NOTA INTERNA] Sequence X pausada — contato respondeu. Não mande follow-ups manualmente daqui."
6. Notifica rep proativamente via Stevo:
   "Ana respondeu — pausei as próximas msgs da sequência."

---

## 8. Runner

`proactive/followup-runner.ts` (similar bulk-message-runner):
- Cron 30s (reusar mesmo cron do reminder-runner pra economizar Vercel limits)
- Claim atomic dos `followup_messages` com `status='pending' AND scheduled_at <= now()`
- Pra cada msg:
  - Re-check sequence.status === 'running' (race com pause)
  - Re-check stop_on_reply: existe inbound do contato após sequence.scheduled_first_at?
  - Se `requires_final_check=true`: recalcula spam_score; se virou high → marca `skipped`
  - Envia via GHL `/conversations/messages` (mesma function do bulk)
  - Update status sent + sent_at + ghl_message_id
- Quando última msg = sent/failed/skipped: marca sequence.status=`completed`, dispara `sequence-notifier`

---

## 9. Approval flow (adaptive)

`decideFlow(score, settings)`:

```typescript
if (score.risk === "high") {
  // Bloqueia sequence externa. Sugere lembrete interno.
  if (settings.approval_mode === "always_ask") return "request_approval";
  return "block_suggest_internal_reminder";
}

if (settings.approval_mode === "always_ask") return "request_approval";
if (settings.approval_mode === "auto_all") return "auto_schedule";

if (settings.approval_mode === "auto_low_risk") {
  return score.risk === "low" ? "auto_schedule" : "request_approval";
}

// adaptive (default)
if (score.risk === "low") return "auto_schedule";
return "request_approval";
```

Comportamento no chat:
- `auto_schedule`: cria sequence + messages com `approval_status='auto_approved'`. Bot avisa: "✅ Agendei pra você (low risk). Cancelo se quiser."
- `request_approval`: cria sequence + messages com `approval_status='pending_approval'` e `status='draft'`. Runner NÃO pega draft. Rep precisa chamar `approve_followup`.
- `block_suggest_internal_reminder`: NÃO cria sequence. Bot responde: "Conversa tá fria (3 msgs sem resposta). Recomendo só lembrete interno pra você tentar outro canal. Crio?"

---

## 10. Lembrete interno (`type=internal_reminder`)

Diferente de sequence externa: **não manda msg pro contato.** Usa
`assistant_scheduled_tasks` (existing) pra disparar notificação no rep
no horário marcado.

```typescript
if (type === "internal_reminder") {
  await scheduleTask({
    rep_id, location_id,
    task_type: "followup_internal_reminder",
    task_payload: { contact_id, goal, suggested_message },
    next_run_at: scheduledAt,
  });
}
```

Runner `reminder-runner` dispara notif pro rep:
"💡 Lembrete: você queria falar com Ana sobre proposta hoje. Sugestão: '...'"

---

## 11. Notificações (rep)

Reusa pattern de `bulk-completion-notifier`:

| Trigger | Mensagem |
|---------|----------|
| Sequence auto-scheduled (low risk) | "✅ Agendei follow-up pra Ana (2 msgs, primeira amanhã 10h). Responde 'cancelar' se quiser parar." |
| Approval pendente | (apresentado inline na resposta ao create_followup_request) |
| Contato respondeu (pause) | "📩 Ana respondeu. Pausei as próximas msgs do follow-up." |
| Sequence completou | "✅ Follow-up com Ana finalizado — 2/2 enviadas. Sem resposta ainda." |
| Spam recheck bloqueou msg | "⚠️ Não enviei a próxima msg pra Ana — risco subiu (mais 1 msg sem resposta hoje). Quer forçar?" |
| Lembrete interno disparou | "💡 Lembrete: hora de falar com Ana (proposta). Sugestão: '...'" |

---

## 12. Conversational UX (extensão do prompt-builder)

Bloco novo no system prompt:

```
# 🔄 FOLLOW-UP FEATURE (Pedro 2026-05-18)

Quando rep falar:
  - "cria follow-up com X" / "follow-up pra X em N dias"
  - "manda mensagem pro X na sexta sobre Y"
  - "faz uma sequência leve pro X" / "sequência de 3 follow-ups"
  - "me lembra de falar com X" → INTERNAL reminder
  - "todo segunda follow-up com Y" → recurring (não no MVP — fallback pra schedule_recurring_reminder)

CHAME `create_followup_request` com:
  - contact_query: nome/phone que o rep falou
  - requested_at: data/hora (interpreta "sexta 9h" → ISO)
  - sequence_length: 1 se simples ("manda msg"), 2 se "sequência"
  - manual_context: se rep mencionou ("ela disse que falaria com marido")
  - use_conversation_context: deixa undefined SE rep não disse. Tool retorna
    needs_user_decision: true → PERGUNTE "Quer que eu use as últimas conversas
    com X pra deixar a msg melhor?"

Tool retorna 1 de 3 estados:
  1. `approval_required=true` → MOSTRA preview formatado + pergunta "Confirma?"
  2. `auto_approved=true` → MOSTRA "✅ Agendei. Mando X.X em DD/MM HH:MM"
  3. `blocked=true, reason=spam_high` → REPASSE motivo + ofereça `type=internal_reminder`

NUNCA invente quantidade de msgs ou texto sem chamar a tool.
NUNCA confirme agendamento se tool retornou approval_required — sem `approve_followup` nada sai.
```

---

## 13. Plano de fases (commits)

| # | Fase | Conteúdo | LOC estimado |
|---|------|----------|--------------|
| 1 | **Schema** | Migration: 3 tables + agent_configs cols. Aplicar via MCP. | 200 |
| 2 | **Foundation** | `followup/types.ts`, `core.ts` skeleton, `settings-loader.ts`, `safety-checks.ts` | 300 |
| 3 | **Context** | `context-resolver.ts` (busca msgs) + `conversation-summarizer.ts` (LLM Haiku) | 250 |
| 4 | **Spam score** | `spam-score.ts` (regras + LLM ambíguo) | 250 |
| 5 | **Generator** | `sequence-generator.ts` (LLM gera N msgs, tom adaptive) | 250 |
| 6 | **Scheduler** | `sequence-scheduler.ts` (cria sequence + messages no DB) | 200 |
| 7 | **Tools** | 7 tools (create/approve/edit/cancel/pause/resume/list/progress) | 600 |
| 8 | **Runner** | `proactive/followup-runner.ts` + cron Vercel + recheck before send | 350 |
| 9 | **Pause-on-reply** | Hook em webhook-handler + `sequence-monitor.ts` | 200 |
| 10 | **Notifier** | `sequence-notifier.ts` (5 templates) | 200 |
| 11 | **Prompt builder** | Bloco follow-up no system prompt + integração turn-context | 100 |
| 12 | **Dashboard** | Aba "Follow-ups" no `/admin/dashboard` | 300 |
| 13 | **Smoke test** | `scripts/smoke-test-followup.ts` cobrindo 15-20 cenários | 400 |
| 14 | **Docs** | DECISIONS.md (H33+ ranges), CLAUDE.md update, MEMORY.md | 50 |

**Total estimado:** ~3650 LOC em 8-10 commits.

---

## 14. Arquitetura modular pra webhook futuro

`followup/core.ts` exporta UMA função:

```typescript
export async function createFollowupRequest(input: FollowupInput): Promise<FollowupResult> {
  // 1. resolveContext
  // 2. loadSettings
  // 3. runSafetyChecks
  // 4. computeSpamScore
  // 5. generateSequence
  // 6. decideFlow → schedule | request_approval | block
  // 7. persistDraft / persistApproved
  // 8. return structured result
}
```

`FollowupInput` aceita:
```typescript
{
  source: "chat" | "proactive_rule" | "pipeline_webhook" | "manual_admin",
  rep_id, location_id, agent_id,
  contact_id | contact_query,
  goal, manual_context, requested_at,
  sequence_length, tone, type,
  source_metadata?: {                    // futuro
    pipeline_id, stage_id, opportunity_id, event_id
  }
}
```

**Hoje (MVP):** só chat chama (via `create_followup_request` tool).
**Futuro (pós-MVP):** `assistant_proactive_rules` row com `rule_type='followup_on_stage_change'` + dispatcher.ts chama `createFollowupRequest({ source: 'pipeline_webhook', ... })`. **Zero refactor.**

---

## 15. Métricas pra dashboard

Sequence funnel:
- created → approved/auto_approved → scheduled → running → completed
- conversion rate aprovação
- % auto-aprovados (low risk)
- % bloqueados por spam high
- avg sequence_length
- % skipped_reply (sucesso da feature — contato respondeu!)

Por rep:
- followups ativos
- followups criados últimos 7d/30d
- reply rate (sent → contact replied)

---

## 16. Edge cases cobertos

| Caso | Comportamento |
|------|---------------|
| Contato não encontrado | Tool retorna error "contato não achado" — bot pergunta nome/phone completo |
| Múltiplos contatos | Usa disambiguation existing (H30.2) — bot lista top 3 |
| Sem contexto suficiente | Tool retorna `needs_user_decision: use_conversation` — bot pergunta |
| WhatsApp desconectado | safety-check detecta — sugere `internal_reminder` automático |
| Contato com tag dnc/opt-out | spam-score score=0 → bloqueia |
| Já existe sequence ativa pro contato | safety-check retorna error — sugere editar/cancelar existing |
| Spam high (>3 unanswered) | bloqueia, sugere internal_reminder |
| Cap mensal de spend atingido | reusa logic existing billing — bloqueia + signal admin |
| Rep cancela meio do flow | `cancel_followup` marca status=cancelled, runner não pega |
| Rep edita texto | `edit_followup` faz UPDATE no message_text dos pending |
| Mensagem específica falha no envio | Marca essa msg failed, sequence segue (runner não para) |
| Sequence completa sem resposta | Notifier "Finalizado — sem resposta. Sugiro outro canal?" |

---

## 17. Não-objetivos do MVP

- Recurrence (`todo segunda 9h follow-up`) → usa `schedule_recurring_reminder` existing
- Follow-up em massa (filter + sequence pra N contatos) → fase futura
- Multi-canal (email/SMS separado) → MVP só WhatsApp via Stevo
- Botões WhatsApp interactive → quando Meta liberar
- UI direto no GHL (CRM) → MVP só via chat/admin dashboard
- Análise de sentimento profunda → MVP só score híbrido
- Otimização de horário ML → MVP usa quiet_hours existing
- Métricas avançadas (NPS, churn) → fase futura
