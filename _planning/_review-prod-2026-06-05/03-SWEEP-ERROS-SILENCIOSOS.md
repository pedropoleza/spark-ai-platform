# Sweep de erros silenciosos (F49) — mapa do mini-swarm 2026-06-05

Total findings: 110 · dedup: 103 · worth_fixing: 52 (high 17, medium 35)

## HIGH (perda de dado/dinheiro/crash) — atacar primeiro

- [ ] `src/app/api/sparkbot/send/route.ts:190` — **sparkbot-messaging** — User message insert not persisted silently
- [ ] `src/app/api/sparkbot/send/route.ts:284` — **sparkbot-messaging** — Agent response message not persisted silently
- [ ] `src/app/api/sparkbot/transcribe/route.ts:125` — **sparkbot-transcribe** — Billing for transcription silent failure
- [ ] `src/app/api/agents/process-batch/route.ts:25` — **agent-queue** — catch block only logs, no signal for queue and follow-up processing failure
- [ ] `src/lib/account-assistant/webhook-handler.ts:278` — **sparkbot-webhook** — Contact fetch error not signaled
- [ ] `src/app/api/webhooks/inbound-message/route.ts:505` — **sparkbot-handoff** — Outbound handoff processing error not signaled
- [ ] `src/lib/account-assistant/webhook/stevo-handler.ts:379` — **sparkbot-inbound-stevo** — ProcessIncoming exception not signaled
- [ ] `src/app/api/cron/billing-retry/route.ts:42` — **cron-billing-retry** — Cron billing-retry crash não sinalizado
- [ ] `src/app/api/cron/refresh-ghl-token/route.ts:51` — **cron-refresh-ghl-token** — Cron refresh-ghl-token crash não sinalizado
- [ ] `src/app/api/cron/summary-notes/route.ts:19` — **cron-summary-notes** — Cron summary-notes crash não sinalizado
- [ ] `src/app/api/admin/dashboard/route.ts:499` — **admin-dashboard** — Admin dashboard crash não sinalizado
- [ ] `src/app/api/agent-platform/builder/compose/route.ts:177` — **agent-platform-compose** — Agent platform compose: falha da IA não sinalizada (fallback silencioso)
- [ ] `src/lib/account-assistant/proactive/reminder-runner.ts:443` — **proactive-reminder** — Outbound task send failure persisted to DB but signal skipped in conditional path
- [ ] `src/lib/billing/charge.ts:123` — **billing-charge** — Wallet charge failure only console.error, no signal - charges may be lost silently
- [ ] `src/lib/ai/openai-client.ts:333` — **openai-client** — JSON parse failure not reported to admin signals
- [ ] `src/lib/ai/history-compressor.ts:79` — **history-compressor** — History summarization failure silently falls back without reporting
- [ ] `src/lib/ai/audio-transcriber.ts:110` — **audio-transcriber** — Audio fetch error logged but not reported to admin

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