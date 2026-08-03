# Automação "Agente ativado pro contato" (H62, Pedro 2026-08-03)

## Pedido
No AI Hub (custom link do Spark Leads), na parte de Automações do agente: uma automação
que dispara **quando o agente é ativado pro contato** — tanto ativação manual (botão da
UI) quanto automática (regra de ativação/targeting). Ações: tag, mover no funil,
atualizar campo. Pickers dinâmicos puxando tags/pipelines/estágios/campos reais da conta.

## Decisão de arquitetura: TRIGGER NOVO no motor que já existe (não sistema paralelo)
O agente já tem `agent_configs.automations` (`AutomationRule[]`, H36) com triggers
`event` (qualified/booked/...) e `on_data_field_set`, executor completo em
`reaction-engine.ts` (`executeReactionRules` — add_tag/remove_tag/move_pipeline/
update_field/send_text_fixed/send_media/pause_ai/webhook) e dedup 1×-por-conversa em
`conversation_state.triggered_automations` (00014). A Cat "Automações" da UI já edita
essas regras. O pedido vira:

1. **Trigger novo** `{ kind: "agent_activated" }` no union `AutomationTrigger`
   (types + zod).
2. **Disparo automático (ramo 11c no queue-processor)**: dentro do bloco de reações
   existente, quando `!conversationActive` (o turno é a 1ª vez que ESTE agente assume o
   contato — mesma transição que o trigger_once/H51 usa) → executa as regras
   `agent_activated` via `executeReactionRules`, dedup no MESMO `triggered_automations`.
3. **Disparo manual**: `contact-pause` (resume) e `contact-activate` (setActive) chamam
   `runAgentActivatedAutomations` (módulo novo `src/lib/queue/agent-activated-automation.ts`)
   — carrega config+estado, filtra regras não-disparadas, executa, merge no dedup.
   Fail-soft: erro NUNCA quebra a rota/turno.
4. **UI**: opção "Agente ativado pro contato" no select de gatilho da Cat Automações
   (padrão `__field__`) + **pickers dinâmicos (F35) nas ações**: TagPicker (add/remove
   tag), PipelineStagePicker (mover no funil), CustomFieldPicker (atualizar campo) —
   substituindo os inputs de texto livre por ID. Endpoints `/api/ghl/{tags,pipelines,
   custom-fields}` já existem (fail-soft → picker degrada pra texto livre).

## O que NÃO precisa
- **Zero migration**: colunas `automations` e `triggered_automations` já existem.
- **Zero endpoint novo**: os 3 de dados dinâmicos já existem (F27/F35).
- **Zero flag global**: regra só roda se o admin criar (opt-in por natureza).

## Semântica do trigger (documentada pro futuro)
- Dispara **1× por (agente, contato)** — dedup por rule.id em `triggered_automations`
  (permanente na linha do conversation_state; re-ativação manual depois de pausa NÃO
  re-dispara — mesma regra dos outros triggers do motor).
- "Ativado" = (a) 1º turno processado deste agente pro contato (targeting passou e o
  agente respondeu/assumiu — inclui outreach proativo), OU (b) alguém ligou o agente
  pro contato manualmente na UI — **3 portas**: contact-pause (resume), contact-activate
  (switch) e conversations/resume (aba Pausadas do /hub) — o que vier primeiro.
- **Fora do trigger (deliberado)**: religar o AGENTE inteiro (PUT status→active em
  /api/agents/[agentId]) despausa conversas EM MASSA e NÃO dispara — semântica é
  per-contato e o disparo em massa faria N chamadas GHL de uma vez. Comentado na rota.

## Corridas e mitigação (review adversarial 2026-08-03, 4 lentes/12 achados)
A 1ª versão assumia "janela de ms" e "ações idempotentes" — os dois estavam ERRADOS
(a janela era o turno inteiro, 10-60s com LLM no meio, e a regra aceita
send_text_fixed/webhook, que não são idempotentes). Mitigações aplicadas:
- **Ramo 11c/merge**: `triggered_automations` é relido FRESCO na entrada do bloco de
  reações E de novo imediatamente antes do write (união, não last-write-wins) — rota
  manual gravando no meio do turno não é mais apagada nem re-disparada (mesmo padrão
  do re-read GU-6×F52).
- **Rotas manuais**: runner roda ANTES do `reenqueueInboundsSincePause` (o dedup
  persiste antes de qualquer worker pegar o turno recuperado); no contact-activate o
  "pausa os outros" roda ANTES do runner (invariante GU-7: a janela de 2 agentes
  ativos volta a ser ms). `maxDuration` 20→30 + `withDeadline(12s)` no runner (webhook
  de regra segura até 8s; a rota sempre sobra tempo pra responder).
- **Runner**: revalida agente↔location (não confia no caller — anti cross-tenant),
  resolve o `channel` do último message_queue (send_text/media no canal certo, não SMS
  cego), e persiste o dedup DEPOIS de executar (trade-off herdado dos ramos 11a/11b:
  lambda morta no meio re-executa no próximo resume; persistir antes perderia ações).
- **Residual aceito**: corrida runner×turno simultâneos na janela de segundos das
  próprias ações (sem CAS de array no Postgres) — a união fresca reduz a quase zero e
  o caso de uso principal (tag/funil/campo) é idempotente no Spark Leads.
- **Picker legado**: regra update_field antiga salva com slug custom aparece no select
  novo via option de fallback (antes renderia em branco); re-escolher migra pro id.

## Testes
`scripts/test-activation-automation.ts`: filtro puro das regras (kind+dedup), zod aceita
o trigger novo (e rejeita lixo), runner manual com deps fake (dispara → merge → não
re-dispara; config sem regra = no-op sem query de estado; erro de executor não lança).
