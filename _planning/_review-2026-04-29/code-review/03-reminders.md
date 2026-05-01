# Code Review — Reminders + Proatividade Sparkbot
Data: 2026-04-29
Revisor: arquiteto
Escopo: tools/reminders.ts, proactive/{reminder-runner, cron-evaluator, dispatcher, system-rules}, /api/cron/sparkbot-proactive, migrations 00031/00033/00040/00042

## Resumo executivo

Sistema funcionalmente "completo" em V2 simulated, mas com **bug critico de produção** (BUG #7 — WhatsApp nunca entrega) e **race conditions ainda abertas**. Atomic claim no reminder-runner é diferente do dispatcher e tem gap. Migration 00040 promete fix UNIQUE NULLS NOT DISTINCT mas depende do Postgres ≥15. UX confusa: rep não vê canal do reminder ao listar; cross-canal cancel pode falhar silenciosamente.

Contagem:
- CRITICAL: 2 (#7, #14)
- HIGH: 5 (#3, #4, #5, #10, #12)
- MEDIUM: 6 (#2, #6, #11, #13, #15, #16)
- LOW: 3 (#1, #17, #18)

UX gaps relevantes (3):
- list_my_reminders não retorna delivery_channel
- create_task vs schedule_reminder confusao mantida no prompt mas docs ainda enganosa (e create_task exige contact_id)
- Cancel cross-canal pode rejeitar silenciosamente quando rep tem ids divergentes web vs whatsapp

Blocker pra ir pra V3 prod: BUG #7 (WhatsApp não envia de verdade) é bloqueador absoluto pra qualquer rollout proativo via WhatsApp.

## Inconsistências encontradas

| # | tipo | descrição | severidade | file:line | fix |
|---|------|-----------|-----------|-----------|-----|
| 1 | docs | Migration 00031 comentário diz "via assistant_test_messages" — tabela na verdade é `agent_test_messages` | LOW | supabase/migrations/00031_assistant_scheduled_tasks.sql:5 | corrigir comentário |
| 2 | consistência | `delivery_channel='both'` faz 2 inserts em sparkbot_messages (web + whatsapp) sem idempotência. Se runner crashar entre o 1º e 2º insert e for retentado, vira 3 inserts (2 do web ou 2 do whatsapp dependendo da ordem). Não há UNIQUE em (reminder_id, channel) | MEDIUM | reminder-runner.ts:108-116 + 143/179 | UNIQUE constraint em (metadata->>reminder_id, channel) ou usar advanceTask só após ambos OK |
| 3 | edge case | `computeNextRun` itera 31 dias × 24h × 60min = 44640 iterações se cron impossível (ex: `0 0 30 2 *` = 30 fev). Retorna null → task vira `failed`. Performance: 44k chamadas a `parseLocalParts` (Intl.DateTimeFormat) por task inválida — pode levar segundos. Mais importante: rep agendou recorrente que silenciosamente morre, sem aviso | HIGH | reminder-runner.ts:286-298 | validar cron na schedule_reminder (rejeita combinação dom>28+mes=2); ou fallback descritivo: marcar `failed` com `last_run_at` e `failure_reason` em payload |
| 4 | bug TZ | `advanceTask` resolve tz pelo `task.location_id` (linha 244-248). Mas `cron-evaluator.shouldFireCron` no /api/cron/sparkbot-proactive recebe tz via `getRepTimezone(rep)` que usa `rep.active_location_id` (route.ts:151-158). Se rep mudou active_location, recurring vai disparar no tz da location ANTIGA (location_id da task) mas evaluator usaria tz da location NOVA → drift. Pior: rep movido pra outro tz pode pular ou duplicar disparo | HIGH | reminder-runner.ts:243-249 + route.ts:147-158 | Decidir UMA fonte: ou tz é fixo no momento da task (snapshot em task_payload), ou sempre resolve via active_location_id, mas consistente entre advance E firing |
| 5 | race | rep cancela enquanto runner já claimou. Atomic claim (reminder-runner.ts:40-48) faz `UPDATE...status='running' WHERE status='pending'`. Logo após, `cancel_reminder` valida `status === 'pending'` (reminders.ts:215) — mas runner já mudou pra `running`. Cancel retorna erro "Reminder já está 'running'", e msg será disparada. Confusão grave: rep tentou cancelar e recebeu lembrete | HIGH | reminders.ts:215-221 + reminder-runner.ts:40-48 | (a) permitir cancel em status running (interrompe disparo via flag em payload); ou (b) cancel reescreve next_run_at pra futuro distante e marca como cancelled-after-claim, runner skipa antes de fireOne |
| 6 | confusão | `fireOne` prioriza `test_session_id`. Em prod web, lembrete não tem session — OK. Mas se rep usa "Simular agora" no UI e tem test session aberta, e DEPOIS agenda lembrete real (sem test_session_id), comportamento OK. Risk: bot em prod chamou schedule_reminder com `ctx.testSessionId` por engano (vazamento de contexto) → reminder real vai pra session em vez do canal real do rep | MEDIUM | reminder-runner.ts:93-104 + reminders.ts:105 | adicionar telemetria/log quando test_session_id aparece em task de produção; ou validar testSessionId pertence à mesma rep_identity antes de redirecionar |
| 7 | **BUG PROD CRÍTICO** | `deliverReminderWhatsapp` NÃO envia WhatsApp real — só registra `pending_v3_send: true` em metadata. NENHUM código consome essa flag (verificado: grep `pending_v3_send` retorna apenas a definição em reminder-runner.ts:192). Lembrete agendado pro WhatsApp NUNCA chega no celular do rep. Se tem `read_in_web_at=now()` (linha 187), nem badge de não-lida no web aparece — rep nem sabe que reminder existe | **CRITICAL** | reminder-runner.ts:159-195 | (a) bloquear `delivery_channel='whatsapp'` no schedule_reminder até V3; ou (b) implementar GHL conversations/messages POST agora; (c) no mínimo: NÃO marcar read_in_web_at (deixa aparecer no web como fallback) e LOG ERROR pro admin saber que está em backlog |
| 8 | OK | `deliverReminderWeb` insere channel='system'. Inbox endpoint retorna com `is_proactive: m.role === 'agent' && !m.read_in_web_at && m.channel !== 'web_ui'`. Channel 'system' satisfaz a condição → `is_proactive=true` ✅ | OK | inbox/route.ts:86 | nenhum |
| 9 | risco DB | Migration 00040 fix UNIQUE NULLS NOT DISTINCT depende de Postgres ≥15. Comentário em 00040:158-161 admite "se versão for <15, fica como TODO". `try_claim_dispatch_slot` em 00033 alegou que UNIQUE casa NULLs — comentário 00033:48 desmentido em 00040:13. Risk: se Postgres é <15, claim atômico pra `target_id IS NULL` (regras globais como "Resumo matinal") vira race em produção. Status migration: aplicada? não há check no código que valide a versão do Postgres. Supabase managed deve ser ≥15 mas vale confirmar | HIGH (se PG<15) / MEDIUM (se ≥15 e aplicada) | 00040_usage_records_and_drift_recovery.sql:154-185 | Adicionar `SELECT version()` ao SETUP.sql e fail-fast se <15; OU smoke test que insere row com target_id NULL em pg que dispara double-claim |
| 10 | UX bug | `schedule_reminder` aceita `delivery_channel` opcional. Se LLM em web esquece de passar (não obstante prompt-builder ensinar a perguntar), default em reminders.ts:90-92 é `'whatsapp'` — sempre. Linha 92 tem código morto: ternário `ctx.confirmationMode ? "whatsapp" : "whatsapp"` — ambos branches retornam mesma coisa. Resultado: rep no painel web pede lembrete, bot esquece de perguntar canal, vira whatsapp e (devido BUG #7) nunca chega | HIGH | reminders.ts:85-92 | (a) default baseado em `rep.preferred_proactive_channel` ou `web_session_active_at` recente; (b) passar `channel` no `ToolContext` (extender types.ts:11-31) e usar como default; (c) remover ternário inútil |
| 11 | UX gap | `list_my_reminders` não retorna `delivery_channel`. Rep não sabe onde vai receber. Se ele tem 2 lembretes — um pro web e outro pra whatsapp — output parece idêntico | MEDIUM | reminders.ts:153-178 | adicionar `delivery_channel: t.delivery_channel` no select+map |
| 12 | UX cross-canal | `cancel_reminder` valida `existing.rep_id === ctx.rep.id`. Se rep agendou via WhatsApp (ctx.rep com phone real) e tenta cancelar via Web UI, `identifyRepByGhlUser` (identity.ts:201-227) tenta unificar pelo phone. Mas se WhatsApp tinha phone null/web-only, OU se phone do user GHL não casou com phone do whatsapp (typos, formato), Web cria rep separado (linha 232 placeholder `webonly:${ghlUserId}`) → IDs divergem → cancel rejeita "Reminder não pertence a você" | HIGH | reminders.ts:212-214 + identity.ts:201-251 | cancel deve checar `existing.rep_id IN (ctx.rep.id, ...todas as identidades unificáveis)`. Ou ainda melhor: investir em deduplicação de rep_identities por ghl_user_id no cron de cleanup |
| 13 | dispatcher consistência | `dispatcher.ts` usa `try_claim_dispatch_slot` (RPC). `reminder-runner.ts` faz claim diferente — UPDATE direto status='pending'→'running'. Não está claramente errado: tabela é diferente (`assistant_scheduled_tasks` vs `assistant_alert_state`), e UPDATE...RETURNING é atomic. Mas: dispatch pra regra system não passa pelo reminder-runner — passa pelo /api/cron/sparkbot-proactive linha 70-82 que faz upsert direto sem claim. O comentário linha 71 diz "Modo 'real' será habilitado em V3" e força status='skipped_disabled'. Logo: scheduled rules em V2 não chamam dispatchRule de fato — só logam no alert_state. Dispatcher.ts existe mas só é exercitado via "Simular agora" e webhook reactive. Confirmação: end-to-end de scheduled ainda não roda | MEDIUM | route.ts:67-83 + dispatcher.ts:216 | Documentar claramente que scheduled rules em V2 são "tracked but not delivered". Plug pra V3 deve trocar linha 71 por `await dispatchRule({mode:'real', ...})` |
| 14 | quiet_hours bypass | `dispatchRule` (dispatcher.ts:237) respeita quiet_hours pra system rules. Mas `fireScheduledReminders` (reminder-runner.ts:35) NÃO consulta quiet_hours. Se rep configurar quiet hours 22h-7h e tiver lembrete recurring `0 23 * * *`, o cron envia 23h em cima dele. Isso é grave em UX — rep configura "não me incomode à noite" e Sparkbot ignora pra reminders | **CRITICAL** (UX) | reminder-runner.ts:74-120 | adicionar `isInQuietHours(agentConfig?.quiet_hours)` antes de fireOne; em quiet hours, atrasar próximo run em vez de disparar (recurring: avança next_run_at; one-shot: agendar pro fim do quiet) |
| 15 | claim race | atomic claim em fireScheduledReminders.UPDATE...RETURNING limit 50 é atômico no Postgres (UPDATE pega lock). Mas: se 2 crons chamam em paralelo (pg_cron em 30s + Vercel cron em 5min), ambos fazem o mesmo UPDATE — Postgres serializa, segundo claim retorna 0 rows pendentes. OK ✅. Edge case: claim pega 50 rows mas processo crasha após fireOne(task#23) — tasks 24-50 ficam em status='running' eternamente, NUNCA voltam a pending. Não há reaper de status='running' há >Xmin | MEDIUM | reminder-runner.ts:40-48 | reaper cron periódico: `UPDATE assistant_scheduled_tasks SET status='pending' WHERE status='running' AND last_run_at < now() - interval '15 min'` |
| 16 | DRY | `deliverReminderTestSession` apenas chama `deliverReminder` (que é a única função usada). Indireção desnecessária | LOW | reminder-runner.ts:197-204 | inline ou remover `deliverReminderTestSession` |
| 17 | UX prompt | prompt-builder linha 91 diz "create_task = task no Spark CRM (visível pro rep no app Spark)". Mas create_task em tools/tasks.ts:11-52 EXIGE contact_id (linha 25 required). Rep não consegue criar "task pessoal sem contato" via create_task — só via schedule_reminder. Prompt deve deixar isso claro: "create_task SÓ pra tasks linkadas a contato; pra to-do pessoal sem contato, use schedule_reminder" | LOW | prompt-builder.ts:91 + tools/tasks.ts:25 | atualizar texto do prompt |
| 18 | UX prompt | prompt-builder linha 113 diz pra WhatsApp default `'whatsapp'`. Devido BUG #7, isso prática significa "lembretes pelo WhatsApp não chegam". Bot deveria avisar: "Anotei. Por enquanto lembretes WhatsApp não estão sendo entregues, vou marcar pro web tambem." Ou melhor: forçar `'web_ui'` ou `'both'` até V3 | LOW (depende de #7) | prompt-builder.ts:111-114 | acrescentar disclaimer ou mudar default temporariamente |

## Bugs CRITICAL/HIGH

### BUG #7 (CRITICAL) — Lembrete WhatsApp não entrega no celular do rep

**Confirmação:**
- `reminder-runner.ts:159-195` mostra `deliverReminderWhatsapp` apenas faz INSERT em `sparkbot_messages` com `channel='whatsapp'`, `read_in_web_at=now()`, `metadata.pending_v3_send=true`.
- Comentário linha 165-167: "V3 enviaria via GHL conversations/messages aqui. Por enquanto, registra... Quando V3 chegar, append GHLClient.post call aqui."
- `grep -rn pending_v3_send` em src/ retornou APENAS a definição. Nenhum consumer.
- Verificado também: `.next/server/...route.js` (build) tem o mesmo padrão sem call ao GHL — sem código morto compilado fora do branch atual.

**Impacto estimado:**
- 100% dos lembretes com `delivery_channel='whatsapp'` (que é o default) não chegam no rep.
- Rep não sabe — reminder some silenciosamente. `read_in_web_at=now()` impede badge no web (linha 187), então nem o fallback web compensa.
- Em prod V2 com Sparkbot ativo via WhatsApp, qualquer "me lembra amanhã 10h" = expectativa quebrada.
- Combinado com BUG #14 (quiet hours bypass), reps podem perder confiança em proatividade total do Sparkbot.

**Recomendações imediatas:**
1. Implementar entrega real via `GHLClient.post('/conversations/messages', { type: 'WhatsApp', contactId: <hub_contact_id_do_rep>, message })` (ver `src/lib/ghl/operations.ts`).
2. Enquanto não pronto: bloquear `delivery_channel='whatsapp'` em `schedule_reminder` retornando erro instrutivo "WhatsApp delivery em manutenção, use 'web_ui'", forçando bot a sempre marcar web.
3. Mínimo absoluto: REMOVER `read_in_web_at: new Date().toISOString()` da linha 187 — pelo menos rep vê no web como fallback.

### BUG #14 (CRITICAL UX) — quiet_hours não respeitado por reminders

`fireScheduledReminders` não chama `isInQuietHours`. Reps que configuram quiet hours esperam silêncio total — atualmente lembretes recurring agendados pra horário noturno disparam.

### BUG #5 (HIGH) — Cancel race com claim já em curso

Janela de race: `next_run_at` chega, runner faz `UPDATE...RETURNING` (atomic), task vira 'running'. Rep abre WhatsApp e digita "cancela aquele lembrete". `cancel_reminder` lê `status='running'`, retorna erro. LLM responde "não consegui, já tá rodando" e — segundos depois — chega a mensagem do reminder. UX horrível.

### BUG #3 (HIGH) — Cron impossível mata recurring silenciosamente

Cron `0 0 30 2 *` (30 fev nunca acontece) → `computeNextRun` itera 44640× e retorna null → `advanceTask` linha 252-256 marca `status='failed'`. Rep não é notificado. 31 dias entre disparo e null = task aparenta funcionar antes de morrer. Validar cron na criação evitaria isso.

### BUG #4 (HIGH) — Timezone drift se rep muda location ativa

`advanceTask` usa tz da `task.location_id` (origem); `shouldFireCron` no cron route usa tz de `rep.active_location_id`. Se rep migrou de NY pra SP, recurring "0 18 * * *" criado em NY vai:
- Disparar quando `now()` em SP timezone for 18:00 (route.ts decide firing).
- Próximo `next_run_at` calculado pelo runner na tz NY (advanceTask linha 248: usa task.location_id, não rep.active).
- Resultado: 1° disparo em SP às 18h, próximo será NY às 18h (= 21h em SP). Horário muda pro rep sem ele saber.

### BUG #10 (HIGH) — Default whatsapp + código morto no canal

reminders.ts:90-92:
```
const deliveryChannel = requestedChannel && validChannels.includes(requestedChannel)
  ? requestedChannel
  : (ctx.confirmationMode ? "whatsapp" : "whatsapp"); // default whatsapp
```
Ternário sem efeito (ambos branches `"whatsapp"`). Em web, se LLM esqueceu de passar delivery_channel, vira whatsapp → BUG #7 mata o reminder. Default deve ser sensitive ao canal de origem (passar `channel` no ToolContext).

### BUG #12 (HIGH) — Cancel cross-canal pode falhar por id divergente

Se rep agendou reminder via WhatsApp (rep_a) e identifica via web cria rep_b (ex: phone null pelo placeholder webonly:), cancel rejeitado em reminders.ts:212-214. Erro genérico ("Reminder não pertence a você") confunde o LLM e o rep.

## UX gaps

1. **Rep não sabe onde recebe lembrete** (reminders.ts:153-178): list_my_reminders omite `delivery_channel`. Se rep tem 3 lembretes e quer mover todos pro web, ele tem que adivinhar.
2. **Confusão create_task vs schedule_reminder mantida**: prompt-builder explica diferença mas omite que create_task EXIGE contact_id. Rep "me lembra amanhã 10h de pagar a conta" vira schedule_reminder corretamente — mas rep "criar task amanhã 10h" sem contato ambíguo. LLM hoje provavelmente cai em schedule_reminder por sorte.
3. **Cancel cross-canal silencioso** (BUG #12): rep web tentando cancelar reminder agendado via WhatsApp recebe "não pertence a você" — texto técnico que sugere bug, não cross-canal.

## Race conditions / consistência DB

### Atomic claim em fireScheduledReminders

`UPDATE assistant_scheduled_tasks SET status='running' WHERE status='pending' AND next_run_at <= now() ... RETURNING *` (reminder-runner.ts:40-48):

- ✅ É atômico do ponto de vista do Postgres: row-level lock no UPDATE garante que 2 crons em paralelo não fazem dupla-claim do mesmo `id`. O segundo cron pega zero rows.
- ✅ Funciona pra concorrência cron Vercel + pg_cron 30s (migration 00032).
- ⚠️ Sem reaper: se runner crasha após claim (OOM, deploy mid-fire), tasks ficam em `status='running'` eternamente. **Não há reset job**. (BUG #15)
- ⚠️ Sem `claimed_at` timestamp pra detectar tasks orfãs.

### Cancel vs claim corrida

Janela exata da race (BUG #5):
1. T0: cron faz UPDATE atomico — task vira `running`.
2. T0+ε: rep manda "cancela X" via WhatsApp.
3. T0+1s: webhook → schedule_reminder → cancel_reminder lê `status='running'` → retorna erro.
4. T0+2s: runner termina fireOne → mensagem entregue.

Rep cancelou e ainda recebeu. Patterns possíveis:
- (a) Soft-cancel: `UPDATE status='cancelled' WHERE id=X AND status IN ('pending','running')` — runner check `status='cancelled'` antes de deliverReminder e aborta.
- (b) Cancel em `running` retorna info "vou disparar em segundos, mas marquei pra parar de repetir" — útil pra recurring, suficiente pro one-shot perdido.

### UNIQUE NULLS NOT DISTINCT (migration 00040)

00033 (atomic dispatch) confiou em ON CONFLICT (rep_id, rule_id, target_id) casando NULLs como iguais. Postgres default trata cada NULL como distinct → constraint violation **não dispara** se target_id é NULL → ON CONFLICT não casa → INSERT cria nova row a cada call → cooldown ignorado pra regras globais.

00040:154-185 corrige com `UNIQUE NULLS NOT DISTINCT`. Mas:
- Requer Postgres ≥15. Supabase Cloud usa ≥15 desde mid-2024 — provavelmente OK em prod.
- DO $$ block linha 162-180 dropa constraint pelo nome. Frágil se schema teve nome customizado.
- **Confirmação status: revisar `supabase migration list`** pra ver se 00040 foi aplicada.

Mitigação alternativa (já presente em 00040 comentário linha 159-161): "dependemos de NUNCA passar target_id NULL". Verificação: `dispatcher.ts:244` passa `targetId = null` quando `input.targetId` undefined (linha 217). E `route.ts:75` passa `target_id: null` literal. Logo: regras globais (Resumo matinal etc) PASSAM target_id NULL. Se 00040 não aplicada, **claim atômico está quebrado pra todas regras scheduled em V2**.

## Recomendações ordem prioridade

### P0 — bloqueadores (fix imediato)

1. **BUG #7** (CRITICAL): implementar entrega real WhatsApp ou bloquear `delivery_channel='whatsapp'` até V3. Mínimo: remover `read_in_web_at=now()` em reminder-runner.ts:187 pra rep ver no web. — **HOJE**
2. **BUG #14** (quiet_hours bypass): adicionar `isInQuietHours` em `fireScheduledReminders` antes de fireOne. — **HOJE**
3. **Confirmar migration 00040 aplicada em prod** (pg_constraint check). Se não aplicada, regras scheduled têm cooldown quebrado.

### P1 — alta prioridade (próxima sprint)

4. **BUG #5** (cancel race): cancel deve aceitar `status IN ('pending','running')` e abortar fireOne via re-check antes de deliverReminder.
5. **BUG #4** (TZ drift): decidir fonte canônica do timezone (snapshot na task ou rep.active_location). Documentar.
6. **BUG #10** (default channel + código morto): passar `channel` no ToolContext, usar como default em schedule_reminder. Remover ternário inútil.
7. **BUG #12** (cross-canal cancel): unificação rep_identities mais robusta (ou cancel valida via lookup ghl_users do rep).
8. **BUG #15** (status='running' órfão): reaper cron a cada 5min `UPDATE...status='pending' WHERE status='running' AND last_run_at IS NULL AND created_at < now()-interval '10 min'`.

### P2 — médio prazo (UX e observabilidade)

9. **BUG #11**: list_my_reminders retornar `delivery_channel`. Trivial.
10. **BUG #3**: validar cron na schedule_reminder (rejeitar combinações impossíveis: dom>28 + mes=2). Bonus: adicionar `failure_reason` em payload pra debugging.
11. **BUG #2**: idempotência em delivery_channel='both' — UNIQUE em (metadata->>reminder_id, channel) ou checar antes de insert.
12. **BUG #13** (V3 plug): trocar linha 71 do route.ts por `await dispatchRule({mode:'real', ...})` quando V3 ativa.
13. **BUG #6** (test_session_id leak): log+telemetria em prod quando task com test_session_id chega no fireOne.

### P3 — limpeza

14. **BUG #16**: inline/remove `deliverReminderTestSession`.
15. **BUG #17**: atualizar prompt-builder esclarecendo "create_task exige contact_id".
16. **BUG #1**: corrigir comentário stale em 00031 (assistant_test_messages → agent_test_messages).

## Notas adicionais

- O dispatcher (system rules) e o reminder-runner (lembretes do rep) compartilham uma tabela conceitual (proatividade) mas usam mecanismos de claim **diferentes** (RPC try_claim_dispatch_slot vs UPDATE direto). Vale documentar a justificativa: alert_state precisa de cooldown granular por (rule, target), scheduled_tasks precisa apenas de single-fire — mas custo é manter 2 padrões. Considerar SQL function `try_claim_scheduled_task(p_id)` por consistência.
- A presença de `ASSISTANT_HUB_LOCATION_ID` env var é critical pra todo delivery (linhas 128/168 do reminder-runner). Se não setado, deliveries silenciosamente skipam (apenas console.warn). Telemetria/alerta seria útil.
- system-rules.ts:182 cron "0 8 * * 1-5" pra Resumo matinal — comentário diz "timezone resolvido em runtime". Mas cron em V2 simulated nunca atinge dispatchRule (apenas `skipped_disabled`). Isso bate com BUG #13.
