# Bulk Management Platform (H32)

> **Status:** plano em revisão.
> **Autor:** Pedro + Claude — review 2026-05-16.
> **Trigger:** análise da conversa Gustavo Couto (+17542650461) hoje 14:54–20:20, onde o bot entrou em loop de 5+ confirmações, truncou recipients silenciosamente por cap, diagnosticou errado, e ficou 5h15min sem responder.
> **Pre-reqs:** H27 (Filter Engine), H28 (Bulk V2), H29/H30/H31 (Conversational UX layer).

---

## 1. Diagnóstico (o que aconteceu hoje)

### 1.1. Timeline real (Gustavo, 2026-05-16)

| Hora | Evento | Problema |
|------|--------|----------|
| 14:00 | Bot proativo lembra agendamento M3 | OK |
| 14:54 | Gustavo: "Prepare disparo M3, manda lista" | OK |
| 14:54 | Bot: lista 6 contatos + "Confirma terça 12:00?" | OK |
| 14:54 | Gustavo: "Sim" | OK |
| 14:55 | Bot: tela cap completa "Você tem 3 em andamento, cap 98/100. A. Esperar / B. Paralelo" | Fricção 1 — devia ser warning, não bloqueio |
| 14:55 | Gustavo: "A" | OK |
| 14:55 | Bot: "Vou agendar 6 contatos terça 12:00. Confirma?" | Fricção 2 — re-confirma o que já confirmou |
| 14:55 | Gustavo: "Confirmado" | OK |
| 14:55 | Bot: **"Antes de chamar, me confirma: a lista M3 é *quente*?"** | Fricção 3 — pergunta separada redundante (disclaimer já cobre) |
| 14:56 | Gustavo: "Quente" | OK |
| 14:56 | Bot: **REPETE tela de cap inteira** com mesmas opções | Fricção 4 — loop óbvio |
| 14:56 | Gustavo: "3" | OK |
| 14:56 | Bot: "Disparo agendado! Só 2 contatos foram enfileirados (cap diário restante era 2). Os outros 4 ficaram de fora." | **Bug 1**: cap do dia 16 aplicado a agendamento dia 19 |
| 14:58 | Gustavo (irritado): **"Tá ficando maluco? Para de me perguntar a mesma coisa"** | Sinal de loop — bot ignora |
| 14:58 | Bot: oferece cancelar e reagendar | Sem aprender |
| 14:58 | Gustavo: "Sim cancela e cria os 6" | OK |
| 14:59 | Bot: **MESMO ERRO** — só 2 enfileirados + diagnóstico errado **"pode ser que os outros 4 não estão no stage M3"** | **Bug 2**: bot atribui falha do cap ao filtro |
| 15:00 | Gustavo: "Tem 6 oportunidades no estágio, pega a lista" | OK |
| 15:00 | Bot: mesmo loop | Sem aprender |
| 15:00 | Gustavo: "Cancela o job M3 existente" | OK |
| 15:04 | Gustavo (diagnóstico correto): "Acho que vc não consegue agendar porque está no limite de 100" | Bot deveria ter dito isso 30min antes |
| **20:19** | Gustavo: **"Você está funcionando?"** | **Crash silencioso de 5h15min** |
| 20:20 | Bot retoma | Sem reconhecer o gap |

### 1.2. Estado real dos jobs do Gustavo

- **3 jobs `running` desde 2026-05-15 23:23–23:35** com 63 recipients pending e **0 sent**.
  - M2: 15 pending / 0 sent
  - M1: 14 pending / 0 sent
  - M0+Prova Agendada: 34 pending / 0 sent
- **Runner travado** — 21h sem progresso (não detectado).
- Esses 63 pending consumiam o cap diário, **truncando** M3 silenciosamente.
- 3 jobs M3 criados hoje, cada um com só 2 recipients (Larissa + Renan), todos cancelados.

### 1.3. Root causes (7)

| # | Causa | Arquivo | Severidade |
|---|-------|---------|------------|
| RC1 | **Cap diário aplicado a agendamento futuro** — `countRecipientsLast24h` conta recipients em qualquer `scheduled_at`, mesmo terça-feira | `tools/bulk-messages-v2.ts:641-657` + `bulk-messages.ts:106` | **CRÍTICA** |
| RC2 | **Pergunta "é quente?" separada do disclaimer** — duplica o trabalho que o disclaimer `lista_quente_required` já faz | `prompt-builder.ts` + `disclaimers.ts:52-114` | ALTA |
| RC3 | **N turns sequenciais de disclaimer** — `formatDisclaimersChecklist` existe mas não é usado em V2 (usa `formatDisclaimersForWhatsApp` com splitter `---`) | `filter-engine/disclaimers.ts:146` | ALTA |
| RC4 | **Tela de cap repete inteira em cada turn** — bot não lembra que rep já escolheu "A" há 30s | `conversational/turn-context.ts` (não cobre cap-flow) | ALTA |
| RC5 | **Cap não tem path de override** — único caminho é SQL admin direto em `agent_configs.daily_bulk_message_cap` | n/a (tool não existe) | ALTA |
| RC6 | **Bulk runner trava silenciosamente** — 21h com 0 sent, sem alert pro admin/rep | `proactive/bulk-message-runner.ts` | CRÍTICA |
| RC7 | **Diagnóstico errado quando trim acontece** — bot fala "pode ser stage" em vez de "cap atingido" | `tools/bulk-messages-v2.ts` (mensagem de retorno) | ALTA |

---

## 2. Decisões do Pedro (input dele pra esse plano)

| # | Decisão | Implicação |
|---|---------|------------|
| D1 | "Não precisa ficar confirmando se os contatos são quentes, só o disclaimer já basta" | Remover pergunta "quente?" do prompt. Disclaimer textual único cobre. |
| D2 | "Se o agente quiser fazer override, ela vai falar que não recomenda por conta do limite, mas se ele fizer, pode" | Implementar tool `bulk_request_cap_override(extra_count, reason)` risk=high. Warning informativo, não bloqueio. |
| D3 | "Tem que criar plataforma de management — interagir, puxar, cancelar, pausar, fazer vários, bypass" | Tools de management agrupadas + dashboard consolidado. |
| D4 | "Limite aparentemente está baixo" | Re-avaliar default 100/dia. Considerar elevar pra 250-500 com cap por contato (cooldown) substituindo cap global. |
| D5 | "Múltiplos ao mesmo tempo" | Remover bloqueio em coexistência. Warning informativo + cria direto. |

---

## 3. Plano em fases

### **Fase 1 — Quick wins (deploy hoje/amanhã)** ⚡

Objetivo: parar o sangramento. Fixes que destravam Gustavo IMEDIATAMENTE sem refactor estrutural.

| # | Fix | Arquivo | Impacto |
|---|-----|---------|---------|
| F1.1 | **Cap futuro não conta** — `countRecipientsLast24h` aceita `windowEndDate` param. Schedule pra dia X usa cap do dia X, não cap "now". | `bulk-messages.ts:106` (helper) + chamada em `bulk-messages-v2.ts:641` | Resolve RC1 |
| F1.2 | **Disclaimer único checklist** — V2 passa a usar `formatDisclaimersChecklist()` em vez de `formatDisclaimersForWhatsApp`. 1 mensagem com `☑️ Lista é quente ☑️ Aceita risco volume > 50`. | `tools/bulk-messages-v2.ts:render` | Resolve RC3 |
| F1.3 | **Remover prompt "é quente?"** — atualizar system prompt removendo orientação de pré-perguntar. Disclaimer já força aceite. | `prompt-builder.ts` | Resolve RC2 |
| F1.4 | **Mensagem de trim corrigida** — quando cap trunca, retornar `"⚠️ Atingiu cap diário (X/Y). Enfileirados só Z de N. Use bulk_request_cap_override pra liberar restante."` em vez de mensagem ambígua. | `tools/bulk-messages-v2.ts:trim block` | Resolve RC7 |
| F1.5 | **Runner heartbeat + alert** — bulk-message-runner registra `last_tick_at` em `agent_configs` ou nova tabela `bulk_runner_health`. Cron de monitoramento detecta `last_tick_at > 5min` e cria signal `runner_stale`. | `proactive/bulk-message-runner.ts` + nova migration | Resolve RC6 |
| F1.6 | **Coexistência: warning ao invés de bloqueio** — `schedule_bulk_message_v2` não bloqueia mais com `confirmed_parallel_run`. Passa `coexistence: {active_jobs: 3}` no resultado; LLM avisa informativo. | `tools/bulk-messages-v2.ts:coexistence guard` | Resolve RC5 (parcial) |

**Resultado esperado:** caso Gustavo de hoje se resolveria em **3 turns** em vez de 14+.

### **Fase 2 — Management hub (semana 1)** 🛠️

Objetivo: rep consegue gerenciar tudo via WhatsApp sem precisar abrir admin panel.

| # | Tool nova | Risk | Função |
|---|-----------|------|--------|
| F2.1 | `bulk_dashboard` | safe | Lista TODOS os jobs ativos do rep+location: status, sent/pending, ETA, próximas N msgs, alerts (runner stale, cap próximo). 1 chamada = visão completa. |
| F2.2 | `bulk_pause_all` | medium | Pausa todos os jobs `running` do rep de uma vez. |
| F2.3 | `bulk_resume_all` | medium | Retoma todos paused. |
| F2.4 | `bulk_cancel_all` | high | Cancela todos pending de uma vez (com confirmation gate). |
| F2.5 | `bulk_reschedule_job(job_id, new_start_at)` | medium | Move um job pendente pra outra data. |
| F2.6 | `bulk_edit_pending_job(job_id, new_template?, new_filter?)` | high | Edita job que ainda não começou. Re-aplica disclaimers se filter mudar. |
| F2.7 | `bulk_request_cap_override(extra_count, reason)` | high | Eleva cap do dia em N unidades (com aceite explícito). Audit em `bulk_cap_overrides` table. |

### **Fase 3 — Smart cap + per-contact cooldown (semana 2)** 🧠

Objetivo: substituir cap diário "burro" por sistema multi-dimensional que reflete risco real.

| # | Mudança | Detalhes |
|---|---------|----------|
| F3.1 | Default cap diário: 100 → 300 | `daily_bulk_message_cap` default em `getDailyCap()`. |
| F3.2 | Per-contact cooldown: 24h entre msgs bulk pro mesmo contato | Index novo + check em `schedule_bulk_message_v2` antes do enqueue. |
| F3.3 | Per-segment cap (opcional) | Admin pode setar limites por segment_label (ex: "M3" max 20/dia). |
| F3.4 | Weekly cap (opcional) | `weekly_bulk_message_cap` default 1500 — proteção secundária. |
| F3.5 | Cap soft warn em 80% | LLM recebe `cap_status: "approaching"` quando 80%+. Conversacional ("Heads up: cap em 280/300 hoje"). |

### **Fase 4 — Multi-job coordenação (semana 2-3)** 🎼

Objetivo: quando rep tem múltiplos jobs, sistema coordena pra não autossabotar.

| # | Mudança | Detalhes |
|---|---------|----------|
| F4.1 | **Priority queue** — `bulk_message_jobs.priority` (default 50, range 1-100). Runner processa por prioridade desc. | Permite "urgente sai na frente". |
| F4.2 | **Job tags/labels** — `bulk_message_jobs.label` (ex: "M3-terça", "Black Friday"). Dashboard mostra. | Resolve "qual job é qual". |
| F4.3 | **Job ownership lock** — antes de criar, verifica se já existe job idêntico (mesmo filter+template+window) e pergunta "Já tem job similar — adicionar recipients ou criar novo?" | Anti-duplicação. |
| F4.4 | **Cancel cascade** — cancelar job principal mostra "Cancelou job X (15 pending). Quer cancelar os outros 2 da mesma série também?" | UX cascata. |

---

## 4. Mudanças no Conversational UX layer

### 4.1. Loop detection (extensão do turn-context)

`turn-context.ts` ganha campo `repeated_questions: Map<string, number>` — bot conta quantas vezes fez mesma pergunta nessa sessão. Se >= 2:

```typescript
if (turnContext.repeated_questions.get("cap_choice") >= 2) {
  // Prompt orienta: "PARE de repetir. Rep já escolheu antes. Se contexto perdeu, ASSUMA escolha anterior."
}
```

### 4.2. Bulk-specific turn-context

Quando rep escolhe opção em menu cap-flow ou coexistence, `turnContext.bulk_session_state` registra:

```typescript
{
  cap_choice: "wait" | "parallel" | "override",
  warm_status: "warm" | "cold" | "mixed",
  delivery_choice_id: 1 | 2 | 3,
  scheduled_at_chosen: ISO string,
  accepted_disclaimers: ["lista_quente_required", "risk_high_volume_warm"]
}
```

Próximas tools recebem isso pré-resolvido — não pergunta de novo.

### 4.3. Mensagem de auto-recovery após silêncio

Se bot detecta gap > 30min entre seu último turn e msg do rep (heurística simples), abre o turn com:

> "Voltei. Vi que você mandou 'cancela' às 15:00, depois ficamos 5h sem trocar. Quer que eu siga de onde paramos ou começar do zero?"

---

## 5. Schemas / Migrations necessárias

### 5.1. `bulk_cap_overrides` (nova)

```sql
CREATE TABLE bulk_cap_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_identity_id UUID NOT NULL REFERENCES rep_identities(id),
  location_id TEXT NOT NULL,
  agent_id UUID REFERENCES agents(id),
  for_date DATE NOT NULL,                    -- override aplica a qual dia
  cap_before INT NOT NULL,                   -- ex: 100
  cap_after INT NOT NULL,                    -- ex: 250
  extra_granted INT NOT NULL,                -- ex: 150
  reason TEXT,                               -- texto do rep
  approved_by TEXT DEFAULT 'rep',            -- 'rep' | 'admin'
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON bulk_cap_overrides (location_id, for_date);
CREATE INDEX ON bulk_cap_overrides (rep_identity_id, created_at DESC);
```

### 5.2. `bulk_message_jobs` — colunas novas

```sql
ALTER TABLE bulk_message_jobs ADD COLUMN label TEXT;
ALTER TABLE bulk_message_jobs ADD COLUMN priority INT DEFAULT 50;
ALTER TABLE bulk_message_jobs ADD COLUMN cap_override_id UUID REFERENCES bulk_cap_overrides(id);
ALTER TABLE bulk_message_jobs ADD COLUMN paused_at TIMESTAMPTZ;
ALTER TABLE bulk_message_jobs ADD COLUMN cancelled_reason TEXT;
CREATE INDEX ON bulk_message_jobs (rep_identity_id, status, priority DESC);
```

### 5.3. `bulk_runner_health` (nova — Fase 1.5)

```sql
CREATE TABLE bulk_runner_health (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  last_tick_at TIMESTAMPTZ NOT NULL,
  last_jobs_processed INT,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO bulk_runner_health (id, last_tick_at) VALUES (1, now())
  ON CONFLICT DO NOTHING;
```

Cron monitora: `SELECT 1 FROM bulk_runner_health WHERE last_tick_at < now() - interval '5 minutes'` → cria signal.

### 5.4. `bulk_contact_cooldown` (Fase 3)

```sql
CREATE TABLE bulk_contact_cooldown (
  contact_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL,
  job_id UUID REFERENCES bulk_message_jobs(id),
  PRIMARY KEY (contact_id, location_id)
);
CREATE INDEX ON bulk_contact_cooldown (last_sent_at DESC);
```

---

## 6. Tool catalog após implementação (delta vs hoje)

### Mantém (refatoradas internamente)
- `preview_bulk_message_v2`
- `schedule_bulk_message_v2`
- `pause_bulk_job` / `resume_bulk_job` / `cancel_bulk_job`
- `get_bulk_job_progress`
- `list_bulk_jobs`

### Novas (Fase 2)
- `bulk_dashboard` — resumo consolidado
- `bulk_pause_all` / `bulk_resume_all` / `bulk_cancel_all`
- `bulk_reschedule_job`
- `bulk_edit_pending_job`
- `bulk_request_cap_override`

### Deprecadas (V1 → wrapper retrocompat)
- `preview_bulk_message` (V1) — wrapper que chama V2
- `schedule_bulk_message` (V1) — wrapper

---

## 7. Métricas de validação

| Métrica | Baseline (Gustavo hoje) | Target pós-Fase 1 | Target pós-Fase 4 |
|---------|------------------------|-------------------|---------------------|
| Turns entre "quero disparar" e job criado | 14 | 3 | 2 |
| Trim silencioso de recipients | 4/6 (67%) | 0% | 0% |
| Loop de pergunta repetida | 2 telas idênticas | 0 | 0 |
| Diagnóstico errado em retorno de tool | 1 | 0 | 0 |
| Tempo de detecção de runner travado | 21h | <5min | <5min |
| Cap override possível via chat | NÃO | SIM | SIM |
| Gerenciar 3+ jobs em 1 turn | NÃO | NÃO | SIM (via bulk_dashboard + pause_all) |

---

## 8. Ordem sugerida de implementação

1. **Hoje** — Fase 1.1 (cap futuro), 1.4 (mensagem trim), 1.5 (runner heartbeat). DESBLOQUEIA Gustavo.
2. **Hoje/amanhã** — Fase 1.2 (disclaimer único), 1.3 (remover "quente?"), 1.6 (coexistence warning).
3. **Esta semana** — Fase 2 inteira (7 tools novas).
4. **Próxima semana** — Fase 3 (smart cap).
5. **Semana seguinte** — Fase 4 (priority, labels, cascade).
6. **Em paralelo (não bloqueante)** — Conversational UX 4.1 (loop detector) e 4.2 (bulk turn-context).

---

## 9. Riscos & mitigações

| Risco | Probabilidade | Mitigação |
|-------|---------------|-----------|
| Override de cap usado abusivamente → spam complaint Meta | Média | Hard ceiling absoluto: `daily_bulk_message_cap * 3` máximo overridable. Audit todos. |
| Remover pergunta "quente?" → rep não lê disclaimer e aceita lista fria como quente | Média | Disclaimer mantém aceite explícito ("Confirma cold: SIM"). Logs guardam aceite. |
| Coexistência sem bloqueio → 5 jobs simultâneos disputam runner | Baixa | Fase 4.1 priority queue + per-contact cooldown protege. |
| Migration `bulk_runner_health` com singleton row falha em fresh deploy | Baixa | `INSERT ... ON CONFLICT DO NOTHING`. |

---

## 10. Open questions pra Pedro decidir

1. **Cap override — qual o teto absoluto?** Default 3x (300 quando cap = 100)? Ou config admin?
2. **Per-contact cooldown — 24h é certo?** Ou 48h? Ou configurável per-tag (clientes ativos podem receber mais frequente)?
3. **`bulk_dashboard` — formato output?** Tabela texto, JSON estruturado, ou ambos (texto pra rep ver + JSON pra LLM consumir)?
4. **Runner stale alert — pra onde?** Só admin signals? Ou notifica rep também ("seu disparo está travado há 1h, admin notificado")?
5. **Edit pending job — re-confirma disclaimers se filtro muda?** Sim por default (safer)?
