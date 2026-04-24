# Account Assistant V1 — Design Doc

**Status:** Aguardando validação do Pedro antes de codar.
**Data:** 2026-04-24
**Target:** MVP funcional em 1.5-2 semanas, arquitetura preparada pra fases V2-V5.

---

## 1. O que é

O **Account Assistant** é o terceiro agente da plataforma. Diferente do sales/recruitment que conversam com **leads**, o Account Assistant conversa com o **rep comercial humano** — é um copiloto de produtividade que mora no WhatsApp do rep e tem braços pra operar o GHL em nome dele.

```
LEAD  <-->  Sales/Recruitment Agent   (já existe)
 ↑
REP   <-->  Account Assistant          (este projeto)
```

## 2. Escopo V1 (MVP)

**O que V1 FAZ:**
- Identifica qual rep está falando pelo número de telefone
- Executa 8 tools básicas no GHL (search/get/note/task/tag/field/list appointments/opportunities)
- Protocolo de confirmação por nível de risco
- Desambiguação ("qual Joao?")
- Memória adaptativa leve (profile JSONB)
- Alerta de no-response (pausa se muitas msgs sem resposta)
- UI de config dedicada + aba de teste

**O que V1 NÃO FAZ (vai pra fases seguintes):**
- Proatividade (briefings pré-reunião, no-show, opportunity parada) — V2
- Scheduler de recorrências ("me lembra amanhã") — V3
- Handoff do sales/recruitment — V4
- Tools complexas: book_appointment, send_message_to_lead, move_pipeline, bulk, undo — V5

---

## 3. Infraestrutura

### 3.1 Sub-account ASSISTANT HUB (GHL)

- **Location ID:** `Cjc1RonkhwcnrMp3vAqt`
- **Company ID:** `TdmQMjj86Y3LgppiB96K` (mesma Spark)
- **Papel:** armazena conversas rep↔assistente como `conversations` normais do GHL
- **Número WhatsApp dedicado:** Pedro vai comprar e configurar Cloud API + Evolution no mesmo número (modo coexist)
- **Contatos na Hub:** cada rep vira um contact quando fala pela primeira vez

### 3.2 Env vars novas

```env
ASSISTANT_HUB_LOCATION_ID=Cjc1RonkhwcnrMp3vAqt
ASSISTANT_HUB_COMPANY_ID=TdmQMjj86Y3LgppiB96K
# Dentro da janela de 24h: WhatsApp Cloud API (oficial, suporta botões/etc)
# Fora da janela: Evolution via endpoint SMS do GHL (burla limite de templates)
# A escolha é automática baseada na última msg do rep
```

### 3.3 Roteamento de mensagens

**Fluxo entrada:**
1. WhatsApp Cloud API OU Evolution manda webhook pro GHL
2. GHL dispara webhook `InboundMessage` pra nossa plataforma
3. Detecto que o `location_id` do payload é o `ASSISTANT_HUB_LOCATION_ID` → roteio pro pipeline do Account Assistant (novo handler, NÃO o `/api/webhooks/inbound-message` dos outros agentes)

**Fluxo saída:**
- Dentro de 24h: `POST /conversations/messages` no GHL com `type=WhatsApp` (oficial)
- Fora de 24h: `POST /conversations/messages` com `type=SMS` (GHL roteia pro Evolution no mesmo número)

---

## 4. Schema de DB (4 tabelas novas)

### 4.1 `rep_identities`

```sql
CREATE TABLE rep_identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           TEXT UNIQUE NOT NULL,               -- normalizado E.164
  display_name    TEXT,                                -- nome vindo do perfil GHL
  -- lista de ghl_user_ids em diferentes locations (um rep pode estar em várias)
  ghl_users       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- [{ location_id, ghl_user_id, location_name, role }]
  active_location_id TEXT,                             -- última location escolhida na sessão
  -- Memória adaptativa: hábitos, preferências, opt-outs
  profile         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Termos de uso aceitos em qual data (null = ainda não aceitou)
  terms_accepted_at TIMESTAMPTZ,
  -- Alertas e contadores
  unanswered_count INT NOT NULL DEFAULT 0,
  unanswered_pause_until TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rep_identities_phone ON rep_identities(phone);
```

### 4.2 `assistant_conversations`

Uma linha por sessão ativa entre rep e assistente. Reutiliza conceito do `conversation_state` mas adaptado pro contexto de copiloto.

```sql
CREATE TABLE assistant_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  ghl_conversation_id TEXT,                            -- ID da conversa no GHL Hub
  -- Pendências (ex: aguardando confirmação de ação ou escolha de location)
  pending_action  JSONB,                               -- { type, tool, args, expires_at }
  pending_clarification JSONB,                         -- { type: "ambiguity"|"location_choice", options }
  -- Tokens em aberto (debounce de rajada)
  pending_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  debounce_expires_at TIMESTAMPTZ,
  -- Últimos turns pra cache/contexto
  last_turn_at    TIMESTAMPTZ,
  turn_count      INT NOT NULL DEFAULT 0,
  -- AI state
  ai_paused_at    TIMESTAMPTZ,
  ai_paused_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assistant_conv_rep ON assistant_conversations(rep_id);
```

### 4.3 `assistant_scheduled_tasks` (placeholder V1, ativo V3)

```sql
CREATE TABLE assistant_scheduled_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id     TEXT NOT NULL,
  -- O que executar quando disparar
  task_type       TEXT NOT NULL,                       -- "reminder" | "recurring_report" | "tool_call"
  task_payload    JSONB NOT NULL,                      -- { tool, args, message_template }
  -- Agendamento
  next_run_at     TIMESTAMPTZ NOT NULL,
  cron_expr       TEXT,                                -- null = one-shot
  status          TEXT NOT NULL DEFAULT 'pending',     -- pending|running|completed|cancelled|failed
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assistant_tasks_due ON assistant_scheduled_tasks(next_run_at) WHERE status = 'pending';
```

### 4.4 `assistant_alert_state` (placeholder V1, ativo V2)

```sql
CREATE TABLE assistant_alert_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  alert_type      TEXT NOT NULL,                       -- "meeting_briefing" | "no_show" | ...
  target_id       TEXT,                                -- id da entidade relacionada (appointment_id, opp_id)
  -- Cooldown anti-spam
  last_fired_at   TIMESTAMPTZ,
  cooldown_until  TIMESTAMPTZ,
  UNIQUE (rep_id, alert_type, target_id)
);
```

### 4.5 `agent_configs` — colunas novas pra Account Assistant

Em vez de criar tabela separada, reaproveitar `agent_configs` com campos opcionais. Admin da location cria um agente tipo `account_assistant` e configura:

```sql
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  -- Whitelist de ghl_user_ids permitidos a falar com o assistente
  allowed_ghl_users    JSONB DEFAULT '[]'::jsonb,
  -- Toggles proatividade (Fase 2)
  alert_toggles        JSONB DEFAULT '{}'::jsonb,
  -- Quiet hours (horário de silêncio)
  quiet_hours          JSONB DEFAULT '{}'::jsonb,
  -- No-response threshold (quando pausar)
  no_response_threshold INT DEFAULT 3,
  -- Modo de confirmação
  confirmation_mode    TEXT DEFAULT 'medium_and_high'; -- 'always'|'medium_and_high'|'high_only'
```

---

## 5. Tool Catalog V1

Cada tool é definida com signature JSON Schema (igual OpenAI/Claude tools API), nível de risco, e handler que chama GHL API.

### 5.1 Níveis de risco

- **🟢 safe** — leitura pura, roda direto sem confirmação
- **🟡 medium** — modifica dados, executa + confirma "feito X"
- **🔴 high** — ações irreversíveis OU que afetam lead, pede confirmação EXPLÍCITA antes (ignora config "never_confirm")

V1 só tem safe + medium. High (send_message_to_lead, delete, bulk) ficam pra V5.

### 5.2 Tools V1

| # | Tool | Nível | Args | Output |
|---|---|---|---|---|
| 1 | `search_contacts` | 🟢 | `query: string, limit?: number` | Array de contacts (id, name, phone, last_conversation) |
| 2 | `get_contact` | 🟢 | `contact_id: string` | Contact completo + opportunities + last notes |
| 3 | `list_appointments` | 🟢 | `when: "today"\|"week", rep_id?: string` | Array de appointments do rep |
| 4 | `list_opportunities` | 🟢 | `filter: { status, min_value?, pipeline_id? }` | Array de opportunities |
| 5 | `create_note` | 🟡 | `contact_id, body: string` | `{ note_id }` |
| 6 | `create_task` | 🟡 | `contact_id, title, due_at, assigned_to?` | `{ task_id }` |
| 7 | `modify_tag` | 🟡 | `contact_id, tag, action: "add"\|"remove"` | `{ success }` |
| 8 | `update_field` | 🟡 | `contact_id, field_key, value` | `{ success }` |

### 5.3 Desambiguação

Quando rep menciona entidade por nome e há múltiplos matches:

1. Tool retorna `{ status: "ambiguous", candidates: [...top 3...] }`
2. Assistente responde: "Achei 3 Joãos. Qual?\n1. João Silva — última conversa 2 dias\n2. João Santos — em Negotiation, R$5k\n3. João Pereira — lead novo"
3. Rep responde "1" ou "o Silva" → tenta match e re-executa tool original com ID resolvido
4. Pending state fica em `assistant_conversations.pending_clarification`

### 5.4 Ranking pra desambiguação

1. Conversa mais recente > mais antiga
2. Match exato no primeiro nome > match parcial
3. Atribuído ao próprio rep > outros
4. Mencionado nos últimos 10 turnos da sessão atual > não mencionado
5. Opportunity aberta com valor > sem opportunity

---

## 6. Fluxo de Processamento

### 6.1 Nova rota: `/api/webhooks/account-assistant`

Rota SEPARADA das outras agentes porque o fluxo é diferente:

```
POST /api/webhooks/account-assistant
  |
  ├─ 1. Verifica que o locationId do payload === ASSISTANT_HUB_LOCATION_ID
  |      (se não, rejeita)
  |
  ├─ 2. Extrai phone do contactId (GHL pode mandar ID, precisa fetch pra pegar phone)
  |
  ├─ 3. Busca rep_identity por phone (ou cria — primeira interação)
  |
  ├─ 4. Se rep.terms_accepted_at é NULL → envia termos de uso + para
  |
  ├─ 5. Se rep tem múltiplas ghl_users e active_location_id é NULL → pergunta qual
  |
  ├─ 6. Inbound vs outbound detection (igual outro webhook)
  |      Só processa inbound
  |
  ├─ 7. Debounce 5s: empurra pending_messages, schedule processGroup
  |
  └─ 8. Worker (waitUntil): processa após debounce
         |
         └─ processAssistantGroup()
```

### 6.2 `processAssistantGroup` (pipeline LLM)

```
1. Carrega rep_identity + assistant_conversation
2. Fetch histórico GHL (últimos 20 turns da conversa)
3. Se há pending_action expirada → descarta
4. Se há pending_action ativa → trata a msg como resposta (confirm/cancel/clarify)
5. Senão, LLM call:
   - System prompt: persona + contexto do rep + memory profile + tools catalog
   - Messages: histórico + msg atual
   - Model: Claude Sonnet 4.6 (fallback GPT-4.1)
   - Tools: 8 tools V1
6. LLM retorna ou:
   a) texto puro → manda pro rep
   b) tool_use → valida risk level + confirmation_mode
      - safe → executa, resultado + narrativa vai pro LLM de novo (multi-turn tool use)
      - medium com confirmation_mode=always → pending_action, pergunta "faço X?"
      - medium sem confirmation obrigatório → executa + loga "feito"
      - high → pending_action sempre, pergunta "confirmo com certeza X?"
   c) multi-tool (LLM pode chamar várias em sequência) → loop até LLM retornar texto final
7. Envia resposta ao rep via GHL
8. Fire-and-forget: atualiza memory profile (extrai preferências do turno)
9. Billing: trackAndCharge
```

### 6.3 Identificação de rep (multi-location)

```typescript
async function identifyRep(phone: string): Promise<RepIdentity> {
  // 1. Busca local
  let rep = await db.rep_identities.findOne({ phone });
  if (rep) return rep;

  // 2. Primeira interação — busca todos os GHL users com esse phone
  //    em TODAS as locations que temos no DB
  const locations = await db.locations.findAll();
  const matches = [];
  for (const loc of locations) {
    const ghlClient = new GHLClient(loc.company_id, loc.location_id);
    const users = await ghlClient.get('/users/', { phoneNumber: phone });
    for (const u of users) matches.push({ location_id: loc.location_id, ghl_user_id: u.id, ... });
  }

  // 3. Cria rep_identity
  rep = await db.rep_identities.insert({
    phone,
    display_name: matches[0]?.name,
    ghl_users: matches,
  });

  return rep;
}
```

Se `matches.length === 0` → rep não é user de nenhuma location. Assistente responde "Olá! Não encontrei seu número cadastrado. Fale com o admin da sua location pra ser autorizado."

---

## 7. Prompt Structure

### 7.1 System prompt (cacheável)

```
# IDENTIDADE

Você é o Account Assistant, um copiloto de produtividade pro REP comercial.
Você NÃO conversa com leads — você conversa com o REP HUMANO (agente de vendas)
via WhatsApp e ajuda ele a operar o CRM (GHL).

# PERSONALIDADE

- Colega de trabalho experiente. Direto, útil, sem gracinha.
- Respostas curtas. Texto corrido, não bullet list. PT-BR coloquial.
- Sem emojis espalhados. Sem "claro!", "com certeza!", "vou te ajudar!".
- Executa ações em silêncio quando possível. Não se gaba.

# CAPACIDADES

Você tem tools pra operar o GHL em nome do rep:
- search_contacts, get_contact, list_appointments, list_opportunities (leitura)
- create_note, create_task, modify_tag, update_field (escrita leve)

Se o rep pedir algo fora desse catálogo, diga que ainda não consegue fazer.

# PROTOCOLO DE RISCO

- Leitura: executa direto, responde com a info.
- Escrita leve (note/task/tag/field): executa + responde "feito [X]".
- Escrita pesada (mandar msg pra lead, deletar, bulk): NÃO DISPONÍVEL ainda,
  diga "essa ainda não tá liberada".

# DESAMBIGUAÇÃO

Se o rep mencionar contato/lead por nome e existir múltiplos, liste 2-3 candidatos
com contexto (última conversa, estágio, valor da opp) e pergunta qual.
Nunca "chuta" no top-1 se não tiver confiança alta.

# MEMÓRIA

[Injetado dinamicamente do rep.profile:]
- Preferências: ...
- Hábitos observados: ...
- Opt-outs: ...

# CONTEXTO ATUAL

Rep: {rep.display_name}, {rep.active_location_name}
Horário local do rep: {agora no timezone da location}
```

### 7.2 Runtime context (dinâmico, não cacheado)

```
## ÚLTIMOS ACONTECIMENTOS (últimas 2h)
- 3 msgs de leads sem resposta (João Silva, Maria, Pedro Santos)
- 1 appointment hoje às 14h (Ana Souza)
- 2 opportunities em estágio Negotiation

## MENSAGEM ATUAL
{rep disse o quê agora}
```

### 7.3 Memória adaptativa (após cada conversa)

Fire-and-forget job que roda depois de responder:

```
Input: últimos 6 turnos da conversa + perfil atual
Prompt: "Extraia preferências observadas deste rep em JSON: tom (formal/casual), 
         horário preferido, opt-outs, padrões. Só adicione ao JSON se tiver evidência clara."
Output: merge com rep.profile
```

---

## 8. UI em `/agents/account-assistant`

### 8.1 Página de config (nova, não reaproveita sales)

**Abas:**
1. **Identidade** — nome do assistente, persona curta
2. **Whitelist de Reps** — lista de ghl_users autorizados. Busca por nome + seleciona
3. **Regras** — confirmation_mode, no_response_threshold, quiet_hours
4. **Proatividade** (greyed out, "em breve") — toggles pra V2
5. **Teste** — chat igual sales/recruitment mas emula conversa de rep
6. **Atividade** — lista conversas recentes rep↔assistente, tokens, custos

### 8.2 Componentes reaproveitados

- `agent-tester.tsx` → adaptar pra mostrar "Rep (simulado)" em vez de "Lead"
- `tone-sliders.tsx` → opcional, simplificado
- Estrutura de activity/billing do sales

### 8.3 Componentes novos

- `rep-whitelist-editor.tsx` — autocomplete dos GHL users da location
- `confirmation-mode-selector.tsx`
- `quiet-hours-editor.tsx`

---

## 9. Billing

Reaproveita `trackAndCharge` existente. Cada interação rep↔assistente (que gera call de LLM) loga em `usage_records` com `action_type = 'account_assistant_turn'`.

Markup 20% igual outros. Cobrança via GHL wallet da location do rep (se tiver múltiplas, cobra da `active_location_id`).

---

## 10. Alerta de No-Response

**Gatilho:** assistente mandou msg ao rep, rep não respondeu em X horas.

**Lógica:**
```
Após cada msg do assistente pro rep:
  - Agenda check em (threshold * 1h). Ex: threshold=3 → check em 3h
  - No check: se rep respondeu, cancela. Se não, incrementa unanswered_count
  - Se unanswered_count >= threshold (default 3):
    - Pausa assistente pro rep (unanswered_pause_until = now + 24h)
    - Manda msg final: "Tá difícil falar contigo. Vou pausar os alertas automáticos por 24h. 
      Quando quiser retomar, me manda oi que eu volto."
  - Reset ao receber msg inbound do rep
```

---

## 11. Termos de Uso (texto completo)

Enviado automaticamente no PRIMEIRO contato do rep, antes de qualquer outra funcionalidade.

```
Oi! Sou o assistente da sua conta na {nome_da_agencia}.

Antes de começar, só pra você saber como funciona:

1. ACESSO AO SEU CRM
   Consigo consultar e modificar dados dos seus contatos, oportunidades, 
   tarefas e agenda no GoHighLevel — sempre respeitando as permissões 
   que você já tem por lá.

2. O QUE EU FAÇO
   Executo ações que você me pedir em linguagem natural (texto ou áudio). 
   Exemplos: "adiciona nota no João", "cria tarefa pra ligar amanhã", 
   "quais opportunities tão abertas?".

3. O QUE EU ANOTO DE VOCÊ
   Com o tempo, vou aprendendo suas preferências (tom que gosta, 
   horários que responde, leads importantes pra você) pra ficar mais 
   útil. Isso fica salvo de forma privada, só associado a você.

4. O QUE PODE DAR ERRADO
   Sou uma IA. Às vezes erro interpretando pedidos. Por isso, em ações 
   que mudam algo importante, eu confirmo antes. Se algo sair errado, 
   me fala e eu tento reverter.

5. LIMITES
   Não mando mensagens pros seus leads sem você confirmar. 
   Não apago nada sem você confirmar. 
   Não falo com mais ninguém sobre você ou seus contatos.

6. PARAR DE USAR
   É só mandar "parar" ou "desativar" que eu silencio. 
   Pra apagar tudo que sei sobre você, manda "apagar meus dados" 
   que o admin da sua conta remove.

Tá ok? Responde "aceito" pra gente começar.
```

Se rep responder "aceito" (ou equivalente: "ok", "sim", "pode", "beleza"):
- Seta `rep.terms_accepted_at = now()`
- Responde "Beleza. Pode me pedir o que precisar."

Se responder "não" ou algo negativo:
- Não seta terms_accepted_at
- Responde "Entendi. Se mudar de ideia, é só chamar. Tchau!"
- Não responde mais nada até ele aceitar

Se responder qualquer outra coisa:
- Repete os termos em versão curta: "Manda 'aceito' pra começarmos, ok?"

---

## 12. Plano de implementação (sequencial)

### Semana 1

**Dia 1** — Migrations + tipos TypeScript
- Migration 00029_account_assistant_schema.sql com 4 tabelas + colunas em agent_configs
- `src/types/account-assistant.ts` com RepIdentity, AssistantConversation, ToolCall, etc

**Dia 2-3** — Webhook + identificação
- `/api/webhooks/account-assistant/route.ts` — filtra por location, identifica rep
- `src/lib/account-assistant/identity.ts` — lookup/create rep
- `src/lib/account-assistant/terms.ts` — fluxo de aceite de termos

**Dia 4-5** — Tool catalog + executor
- `src/lib/account-assistant/tools/*.ts` — 8 handlers
- `src/lib/account-assistant/tool-registry.ts` — schemas + dispatcher
- `src/lib/account-assistant/disambiguation.ts` — ranking + clarification flow

**Dia 6-7** — Prompt + LLM pipeline
- `src/lib/account-assistant/prompt-builder.ts` — system + runtime + memory
- `src/lib/account-assistant/processor.ts` — pipeline completo com multi-turn tool use
- Integração trackAndCharge

### Semana 2

**Dia 1-3** — UI
- `/agents/account-assistant/page.tsx` + `account-assistant-config-content.tsx`
- Componentes novos: whitelist-editor, confirmation-mode-selector, quiet-hours-editor
- Adaptação do agent-tester pra simular rep

**Dia 4-5** — No-response alert + memória adaptativa
- Cron/scheduler pra check de no-response
- Job de memory update fire-and-forget

**Dia 6-7** — Testes internos + deploy
- 1 rep teste (você, Pedro)
- Ajustes de prompt conforme feedback
- Deploy prod com feature flag

---

## 13. Decisões (alinhadas com Pedro em 2026-04-24)

- [x] **Nome do assistente:** `Sparkbot` (global, não configurável por location). Aparece em todo o prompt/identidade.
- [x] **Input multimodal:** aceita texto, áudio (Whisper), imagem (base64 pro LLM), e documento (PDF/docx via `pdf-parse`/`mammoth`). Reaproveita `audio-transcriber.ts`, `media-extractor.ts`, `media-processor.ts` que já existem.
- [x] **Formato de data/hora:** seguir timezone da `active_location_id` do rep, usar o formato regional da location (US → AM/PM, BR → 24h).
- [x] **Multi-location:** usa `active_location_id`; se null, pergunta qual location. Set at login ou primeira ação relevante.
- [x] **Escopo V1 enxuto:** `assistant_scheduled_tasks` e `assistant_alert_state` ficam de fora agora — entram nas migrations de V2/V3 quando realmente forem usadas. V1 só cria `rep_identities` + `assistant_conversations` + colunas em `agent_configs`.

---

## 14. Riscos & Mitigações

| Risco | Mitigação |
|---|---|
| LLM executa tool errada em massa | Confirmation protocol obrigatório pra tools medium+ |
| Desambiguação falha e modifica contato errado | Nunca age em entidade não identificada; sempre pede escolha |
| Rep vaza credenciais/dados no chat | Nada a fazer — infra do WhatsApp/GHL protege; logs locais não expõem |
| Custo de tokens explode com conversas longas | Compressão de histórico (igual sales_agent) quando > 20 turns |
| Race condition com múltiplas msgs rápidas | Debounce 5s + pending_messages JSONB |
| WhatsApp fora de 24h janela falha | Fallback automático pra SMS via Evolution |

---

## Conclusão

V1 entrega um assistente funcional que faz 80% do que o rep precisa no dia-a-dia operando o CRM. Fica preparado pra V2 (proatividade) sem refactor — os schemas `assistant_scheduled_tasks` e `assistant_alert_state` já existem como placeholder.

**Aguardo aval do Pedro pra começar implementação.**
