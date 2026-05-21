# SparkBot — Acompanhamento Guiado (outreach 1-por-vez) · plano
### FORGE-3 · 2026-05-21

> 🤖 Claude · 👤 Pedro · 🤝 Híbrido. Saiu da operação do Gustavo Couto (M0): o
> fluxo de "resumir + mandar pra N contatos" em LOTE travava (timeout 60s, "diz 4
> manda 2"). Pedro definiu o fluxo ideal: **1 contato por vez, com botão
> Confirmar/Editar/Pular; confirmar dispara e já vai pro próximo**; + opção de
> "mandar tudo de uma vez". Estado **stateful** (decisão D, 2026-05-21).

---

## 1. Por que (problema)
"Resumir/mandar pra N contatos" num turno só = N×(search_conversations +
get_conversation_history) + drafting → estoura o timeout de 60s e trava sem
resposta. Lote grande é lento e o LLM corta no meio (cap de 10 iterações +
execução sequencial das tools). **Solução:** quebrar em passos de 1 contato
(turno pequeno, rápido, sem timeout) + estado persistido pra não perder a posição.

## 2. Fluxo (visão do Pedro)

**Modo A — um por vez (padrão):**
1. Rep: "faz o acompanhamento da M0" → bot resolve a lista (N contatos) e abre uma SESSÃO.
2. Pra cada contato (turno pequeno): bot rascunha a msg sugerida e mostra
   `present_options`:
   > **[3/12] Carla H.** — sugiro: *"Oi Carla, conseguiu agendar a prova?…"*
   > `[Confirmar e enviar ✅]` `[Editar ✏️]` `[Pular ⏭️]`
3. **Confirmar** → dispara/agenda pra Carla → marca item `sent` → retorna o PRÓXIMO contato (mesma resposta).
   **Editar** → bot pede o texto → rep digita → dispara ESSE → próximo.
   **Pular** → marca `skipped` → próximo.
4. Fim: "9 enviados, 2 pulados — acabou a M0 🎉".

**Modo B — tudo de uma vez:** rep fala "manda pra todos" → dispara o restante em
massa (reusa Bulk V2 + disclaimers quente/fria). Marca todos `sent`.

**Por que resolve:** cada passo = 1 contato → turno pequeno, rápido, **sem timeout**.
Estado na sessão → bot nunca perde a posição (mesmo em lista de 30+).

## 3. Decisões (fechadas + pendências)
| ID | Decisão | Estado |
|----|---------|--------|
| D1 | Estado **stateful** (tabela sessão + itens com cursor). | ✅ Fechada |
| D2 | Botões por contato: **Confirmar + Editar + Pular**. | ✅ Fechada |
| D3 | **Drafting da msg**: leve-personalizado (nome + segmento + objetivo do rep), SEM puxar histórico por padrão (velocidade); histórico só se o rep pedir contexto. Recomendo. | 🟡 confirmar |
| D4 | **Timing**: no início, bot pergunta 1× "mando agora ou agendo (ex: amanhã 9h)?". Se agendar, escalona (+2min por contato, como o Gustavo já fazia). | 🟡 confirmar |
| D5 | **1 sessão ativa por rep**. Nova "faz acompanhamento" com sessão ativa → bot oferece retomar ou recomeçar. | 🟡 confirmar |

## 4. Arquitetura

**4.1. Schema (migration aditiva):**
- `guided_outreach_sessions`: id, rep_id, location_id, agent_id, goal (intenção/contexto), status (`active`|`completed`|`cancelled`), send_mode (`now`|`scheduled`), schedule_anchor_at, total, sent_count, skipped_count, created_at, updated_at.
- `guided_outreach_items`: id, session_id, position, contact_id, contact_name, contact_phone, suggested_message, final_message, status (`pending`|`sent`|`skipped`), decided_at. UNIQUE(session_id, contact_id).
- **Cursor = primeiro item `pending` por position** (derivado, sem drift).

**4.2. Tools (LLM):**
- `start_guided_outreach({ filter?|contact_ids?, goal, send_mode?, schedule_at? })` → resolve lista (filter-engine, cap defensivo), cria sessão + itens, retorna `{ session_id, total, first_contact }`. Bot rascunha a msg do 1º e apresenta.
- `outreach_decision({ action: 'confirm'|'skip', message? })` → acha a sessão ATIVA do rep, aplica no item corrente (1º pending): confirm → envia/agenda `message`, marca `sent`; skip → marca `skipped`; avança; retorna `{ done, sent_count, skipped_count, next_contact? }`. (Editar = confirm com `message` = texto do rep.)
- `send_all_remaining_outreach({})` → Modo B: dispara o restante via Bulk V2 (com disclaimers). Marca `sent`.
- `cancel_guided_outreach({})` → cancela a sessão ativa.

**4.3. Envio:** confirm → `send_message_to_contact` (agora) OU `schedule_message_to_contact` (se `send_mode=scheduled`, calcula horário escalonado). Reusa o que já existe.

**4.4. Botão:** `present_options` com ids `confirm`/`edit`/`skip`. Tap "Confirmar" → `outreach_decision(confirm, message=<sugerida>)`. Tap "Editar" → bot pede texto → `outreach_decision(confirm, message=<texto do rep>)`. Tap "Pular" → `outreach_decision(skip)`.

**4.5. Anti-spam/segurança:** Modo B passa pelos disclaimers de Bulk V2 (quente/fria). Envio a CONTATO (não ao rep) — não mexe no silence-gate do rep. Confirmação por contato no Modo A é o próprio gate (rep aprova cada um).

## 5. Etapas
### Etapa 0 — Decisões + migration 👤🤖
- 👤 fechar D3–D5. 🤖 migration das 2 tabelas (+ aplicar via MCP). Env gate `GUIDED_OUTREACH_ENABLED` (default OFF).
- **Saída:** schema no ar, gate off (deploy não muda nada).

### Etapa 1 — Repo + lógica de sessão 🤖
- `guided-outreach.repo.ts`: createSession(+items), getActiveSession(rep), currentItem, applyDecision (confirm/skip + advance), completeIfDone. Unit test da máquina de estado (cursor, done, skip).

### Etapa 2 — Tools 🤖
- `start_guided_outreach`, `outreach_decision`, `send_all_remaining_outreach`, `cancel_guided_outreach` + registry. Risk: outreach_decision/send = medium (envia a contato).

### Etapa 3 — Envio (now/scheduled/stagger) + Modo B 🤖
- Integra send/schedule_message_to_contact; escalonamento; Modo B reusa Bulk V2 com disclaimers.

### Etapa 4 — Prompt 🤖
- Treina o fluxo: quando usar start_guided_outreach (rep quer falar com uma LISTA 1-a-1), present_options [Confirmar/Editar/Pular], subfluxo de Editar, "manda tudo" → send_all, retomar sessão ativa, mostrar progresso [i/N]. Drafting leve-personalizado.

### Etapa 5 — Teste + smoke + deploy 🤖🤝
- tsc 0, suites, build. Deploy gated. 🤝 smoke do Pedro (lista pequena: confirma/edita/pula/manda-tudo). Ligar `GUIDED_OUTREACH_ENABLED`.

## 6. Rollback / segurança
- Tudo atrás de `GUIDED_OUTREACH_ENABLED` (off = comportamento atual). Migration aditiva. Reverter = desligar env. Envio sempre passa por confirmação (Modo A) ou disclaimers (Modo B).

## 7. Riscos
| Risco | Mit. | Resp |
|---|---|---|
| Duplo-envio (tap repetido / race) | item só sai de `pending` 1×; outreach_decision idempotente por item | 🤖 |
| Lista gigante (200+) | cap na sessão + Modo B (bulk) pra volume | 🤖 |
| Rep abandona no meio | sessão fica `active`; bot oferece retomar; expira em N dias | 🤝 |
| Msg sugerida ruim | botão Editar cobre; rep sempre revisa antes de enviar | 👤 |
