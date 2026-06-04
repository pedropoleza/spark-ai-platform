# GHL UI — Controles do Agente de IA (custom JS/CSS injetado)

> Pedro 2026-06-04. Injeção de controles do agente lead-facing direto na UI do
> Spark Leads (GHL), nas telas de **contato** e **conversations**, quando a
> location tem agente ativo. Custom JS colado no app GHL (ou na agência).

## Objetivo

Quando o contato tem um **agente de vendas/lead-facing ligado**, o user faz, sem sair do Spark Leads:
1. **Desligar/religar o agente** pra aquele contato.
2. **Feedback** (👍 / 👎) por mensagem do agente.
3. **Digitar a resposta preferida** quando dá 👎.

## Grounding — inspeção ao vivo do GHL (2026-06-04)

Inspecionei a tela de contato (`/contacts/detail/{contactId}`) via browser. Achados que ditam a arquitetura:

- **A injeção JÁ é provada**: o botão "Abrir SparkBot" do loader atual
  (`src/app/embed/sparkbot/loader/route.ts`) já aparece injetado no header.
  Mesma técnica (fetch + `new Function` + inject `<style>` + MutationObserver).
- **DOM OFUSCADO**: a árvore de acessibilidade não expõe ids/classes estáveis —
  dezenas de `button [ref_N]` sem nome, "Icon only button". ⇒ **seletores
  precisam ser resilientes**: contexto via URL, âncoras por TEXTO visível
  ("Responder", "Call", "Type a message..."), posição estrutural, e
  MutationObserver pra re-injetar quando o Vue re-renderiza.
- **URLs estáveis carregam o contexto**:
  - Contato: `/v2/location/{loc}/contacts/detail/{contactId}` → contactId direto.
  - Conversations: `/v2/location/{loc}/conversations/conversations/{conversationId}`
    → só conversationId; precisa **mapear conversationId → contactId** (API GHL `/conversations/{id}` ou DOM).
- **Layout do contato**: 3 colunas — campos à esquerda (e **já existe um campo
  "AI Status" = Active**), conversa no meio (toolbar topo com Call/chat/phone),
  appointments à direita.
- **Cada mensagem** tem ações hover **Responder / Reagir / Editar / Deletar** →
  ponto natural pra anexar 👍/👎 (perto, ou um 5º botão).
- **É JS + CSS** — CSS injetado via `<style>` pelo próprio JS (igual o loader).
  Não é CSS-only: precisa de lógica (detectar contexto, fetch status, montar UI,
  chamar API, tratar re-render). CSS só pra estilo/posição.

## Arquitetura

### Entrega
- **Estender o loader existente** com um módulo novo (`agent-controls`), OU 2º
  loader dedicado. Recomendação: módulo no MESMO loader — ele já roda em toda
  página GHL, já detecta locationId, já autentica. Menos snippets pro Pedro colar.
- Snippet vai no **Custom JS** do app GHL Marketplace (preferido) ou na agência.

### Auth
- Reusar o fluxo do loader: `POST /api/sparkbot/check-admin` → JWT per-rep.
  Chamadas novas usam esse Bearer. CORS já liberado (`Access-Control-Allow-Origin: *`).
- ⚠️ **Decisão**: o check-admin hoje só passa ADMIN (fix de segurança 2026-05-26).
  Pra um REP comum operar os controles na tela dele, precisa de um gate
  "qualquer user válido da location" (não admin-only). Provável: endpoint de auth
  separado/relaxado SÓ pra esses controles (escopo: pausar/feedback do próprio
  contato), sem expor o que o check-admin protege (entitlements/billing).

### Backend — endpoints novos
| Endpoint | O quê |
|---|---|
| `GET /api/agents/contact-status?locationId&contactId` | `{ hasActiveLeadAgent, agentId, agentName, paused, pausedReason }` — decide se mostra os controles + estado do toggle |
| `POST /api/agents/contact-pause` `{ contactId, agentId, paused }` | set/clear `conversation_state.ai_paused_at` (reason `manual_ui:user_X`) |
| `POST /api/agents/message-feedback` `{ agentId, contactId, aiMessage, rating, suggestion? }` | insert em `agent_feedback` |

### Modelo de dados — REUSA o que já existe (zero schema novo no MVP)
- **Pause**: `conversation_state.ai_paused_at`. O runtime JÁ respeita
  (queue-processor: skip se `ai_paused_at` setado). Fonte da verdade do liga/desliga.
- **Feedback**: tabela `agent_feedback` (rating, ai_message, suggestion) JÁ EXISTE
  e **já é carregada no prompt** (`sales-prompt-builder` seção feedback, limit 20).
  ⇒ o loop fecha sozinho: rep dá 👎 + "preferia assim" → entra no prompt → agente melhora.

## Frontend — injeção

### Detecção de contexto (resiliente, SPA-aware)
- Watcher de `location.pathname` (poll 1-2s, igual loader) → classifica a tela
  (contact detail / conversations) + extrai loc + contactId/conversationId da URL.
- MutationObserver no container da conversa → re-injeta quando o GHL re-renderiza
  (troca de contato, scroll virtualizado, etc.).

### Pontos de injeção
1. **Toolbar topo da conversa** (perto do "Call"): pill **"🤖 Agente: LIGADO / DESLIGADO"**
   — clica → toggle pause (confirm rápido). Cor por estado. Só aparece se
   `hasActiveLeadAgent`.
2. **Por mensagem DO AGENTE** (ao lado de Responder/Reagir): **👍 / 👎**. No 👎 abre
   um input inline "Como você preferia essa resposta?" → salva como `suggestion`.

### O ponto mais difícil (Pedro tem razão que é complicado)
Identificar **quais mensagens são do agente** (pra colocar feedback só nelas):
- Mensagens outbound no GHL incluem as do agente **E** as de humanos (rep).
- O texto do bubble está num DOM ofuscado.
- **Solução**: a injeção lê os bubbles (texto + direção), e o `contact-status`/um
  endpoint auxiliar devolve as mensagens que a IA mandou (de `execution_log`
  send_message / nossos registros). Cruza por texto (anti-eco, igual F52) + timestamp
  pra marcar só as do agente. Feedback grava `ai_message` = texto exato (pra casar no prompt).

## As 3 funcionalidades (fluxo)

**1. Desligar/religar agente**
Pill no topo → clica "DESLIGADO" → `POST contact-pause {paused:true}` → set
`ai_paused_at` → runtime para de responder aquele contato. Religar limpa.
(É o "user gerencia a pausa" que o Pedro pediu — substitui o despause manual no banco.)

**2. Feedback 👍/👎 por mensagem**
Hover na msg do agente → 👍/👎 → `POST message-feedback {rating}`. 👍 reforça;
👎 abre o passo 3.

**3. Resposta preferida (no 👎)**
Textarea "como você preferia?" → `POST message-feedback {rating:'negative', suggestion}`
→ vai pro `agent_feedback.suggestion` → entra no prompt das próximas → agente corrige o tom/conteúdo.

## Decisões (RESOLVIDAS — Pedro 2026-06-04)
1. **Mecanismo de pause** ✅ **Botão STANDALONE custom na UI**, baseado SÓ em
   `conversation_state.ai_paused_at`. **NÃO** usar o campo "AI Status" do GHL — ele
   só existe nessa conta (Five Star); outras locations não têm. O botão injetado é
   a ÚNICA fonte de exibição (mostra LIGADO/DESLIGADO lendo nosso `ai_paused_at` via
   `contact-status`). Zero dependência de custom field do GHL → funciona em qualquer
   location. Reason ao pausar: `manual_ui:user_X`.
2. **Auth** ✅ gate "qualquer user válido da location" (não admin-only) — o rep que
   atende o lead precisa usar. Escopo restrito: só pausar/feedback do contato da tela.
3. **Entrega** ✅ estender o loader atual (módulo `agent-controls`).

## Riscos & mitigações
- **DOM ofuscado muda entre versões do GHL** → seletores quebram. Mit.: múltiplos
  fallbacks por texto/estrutura + MutationObserver + watcher + telemetria
  "injeção falhou" (sinal admin) + kill-switch via env.
- **Não quebrar o GHL do cliente** (é a UI de produção deles). Mit.: tudo ADITIVO,
  try/catch em todo handler, namespacing de CSS, kill-switch.
- **Distinguir msg do agente vs humano** (feedback). Mit.: cruzar com nossos
  registros (anti-eco F52) antes de mostrar 👍/👎.
- **Conversations screen**: mapear conversationId→contactId (API GHL).
- **Auth/PII**: controles operam só sobre o contato da tela; nenhum dado sai pra
  destino externo; JWT per-rep.

## Fases
- **F1 — Backend**: 3 endpoints (status / pause / feedback) + reuso de
  conversation_state + agent_feedback + auth-gate. Testes.
- **F2 — Loader módulo (tela contato)**: detecção de contexto + pill de status +
  toggle pause. Smoke na tela de contato.
- **F3 — Feedback por mensagem**: 👍/👎 + sugestão; identificação de msg-do-agente.
- **F4 — Tela conversations**: paridade + conversationId→contactId.
- **F5 — Hardening**: fallbacks de seletor, kill-switch, telemetria de injeção,
  smoke supervisionado ao vivo no browser do Pedro.

## Notas
- A inspeção ao vivo (browser do Pedro via Chrome MCP) é viável e será usada em
  cada fase de frontend pra nailing os seletores reais.
- Nada disso toca o caminho lead-facing de runtime além de LER/SETAR
  `ai_paused_at` e INSERIR `agent_feedback` — superfícies já existentes e seguras.
