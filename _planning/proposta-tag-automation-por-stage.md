# Proposta: Tag Automation por Stage (Sparkbot)

**Status:** PROPOSTA — NÃO implementado ainda.
**Origem:** Pedido do Gustavo Couto (cliente +1 754-265-0461) durante review 2026-05-14.
**Owner:** Pedro Poleza.
**Decisão:** Adiar até estabilizar Fases 1-5 do fix Gustavo (pagination + alias + anti-confiança-falsa). Pedro reavalia depois de 1-2 semanas em prod.

---

## 1. Contexto

Durante a conversa do Gustavo com o Sparkbot (2026-05-13/14), ele pediu **"toda vez que um lead chegar no M3, adiciona a tag X"** — automação de tag baseada em mudança de stage de opportunity.

Pedro respondeu: *"tag automation per stage is too much for AI now — skip"*.

Razão: o problema PRINCIPAL do Gustavo era confiança/precisão de DADOS (M3=3 errado, tag=20 errado), não automação. Resolver os dados primeiro, depois pensar em automação.

Esta proposta documenta o desenho pra quando Pedro decidir implementar.

---

## 2. Casos de uso identificados

### CU1 — Adicionar tag quando opp entra em stage X
**Frase do rep:** *"toda vez que um lead chegar no M3, adiciona a tag 'foco-foda-imediato'"*.
**Trigger:** opp.pipelineStageId mudou pra stage_X.
**Ação:** add_tag no contato dono da opp.

### CU2 — Remover tag quando opp sai de stage X
**Frase:** *"se o lead sair do M3, tira a tag 'foco-foda-imediato'"*.
**Trigger:** opp.pipelineStageId mudou DE stage_X pra outro.
**Ação:** remove_tag.

### CU3 — Notificação adicional
**Frase:** *"e me avisa quando isso acontecer"*.
**Trigger:** mesmo evento.
**Ação:** enviar msg proativa via Sparkbot WhatsApp pro rep.

### CU4 — Combo (multi-action)
**Frase:** *"quando entrar no M3, adiciona tag X, cria task 'follow-up 24h', e me notifica"*.

---

## 3. Onde plugar — escolha de arquitetura

### Opção A: GHL Workflows nativos (recomendada inicialmente)
- GHL tem Workflows com triggers "Opportunity Stage Changed" + actions "Add Tag", "Remove Tag", "Send Internal Notification".
- **Vantagem:** zero código nosso, latência baixa (event-driven no GHL), rep mantém controle visual.
- **Desvantagem:** rep precisa abrir GHL e setar manual (perde o jeitinho conversacional).
- **Encaixe Sparkbot:** bot ENSINA o rep a criar o workflow ("Vai em Automation > Workflows > New > trigger Opportunity Stage Changed > stage X > action Add Tag Y").
- **Esforço:** zero. Implementação = tool nova `explain_ghl_workflow` que devolve instrução passo-a-passo.

### Opção B: SparkBot proactive_rules (futuro, multi-CRM-friendly)
- Tabela `assistant_proactive_rules` já existe (migration 00043+).
- Adicionar novo `ReactiveTrigger`: `{ event: "opportunity_stage_changed"; from_stage_id?: string; to_stage_id: string }`.
- Polling-based: cron a cada N min compara snapshots de opps (joinmento pelo `updatedAt` + lastStageChangeAt).
- Action engine: nova coluna `proactive_rules.actions` jsonb array: `[{ type: "add_tag", tag: "X" }, { type: "create_task", title: "Y", due_offset_hours: 24 }, { type: "notify_rep", template: "..." }]`.
- **Vantagem:** funciona cross-CRM (quando agregarmos Pipedrive/HubSpot), bot controla tudo, audit no `assistant_alert_state`.
- **Desvantagem:** polling tem latência (1-15min), complexidade significativa, sob risco de double-fire em race condition.
- **Esforço:** 3-5 dias dev.

### Opção C: GHL Webhooks → nossa edge function (médio prazo)
- GHL manda webhook em `OpportunityStageChanged` (já existe).
- Edge function `/api/webhooks/ghl-opportunity` recebe, consulta tabela `tag_automation_rules` (nova), aplica.
- **Vantagem:** event-driven, latência <5s, sem polling, multi-tenant via `agents` table.
- **Desvantagem:** dependência de webhook stability (GHL às vezes atrasa/falha — vimos isso na investigação Stevo).
- **Esforço:** 2-3 dias dev (handler + UI admin pra rep configurar).

---

## 4. Recomendação final

**Curto prazo (próximas semanas):** Opção A — bot ensina rep a usar GHL Workflows. Custa nada implementar, resolve 80% dos casos.

**Médio prazo (Q3 2026):** Avaliar Opção C se 5+ reps pedirem isso recorrentemente. Painel admin com "Tag Rules" cadastráveis, audit pelo bot.

**Longo prazo (V3 multi-CRM):** Opção B no sistema unificado de proactive_rules.

---

## 5. Pontos abertos pra decidir antes de implementar

1. **Escopo da tag**: aplica em ContactID do owner da opp OU permite tag no Contact relacionado (se diferente)? Default = Contact da opp.
2. **Ordem de operações em combo (CU4)**: serial vs paralelo? Se add_tag falhar, ainda cria task? Sugestão: serial com `stop_on_error: false`.
3. **Cobrança**: cada action conta como request bilável? Sugestão: NÃO — Tag automation é "background" não-interativo, custo é I/O GHL apenas (não LLM). Bot só cobra se gerar notificação que dispara turn do rep.
4. **Idempotência**: webhook GHL pode disparar 2x (vimos isso no Stevo). add_tag é idempotente (GHL faz dedup), mas create_task NÃO. Precisa dedup key tipo `webhook_event_id:rule_id`.
5. **Quota**: limite de rules por sub-account? Sugestão: 20 (proativas + reativas combinadas).
6. **UI**: rep cria via comando conversacional ("toda vez que..."), via painel admin, ou ambos? Sugestão: ambos. Comando = MVP, painel = power-user.

---

## 6. Riscos identificados

- **R1: Tag spam**: rep cria regra "add tag X quando entra M3" e bot dispara em LOTE pra 200 opps existentes no momento da criação. Mitigação: regra só dispara em CHANGE de stage, não em snapshot inicial.
- **R2: Loop**: rep cria 2 regras conflitantes (add tag X quando entra Y; remove tag X quando entra Y). Mitigação: validação no save + warning.
- **R3: GHL rate limit**: 200 opps mudando stage em 1 webhook = 200 add_tag calls. GHL limita ~100/min. Mitigação: queue + throttle.
- **R4: Vazamento de info entre reps**: regra A do rep X dispara ação no contact que pertence ao rep Y. Mitigação: enforce que rule só age em contatos atribuídos ao rep que criou (assigned_to = rep.ghl_user_id).

---

## 7. Critério pra começar

Implementar quando:
- 3+ reps independentes pedirem tag automation
- Sparkbot estabilizado pós-Fase 1-5 (dado preciso, sem confiança falsa)
- Pedro tiver bandwidth pra revisar painel admin de rules

Até lá, bot deve responder pedido com Opção A (explicar GHL Workflows passo-a-passo).
