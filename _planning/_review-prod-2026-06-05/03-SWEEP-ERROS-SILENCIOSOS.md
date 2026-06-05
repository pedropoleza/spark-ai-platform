# Sweep de erros silenciosos (F49) — mapa do mini-swarm 2026-06-05

Total findings: 110 · dedup: 103 · worth_fixing: 52 (high 17, medium 35)

**STATUS HIGH: 17/17 ✅ FEITO** (5 deployados em `a1d3f7f` + 12 em lote A–D pós-compact 2026-06-05). Severidades recalibradas vs swarm: persistência web_ui/billing pequeno = `medium`; crash rep-facing (sem resposta) = `high`. MEDIUM (35) seguem pendentes pra lote de observabilidade.

## HIGH (perda de dado/dinheiro/crash) — ✅ TODOS COBERTOS

- [x] `src/app/api/sparkbot/send/route.ts:190` — **sparkbot-messaging** — msg do rep não persistida → reportError `medium`
- [x] `src/app/api/sparkbot/send/route.ts:284` — **sparkbot-messaging** — resposta do agente não persistida → reportError `medium`
- [x] `src/app/api/sparkbot/transcribe/route.ts:125` — **sparkbot-transcribe** — billing Whisper falhou → reportError `medium`
- [x] `src/app/api/agents/process-batch/route.ts:25` — **agent-queue** — crash pipeline lead-facing → reportError `critical` (a1d3f7f)
- [x] `src/lib/account-assistant/webhook-handler.ts:278` — **sparkbot-webhook** — falha ao buscar contato do hub → reportError `high`
- [x] `src/app/api/webhooks/inbound-message/route.ts:505` — **sparkbot-handoff** — erro ao processar handoff outbound → reportError `medium`
- [x] `src/lib/account-assistant/webhook/stevo-handler.ts:379` — **sparkbot-inbound-stevo** — processIncoming lançou → reportError `high`
- [x] `src/app/api/cron/billing-retry/route.ts:42` — **cron-billing-retry** — crash → reportError `high` (a1d3f7f)
- [x] `src/app/api/cron/refresh-ghl-token/route.ts:51` — **cron-refresh-ghl-token** — crash → reportError `critical` (a1d3f7f)
- [x] `src/app/api/cron/summary-notes/route.ts:19` — **cron-summary-notes** — crash → reportError `high` (a1d3f7f)
- [x] `src/app/api/admin/dashboard/route.ts:499` — **admin-dashboard** — crash (admin-only) → reportError `medium`
- [x] `src/app/api/agent-platform/builder/compose/route.ts:177` — **agent-platform-compose** — IA falhou (fallback degradado) → reportError `medium`
- [x] `src/lib/account-assistant/proactive/reminder-runner.ts:443` — **proactive-reminder** — outbound agendado pro contato não saiu → reportError `high`
- [x] `src/lib/billing/charge.ts:123` — **billing-charge** — wallet charge falhou → reportError `high` (a1d3f7f)
- [x] `src/lib/ai/openai-client.ts:333` — **openai-client** — ⚠️ REALOCADO → instrumentado em `queue-processor.ts:~1046` (pausa do loop de 2+ parse fails). Reportar no openai-client dispararia em toda falha transitória recuperada pelo retry = ruído. reportError `high` no ponto "lead travado".
- [x] `src/lib/ai/history-compressor.ts:79` — **history-compressor** — summarization falhou (fallback truncação) → reportError `medium`
- [x] `src/lib/ai/audio-transcriber.ts:110` — **audio-transcriber** — fetch do áudio falhou → reportError `medium`

## MEDIUM (observabilidade) — lote seguinte

- [ ] `src/app/api/sparkbot/scheduling-prefs/route.ts:62` — sparkbot-scheduling — Calendar list fetch not signaled to admin
- [ ] `src/app/api/sparkbot/scheduling-prefs/route.ts:103` — sparkbot-scheduling — POST calendar validation fetch not reported
- [ ] `src/app/api/agents/contact-status/route.ts:63` — agents-contact-controls — catch block only logs, no signal for agent state fetch failure
- [ ] `src/app/api/agents/contact-agents/route.ts:111` — agents-contact-controls — catch block only logs, no signal for multi-agent state fetch failure
- [ ] `src/app/api/agents/contact-ai-messages/route.ts:73` — agents-contact-controls — catch block only logs, no signal for agent message history fetch failure
- [ ] `src/app/api/agents/test/route.ts:446` — agent-testing — catch block in background waitUntil only logs, no signal for action execution failure
- [ ] `src/app/api/agents/message-feedback/route.ts:70` — agents-contact-controls — catch block only logs, no signal for feedback insert failure
- [ ] `src/app/api/agents/contact-pause/route.ts:96` — agents-contact-controls — catch block only logs, no signal for pause/resume state update failure
- [ ] `src/app/api/agents/contact-activate/route.ts:92` — agents-contact-controls — catch block only logs, no signal for agent activation/deactivation failure
- [ ] `src/app/api/agents/conversation-contact/route.ts:46` — agents-contact-controls — catch block only logs, no signal for GHL conversation fetch failure
- [ ] `src/app/api/agents/test/transcribe/route.ts:48` — agent-testing — catch block only logs, no signal for audio transcription failure
- [ ] `src/app/api/agents/account-assistant/test/route.ts:58` — sparkbot — catch block only logs, no signal for GHL user phone fetch failure
- [ ] `src/lib/account-assistant/webhook-handler.ts:680` — sparkbot-billing — Whisper billing error not signaled
- [ ] `src/lib/account-assistant/webhook-handler.ts:708` — sparkbot-history — Conversation history read error not signaled
- [ ] `src/app/api/ghl/calendars/route.ts:20` — ghl-integration-calendars — GHL calendars: endpoint falha silenciosamente (fallback interno)
- [ ] `src/app/api/ghl/pipelines/route.ts:21` — ghl-integration-pipelines — GHL pipelines: endpoint falha silenciosamente (fallback interno)
- [ ] `src/app/api/ghl/tags/route.ts:21` — ghl-integration-tags — GHL tags: endpoint falha silenciosamente (fallback interno)
- [ ] `src/app/api/ghl/custom-fields/route.ts:41` — ghl-integration-custom-fields — GHL custom-fields: endpoint falha silenciosamente (fallback interno)
- [ ] `src/lib/account-assistant/proactive/dispatcher.ts:400` — proactive-dispatcher — loadCarrierTier1 failure swallowed without signal
- [ ] `src/lib/account-assistant/proactive/dispatcher.ts:592` — proactive-dispatcher — Billing calculation failure not signaled to admin
- [ ] `src/lib/account-assistant/proactive/outreach-runner.ts:184` — proactive-outreach — runOutreachForAgent failure silently swallowed in batch loop
- [ ] `src/lib/account-assistant/proactive/bulk-message-runner.ts:371` — proactive-bulk-runner — Tick success recording failure prevents health tracking (silently loses metrics)
- [ ] `src/lib/account-assistant/proactive/bulk-message-runner.ts:423` — proactive-bulk-runner — Tick error recording failure prevents error signal/streak tracking
- [ ] `src/lib/account-assistant/proactive/bulk-message-runner.ts:536` — proactive-bulk-runner — Main send failure only returns error without signal, swallowed in receiver logic
- [ ] `src/lib/account-assistant/proactive/reminder-runner.ts:114` — proactive-reminder — Reminder task execution failure only logs, no signal (user waits indefinitely for reminder)
- [ ] `src/lib/account-assistant/proactive/reminder-runner.ts:423` — proactive-reminder — Scheduled outbound send failure not signaled (message lost silently)
- [ ] `src/lib/account-assistant/proactive/followup-runner.ts:216` — proactive-followup — Followup message processing exception only logs error, no signal
- [ ] `src/lib/account-assistant/proactive/recurring-runner.ts:94` — proactive-recurring — Recurring campaign fire failure in batch loop only logs, no signal
- [ ] `src/lib/account-assistant/proactive/sequence-runner.ts:102` — proactive-sequence — Sequence state advancement failure only logs, no signal (state corruption risk)
- [ ] `src/lib/queue/handoff-notify.ts:244` — lead-awareness-handoff — Handoff delivery failure only logged to console, not signaled
- [ ] `src/lib/queue/summary-note-generator.ts:351` — summary-note-runner — Summary note generation failure silently increments error counter without signal
- [ ] `src/lib/queue/follow-up-scheduler.ts:229` — followup-scheduler — DND check failure only console.warned, follow-up marked failed without audit signal
- [ ] `src/lib/ai/media-processor.ts:38` — media-processor — Media download failure only logged, not signaled
- [ ] `src/lib/ai/media-processor.ts:100` — media-processor — PDF extraction failure only logged to console
- [ ] `src/lib/ai/media-processor.ts:135` — media-processor — DOCX extraction failure only logged to console