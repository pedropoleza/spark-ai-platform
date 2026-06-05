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

## MEDIUM (observabilidade) — 18 instrumentados · 4 já cobertos · 13 deferidos

**STATUS: resolvido pós-compact 2026-06-05** (Lote 1 lost-work + Lote 2 valor). Calibração: lost-work proativo/queue = `medium`; degradado/defensivo/interno = `low`.

### ✅ Instrumentados (18)

- [x] `webhook-handler.ts:680` — sparkbot-billing — Whisper billing → `medium`
- [x] `webhook-handler.ts:708/711` — sparkbot-history — leitura de histórico do rep (crash) → `medium` (skip o ramo r.error :708 = "migration pendente" esperado)
- [x] `proactive/dispatcher.ts:400` — contexto de carrier indisponível → `low`
- [x] `proactive/dispatcher.ts:592` — billing do proativo → `medium`
- [x] `proactive/outreach-runner.ts:184` — tick de agente (era `.catch(()=>null)`) → `medium`
- [x] `proactive/reminder-runner.ts:114` — fireOne crashou (erro não-send) → `medium`
- [x] `proactive/followup-runner.ts:216` — msg de follow-up falhou → `medium`
- [x] `proactive/recurring-runner.ts:94` — campanha recorrente crashou → `medium`
- [x] `proactive/sequence-runner.ts:102` — avanço de estado falhou → `medium`
- [x] `queue/handoff-notify.ts:244` — entrega da notificação de handoff → `medium`
- [x] `queue/summary-note-generator.ts:351` — geração de nota-resumo (bare catch→err) → `low`
- [x] `queue/follow-up-scheduler.ts:229` — verificação de DND (bare catch→err) → `low`
- [x] `agents/contact-pause/route.ts:96` — mudança de estado de pausa → `medium`
- [x] `agents/contact-activate/route.ts:92` — ativação de agente por contato → `medium`
- [x] `agents/message-feedback/route.ts:64+70` — registro de feedback 👍/👎 (2 ramos, loop de aprendizado) → `medium`
- [x] `ai/media-processor.ts:38` — download da mídia (anexo ignorado) → `medium`
- [x] `ai/media-processor.ts:100` — leitura de PDF (semi-visível) → `low`
- [x] `ai/media-processor.ts:135` — leitura de DOCX (semi-visível) → `low`

### ⏭️ Já cobertos por signal existente — NÃO instrumentar (evita duplicata) (4)

- `proactive/bulk-message-runner.ts:371` — health-write meta-failure; o runner já emite `recordSignal` "N erros consecutivos" (:416).
- `proactive/bulk-message-runner.ts:423` — idem (a própria gravação do erro; o streak em :416 cobre).
- `proactive/bulk-message-runner.ts:536` — falha de send individual ROLA pro streak em :416 (reportar aqui = duplicata por tick).
- `proactive/reminder-runner.ts:423` — mesmo fluxo de send cujo catch (:443) já virou reportError `high` no lote HIGH.

### ⏸️ Deferidos deliberadamente — baixo valor de observabilidade (13)

Motivo: ou a falha **já é visível ao usuário** (endpoint de leitura cujo erro renderiza estado de erro/empty na UI), ou é **transitória com fallback interno** (picker GHL), ou **não-prod** (test chat). Instrumentar falha-já-visível só adiciona signal redundante (anti-pattern vs. disciplina do health UI). Triviais de ligar depois se quiser trend data — alvos abaixo:

- `sparkbot/scheduling-prefs/route.ts:62` + `:103` — fetch de calendário (tem fallback)
- `agents/contact-status/route.ts:63` — read UI (falha visível)
- `agents/contact-agents/route.ts:111` — read UI (falha visível)
- `agents/contact-ai-messages/route.ts:73` — read UI (falha visível)
- `agents/conversation-contact/route.ts:46` — read GHL conversa (falha visível)
- `agents/test/route.ts:446` + `agents/test/transcribe/route.ts:48` + `agents/account-assistant/test/route.ts:58` — test chat (não-prod)
- `ghl/calendars:20` + `ghl/pipelines:21` + `ghl/tags:21` + `ghl/custom-fields:41` — pickers GHL (transitório, fallback interno, picker vazio é visível)