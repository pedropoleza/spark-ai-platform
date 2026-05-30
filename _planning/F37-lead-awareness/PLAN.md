# F37 — Lead Awareness + Handoff Inteligente

> Pedro 2026-05-29. Os agentes lead-facing (Sales, Recruitment, Custom)
> precisam saber o histórico de um contato no Spark Leads ANTES de responder.
> E precisam decidir se respondem ou notificam o rep humano via SparkBot.

## 1. Problema atual

Hoje quando o agente lead-facing recebe uma msg:
1. Lê `conversation_state` (estado da conversa com o BOT, criado quando começou
   a atender esse contato).
2. Lê `messages` table (últimas 30 mensagens trocadas COM O BOT).
3. Gera resposta.

**Problema**: se o contato JÁ EXISTIA antes do agente ser habilitado, o bot
ignora o histórico completo do Spark Leads — não sabe se o rep já conversou,
em que etapa do funil ele está, se tem notas relevantes, ou se essa pergunta
já foi respondida humano.

Casos comuns que dão problema:
- Lead que já tava conversando com o rep, agente ativa, lead manda nova msg:
  bot pergunta "qual seu nome?" mesmo que já existe há semanas.
- Lead acabou de assinar (no GHL, opp em "Customer Won"): bot atende como
  se fosse novo lead, oferece produto.
- Lead com observação interna "Atenção: cliente VIP, sempre passa direto":
  bot ignora e atende como qualquer um.

## 2. Solução

Sistema em duas camadas:

### Camada A — Lead History Awareness
- Antes de chamar LLM, busca histórico do contato no Spark Leads/GHL:
  - Últimas N msgs do conversation (inbound + outbound)
  - Notas (observações) do contato
  - Opportunities + stage atual
  - Tags
- Resume isso em uma seção do system prompt: "HISTÓRICO ANTERIOR DO LEAD"
- Bot agora SABE em que ponto a conversa parou.

### Camada B — Handoff Inteligente
- Antes de gerar resposta, avalia heurísticas:
  1. **Rep respondeu manualmente** nas últimas X horas? → silencia, não atrapalha
  2. **Lead pediu "falar com humano"** explicitamente? → silencia + notifica rep
  3. **Conversa em ponto delicado** (preço final, decisão, reclamação)? → notifica
  4. **Opp em stage "fechado"**? → silencia
  5. Caso contrário → responde normalmente
- Quando decide NÃO responder, notifica o rep dono via SparkBot:
  - Identifica rep dono (assignedTo do contato → fallback opp.assignedTo → fallback location reps com is_internal)
  - Insere msg no SparkBot do rep com o contexto + sugestão de ação

## 3. Decisões arquiteturais

| # | Decisão | Escolha | Motivo |
|---|---------|---------|--------|
| D1 | Onde rodar o fetch do histórico? | No queue-processor pré-LLM, paralelo com outras fetches | Reusa código existente, não duplica |
| D2 | Cache de histórico? | 5min memória + invalidate em new inbound | Evita N fetch por turn longo |
| D3 | Quantas msgs trazer? | 20 últimas (config: 10-50) | Balance contexto vs tokens |
| D4 | Sumarizar histórico? | Não na v1 — passa raw com formato compacto | Simplicidade; LLM compete bem |
| D5 | Opt-in por agente? | Sim, toggle em `agent_configs.lead_history_enabled` (default FALSE) | Retrocompat — agentes existentes não mudam |
| D6 | Heurísticas hardcoded ou config? | Hardcoded com toggles default-on | Pedro pode customizar via flag se precisar |
| D7 | Como identificar rep dono? | GHL `contact.assignedTo` → opp.assignedTo → fallback `rep_identities` com is_internal=false na location | Multi-camada |
| D8 | Onde armazena policy de handoff? | `agent_configs.handoff_policy` JSONB | Flexível, mesmo padrão |
| D9 | Notification via SparkBot — que método? | `deliverProactiveMessage` do hub | Reusa pipeline existente |
| D10 | Idempotência de handoff notification? | (contact_id + reason) últimos 4h | Evita spam pro rep |

## 4. Schema (Etapa 0)

Migration `00096_lead_awareness_handoff.sql`:

```sql
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS lead_history_config JSONB DEFAULT '{
    "enabled": false,
    "messages_count": 20,
    "include_notes": true,
    "include_opportunities": true,
    "include_tags": true
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS handoff_policy JSONB DEFAULT '{
    "enabled": false,
    "skip_if_human_replied_within_minutes": 60,
    "skip_if_lead_requested_human": true,
    "notify_rep_via_sparkbot": true,
    "notify_on_opp_stage_closed": true,
    "custom_keywords_handoff": ["humano", "atendente", "pessoa", "falar com alguém"]
  }'::jsonb;

CREATE TABLE IF NOT EXISTS handoff_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  rep_id UUID,
  reason TEXT NOT NULL,
  trigger_message TEXT,
  sparkbot_message_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(location_id, contact_id, reason, created_at)
);

CREATE INDEX idx_handoff_notifications_recent
  ON handoff_notifications(location_id, contact_id, created_at DESC);
```

## 5. Etapas

### Etapa 0 — Schema + types
- Migration 00096
- Types: `LeadHistoryConfig`, `HandoffPolicy`, `LeadContext`, `HandoffDecision`
- Update `AgentConfig` type

### Etapa 1 — Lead History Loader
- Arquivo `src/lib/queue/lead-history.ts`
- Função `loadLeadHistory(contactId, companyId, locationId, config)`:
  - GHL `/contacts/{id}` — pega contato + tags + customFields + notes
  - GHL `/conversations/search?contactId=X` — pega convs
  - GHL `/conversations/{convId}/messages` — pega N msgs
  - GHL `/opportunities/search?contactId=X` — pega opps
- Cache 5min in-memory
- Retorna `LeadContext` estruturado:
  ```ts
  {
    contact: { name, phone, tags, customFields },
    recent_messages: [{ direction, body, dateAdded, source }],
    notes: [{ body, dateAdded, userId }],
    opportunities: [{ id, name, stage, status, monetaryValue }],
    last_human_outbound_at: string | null,
    has_active_opp: boolean,
  }
  ```

### Etapa 2 — Pre-LLM Gate (Should-Respond Decision)
- Arquivo `src/lib/queue/should-respond.ts`
- Função `evaluateShouldRespond(leadContext, currentMessage, policy)`:
  - Checa cada heurística em ordem
  - Retorna `{ decision: "respond" | "skip", reason?, notify_rep?: bool, suggested_msg_to_rep?: string }`

Heurísticas (configuráveis):
1. **Human replied recently**: última msg outbound do GHL com `source !== 'api'` AND dateAdded < `skip_if_human_replied_within_minutes` min → skip + notify
2. **Lead requested human**: regex em `custom_keywords_handoff` → skip + notify
3. **Opp in closed stage**: opp.status in `['won', 'lost']` → skip silently
4. **Default**: respond

### Etapa 3 — Integração queue-processor
- Após targeting check, antes do LLM:
  - Se `config.lead_history_config.enabled`, chama `loadLeadHistory`
  - Se `config.handoff_policy.enabled`, chama `evaluateShouldRespond`
  - Se skip → chama `notifyRepViaSparkbot` (se policy ON) + log + return
  - Senão → procede normal, mas passa `leadContext` pro prompt-builder

### Etapa 4 — Prompt-builder
- Nova função `buildLeadHistorySection(leadContext)` em `sales-prompt-builder.ts`
- Insere antes de "INSTRUÇÕES DO ADMINISTRADOR":
  ```
  ## HISTÓRICO ANTERIOR DESSE LEAD (do Spark Leads)
  
  Tags: vip, jogo_14_05
  Funil: "Pipeline Comercial" → Stage "Em qualificação"
  Última msg outbound (rep humano em 2026-05-25):
    "Maria, te mando o material ainda hoje, ok?"
  Última msg inbound (lead em 2026-05-26):
    "Recebeu o material? Quero saber o preço"
  
  Notas internas:
    - Lead indicada pelo cliente João Silva (2026-05-20)
    - Já fez cotação concorrente em outra agência
  
  USE ESSE HISTÓRICO pra responder coerente. NÃO pergunte coisas que
  já estão respondidas. Reconheça a continuidade.
  ```

### Etapa 5 — Handoff Notification via SparkBot
- Arquivo `src/lib/queue/handoff-notify.ts`
- Função `notifyRepViaSparkbot(decision, leadContext, agent, supabase)`:
  1. Resolve rep dono: `contact.assignedTo` (GHL user id) → find `rep_identities` com esse `ghl_user_id` (em `ghl_users` array)
  2. Fallback: opp owner
  3. Fallback: rep_identities da location com is_internal=false e terms_accepted
  4. Insere row em `handoff_notifications` (UNIQUE: contact_id+reason+timestamp_truncated → idempotent dentro de 4h)
  5. Insere msg em `sparkbot_messages` role=agent + manda via deliverProactiveMessage
  6. Msg template:
     ```
     📩 *Lead [Nome do contato]* mandou agora:
     "[última msg do lead]"
     
     Não respondi porque: [reason em PT-BR claro]
     
     Quer que eu responda alguma coisa, ou prefere atender você mesmo?
     ```

### Etapa 6 — UI
- Detail-view: nova Cat "Histórico & Handoff" no grupo Comportamento
  - Toggle "Carregar histórico do Spark Leads"
  - Slider: número de msgs (10-50)
  - Toggles: incluir notas / opps / tags
  - Toggle "Handoff inteligente: avalia se devo responder"
  - Slider: min minutos desde última msg humana
  - Textarea: keywords que disparam handoff
- Wizard custom: step rápido "Quer que o agente leia conversas antigas?" Yes/No
- Lead-only Cat

### Etapa 7 — Test + deploy
- Test unit: `lead-history.test.ts`, `should-respond.test.ts`
- Script: `scripts/test-lead-awareness.ts` — simula 3 cenários
- TSC + build + commit + deploy

## 6. Arquivos novos/modificados

**Novos:**
- `supabase/migrations/00096_lead_awareness_handoff.sql`
- `src/lib/queue/lead-history.ts`
- `src/lib/queue/should-respond.ts`
- `src/lib/queue/handoff-notify.ts`
- `scripts/test-lead-awareness.ts`

**Modificados:**
- `src/types/agent.ts` — `LeadHistoryConfig`, `HandoffPolicy`, `AgentConfig`
- `src/lib/queue/queue-processor.ts` — integração
- `src/lib/ai/sales-prompt-builder.ts` — `buildLeadHistorySection`
- `src/app/hub/agents/[agentId]/agent-detail-view.tsx` — Cat nova
- `src/app/hub/agents/new/[template]/agent-wizard.tsx` — step opcional
- `src/lib/utils/validation.ts` — zod schemas
- `CLAUDE.md` + HANDOFF.md — docs

## 7. Riscos & mitigação

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| GHL API rate limit | Baixa | Médio | Cache 5min; degrade-gracefully (sem histórico) se falhar |
| Token explosion (histórico longo) | Média | Alto | Cap 20 msgs default; truncate body em 300 chars |
| Bot ainda responde quando devia silenciar | Média | Alto | Conservative defaults; flag opt-in; log decision pra audit |
| Notificação spam pro rep | Média | Alto | Idempotência via handoff_notifications UNIQUE + 4h cooldown |
| Histórico tem dados sensíveis vazando pra outro contexto | Baixa | Alto | Lead context só lido pra esse contato; nunca cross-contact |
| `assignedTo` GHL aponta pra user que não tem rep_identity | Alta | Médio | Fallback cascata; sem notification se nenhum rep achado |

## 8. Como reativar/testar incrementalmente

Sequência segura:
1. Schema deploy → não afeta nada
2. Code deploy com flags OFF → não afeta nada
3. Liga `lead_history_config.enabled=true` num agente teste → testa histórico
4. Liga `handoff_policy.enabled=true` → testa decisões
5. Se ok, libera pra outros agentes

Default OFF garante zero impacto em produção até admin decidir habilitar.

## 9. Observabilidade

- `execution_log` action_type novos:
  - `lead_history_loaded` — count msgs/notes/opps carregados, tempo de fetch
  - `should_respond_decision` — decision + reason + rep_id
  - `handoff_notification_sent` — rep_id, sparkbot_msg_id
- Signals novos:
  - `should_respond_skip_rate_high` — se >50% das msgs são skipadas em 1h → alerta
  - `handoff_notification_failed` — sparkbot send falhou
