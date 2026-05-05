# Decision Log — Spark AI Hub

Index de decisões arquiteturais referenciadas no código. Códigos `H<n>`, `C<n>`, `P<n>`, `NB-<n>` aparecem como anchors em comments inline tipo `// H8 (review 2026-04-28): ...`.

**Convenção:**
- `H<n>` — High-priority finding do review (HIGH severity)
- `C<n>` — Critical bug fixed
- `P<n>` — Priority bug (P0 = blocker, P1 = high)
- `NB-<n>` — "New Bug" encontrado durante validation agent run

Quando criar nova entry: pegue próximo número disponível na categoria, adicione linha aqui + comment no código.

---

## Críticos (`C<n>`)

| Code | File:line | Data | Sumário | Ref |
|------|-----------|------|---------|-----|
| **C1** | `proactive/reminder-runner.ts:186` | 2026-04-29 | Tenta enviar WhatsApp real via GHL conversations/messages. Antes deste fix, lembretes WhatsApp NUNCA chegavam no celular — só marcavam pending_v3_send que ninguém consumia. Agora com fallback pro web channel se GHL falha. | `_planning/_review-2026-04-29/00-RELATORIO-EXECUTIVO.md` |
| **C2** | (resolvido em commit `c66b956`) | 2026-04-30 | Webhook chamava processIncoming SEM conversationHistory → bot era amnésico em produção real (synthetic-test funcionava porque lia agent_test_messages). | `_planning/_review-2026-04-29/` |
| **C3** | (commit `e5782e3`) | 2026-04-30 | Firebase JWKS verify pra Sparkbot. Service account real do GHL (não `securetoken@system`), tokens sem `kid`, JWKS endpoint `/robot/v1/metadata/jwk`, alternância entre service accounts. | `src/app/api/sparkbot/check-admin/route.ts` |
| **C4** | `webhook-handler.ts:476` + `transcribe/route.ts:81` | 2026-04-30 | Cobra Whisper se webhook recebeu áudio. Antes, `transcribeAudioFromUrl` rodava mas NUNCA cobrava — Sparkbot WhatsApp Whisper 100% free. Plus: `agent_id` deve ser `hubAgent.id` (FK válida), não `rep_id`. | review 04-29 |

## Highs (`H<n>`)

| Code | File:line | Data | Sumário | Ref |
|------|-----------|------|---------|-----|
| **H1** | `account-assistant/llm-client.ts:16` | 2026-04-28 | Stress test mostrou 6 de 7 falhas conversacionais (hallucinations, compliance flexível) em GPT-4.1 fallback — nenhuma em Claude. Em vez de fallback agressivo, agora tenta Anthropic Sonnet → Haiku → OpenAI só em terminal failure. `STRICT_CLAUDE_ONLY=1` desativa OpenAI. | `_planning/ultra-review-findings.md` |
| **H2** | `lib/queue/processor.ts:137` | 2026-04-28 | Cada grupo de mensagens é INDEPENDENTE no processor. Antes, falha de 1 grupo abortava o batch inteiro. | review 04-28 |
| **H4** | `lib/ai/prompt-builder.ts:860` | 2026-04-28 | Schema do data-fields tinha único formato; agora suporta múltiplos para diferentes carrier KBs. | review 04-28 |
| **H6** | `lib/ai/action-executor.ts:263` | 2026-04-28 | GHL API retorna formato variável (objeto vs array, depending on endpoint). Normaliza antes de processar. | review 04-28 |
| **H8** | `account-assistant/tools/index.ts:113` | 2026-04-28 | Gate de confirmação enforced em CÓDIGO, não só prompt. `confirmation_mode` (always/medium_and_high/high_only) bloqueia execução se LLM não enviar `confirmed_by_rep:true`. Schema injetado dinamicamente em `withConfirmationParam`. | `_planning/_review-2026-04-28/code-review/sparkbot-tools.md` |
| **H9** | `account-assistant/llm-client.ts:37` | 2026-04-28 | Tool result truncation preserva HEAD+TAIL — antes truncava só o final, exatamente onde `get_conversation_history` retorna msgs MAIS RECENTES. Pre-meeting briefing system-rules.ts:36-43 estava recebendo dados truncados. | review 04-28 |
| **H11** | `lib/queue/processor.ts:52` | 2026-04-28 | `LIMIT 100` por chamada do processor. Atomic claim do reaper evita oversubscription. | review 04-28 |
| **H12** | `lib/queue/processor.ts:47` | 2026-04-28 | Reaper inline. Antes msgs em status `processing` ficavam stuck se lambda crashasse — agora reaper detecta e libera (>30min). | review 04-28 |
| **H13** | `account-assistant/llm-client.ts:340` | 2026-05-03 | `cache_creation_input_tokens` ausente do `totalPromptTokens`. Subfaturava ~40K tokens por nova sessão (1º turn é cache miss → tools+system vão pra `cache_creation`, código só somava `input + cache_read`). Fix: somar os 3 buckets, igual formato OpenAI. | bug observado em prod 2026-05-03 |
| **H14** | `account-assistant/identity.ts` + `processor.ts` + `dispatcher.ts` | 2026-05-03 | Timezone do REP (não da location) é fonte da verdade. Rep BR levou lembrete em horário NY porque processor pegava `location.timezone` (set como America/New_York pelo admin da agência). Captura `user.timezone` do GHL no identify, persiste em `rep_identities.timezone`, lazy backfill no processor pra rows pré-00045. Resolution: `rep.timezone → location.timezone → America/New_York`. | bug observado em prod 2026-05-03 |
| **H14b** | `account-assistant/tools/identity.ts` + `prompt-builder.ts` | 2026-05-03 | Refinamento Pedro: GHL.user.timezone é fonte de verdade silenciosa (sem perguntar na frente). Tool `confirm_rep_timezone` pra mudança manual ('to em SP agora'). Após scheduling, bot SEMPRE informa fuso usado + oferece troca ('Lembrete agendado pra 11:18 AM (Florida — EDT). Outro fuso? me avisa.'). Migration 00046: coluna `timezone_confirmed_at` distingue confirmação verbal vs auto-detect. | conversa 2026-05-03 |
| **H15** | `account-assistant/prompt-builder.ts` | 2026-05-03 | Anti-hallucination: bot respondeu "Lembrete agendado pra 11:18 ✓" sem chamar `schedule_reminder`. Causa: prompt confuso (medium_and_high dizia "executa E informa 'feito'" mas gate código bloqueia medium sem `confirmed_by_rep`). Fix: confirmText alinhado com código + bloco "REGRA INVIOLÁVEL — NUNCA finja que tool rodou" + sub-regra dedicada pra `schedule_reminder` (5 passos). | bug observado em prod 2026-05-03 |
| **H16** | `account-assistant/processor.ts:90-100` + `terms.ts` | 2026-05-04 | Onboarding inline pós-aceite dos termos: ao invés de perguntar fuso pro rep, lê de `location.timezone` do GHL e auto-confirma + manda guia rápido de exemplos numa única mensagem. Reduz fricção de 3 turnos pra 1. Agente pode mudar fuso depois ("to em SP agora"). | conversa Pedro 2026-05-04 |
| **H17** | `account-assistant/identity.ts:detectIsInternal` + migration 00048 | 2026-05-04 | Internal team (agency owner/admins) NÃO é cobrado pelo wallet GHL. Detecção em camadas: env `INTERNAL_TEAM_PHONES` → role `agency`/`agency_owner` → heurística "5+ ghl_users". Flag `is_internal` em rep_identities; `trackAndCharge` skipa charge mas mantém audit em usage_records via `usesCustomKey: true`. | conversa Pedro 2026-05-04 |
| **H18** | `lib/billing/pricing.ts:61` + `charge.ts:isMonthlyCapReached` + migration 00049 | 2026-05-04 | Hard cap mensal de $100/sub-account pra blindar runaway (loop, abuso, bug). Markup ajustado pra 10% (de 20%) — Pedro foco em adoção. Quando cap atingido: `cap_blocked=true` em usage_records + skip `chargeWallet` + bot continua respondendo (UX preservada). Coluna `monthly_spend_cap_usd` em agent_configs (default 100, NULL = sem cap). | conversa Pedro 2026-05-04 |
| **H19** | `lib/utils/cors.ts` + endpoints `/api/sparkbot/*` | 2026-05-04 | CORS allowlist centralizado. Antes: `Access-Control-Allow-Origin: *` em 6 endpoints. Agora: regex allowlist (gohighlevel.com, leadconnectorhq.com, msgsndr.com, sparkleads.pro, próprio app, localhost dev). Inclui `Vary: Origin` pra cache-correctness. | audit security 2026-05-03 |
| **H20** | `embed/sparkbot/loader/route.ts:iframe` | 2026-05-04 | Iframe sandbox attribute: `allow-scripts allow-same-origin allow-forms allow-popups allow-modals`. Limita capacidades do iframe enquanto preserva UX (mic, fetch ao próprio domínio, links). | audit security 2026-05-03 |
| **H21** | `account-assistant/identity.ts:identifyRepByGhlUser` | 2026-05-04 | check-admin 500 em sub-account nova (Pedro reportou em v3xt9lZ3GhEGvyvl6sgN). Causa: GHL API não retornou phone, code caía em INSERT com `webonly:<ghlUserId>` placeholder, batendo unique violation com rep_identity criada em session anterior. Fix: lookup em camadas — (3a) por ghl_user_id em ANY rep, (3b) por phone OR placeholder. Append link se achou; senão cria. + DB cleanup: merge 84ab5b5b... no Pedro principal. | bug observado em prod 2026-05-04 |
| **H22** | `components/agents/account-assistant/setup-wizard.tsx` + `api/agents/sparkbot/onboarding-status/route.ts` | 2026-05-04 | Setup Wizard no AI Hub: card destaque com QR code WhatsApp + link wa.me + polling 5s do endpoint pra detectar primeira msg do rep. Auto-some quando ativa (`first_time=false`). Mostra aviso se admin não tem phone cadastrado no GHL (reason_no_phone). Lib `qrcode` adicionada. | conversa Pedro 2026-05-04 |
| **H23** | `account-assistant/tools/identity.ts:switchActiveLocation` + `block_calendar_slot` + `report_missed_capability` | 2026-05-04 | 3 tools novas: switch_active_location (rep multi-tenant troca sub-account ativa), block_calendar_slot (compromisso pessoal sem ser appointment com cliente), report_missed_capability (auto-registra "rep pediu X que não consigo" pro painel admin). | conversa Pedro 2026-05-04 |
| **H24** | `lib/account-assistant/tools/bulk-messages.ts` + 7 tools | 2026-05-04 | Tools de disparo em massa com drip mode (anti-WhatsApp ban): preview/schedule/list/get_progress/pause/resume/cancel. Filtro por tag, drip 90s±30s entre msgs, variation via Haiku, cap 100/dia/sub-account, quiet_hours obrigatório. Migration 00050. | conversa Pedro 2026-05-04 |
| **H25** | `app/admin/signals/*` + `lib/admin-signals/recorder.ts` + `middleware.ts` | 2026-05-04 | Painel /admin/signals (Basic Auth via env `ADMIN_PANEL_PASSWORD`) rastreando 4 tipos: failure/missed_capability/error/idea com fingerprint dedup (sha256 type+title). Hook em executeTool auto-registra erros. Tool `report_missed_capability` registra gaps de capacidade quando bot diz "não consigo". Migration 00051. | conversa Pedro 2026-05-04 |

## Críticos novos da ULTRA-REVIEW 2026-05-05 (`C5-C13`)

| Code | File:line | Data | Sumário | Ref |
|------|-----------|------|---------|-----|
| **C5** | `account-assistant/terms.ts:parseTermsResponse` | 2026-05-05 | Falso positivo "não tá ok" → ACCEPT por causa do `.includes(' ' + k)` em ACCEPT_KEYWORDS. Fix: NEGATION_PATTERN check ANTES de ACCEPT, normaliza acentos via NFD. LGPD risk corrigido. | ULTRA-REVIEW Track 1 C2 |
| **C6** | `account-assistant/processor.ts:99` + `identity.ts:rejectTerms` + migration 00052 | 2026-05-05 | Rejeição de termos não persistia → loop infinito reenviando termos. Adicionado `terms_rejected_at` na rep_identities + gate em processor que silencia bot daqui em diante. | ULTRA-REVIEW Track 1 C1 |
| **C7** | `account-assistant/identity.ts:identifyRep` | 2026-05-05 | Race rep_identity 23505 não capturado. 2 webhooks Stevo+GHL <100ms ambos passavam dedup, ambos tentavam INSERT, segundo falhava com error code 23505 — bot retornava null → "rep não cadastrado". Fix: capture 23505 + re-fetch row criada pelo competidor. | ULTRA-REVIEW Track 1 C3 |
| **C8** | `account-assistant/tools/reminders.ts:cancel_reminder` | 2026-05-05 | validateGhlId rejeitava UUIDs (regex `/^[A-Za-z0-9]+$/` não aceita hífens). 100% dos cancels falhavam em prod. Substituído por UUID v4 regex validation. | ULTRA-REVIEW Track 4 CRIT-1 |
| **C9** | `account-assistant/tools/identity.ts:switch_active_location` | 2026-05-05 | switch_active_location não recriava ctx.ghlClient após mutar locationId. Próximas tools no mesmo turn usavam token da location ANTIGA → cross-tenant leak risk (body.locationId NEW + Auth OLD). Agora reinstancia via dynamic import. | ULTRA-REVIEW Track 4 CRIT-2 |
| **C10** | `account-assistant/tools/calendar.ts:block_calendar_slot` | 2026-05-05 | Body inválido per spec Spark Leads: enviava `calendarId + assignedUserId` juntos (spec diz "either, not both") + campo `notes` que não existe. Tool 100% quebrada desde criação. Fix: só assignedUserId + sem notes. | ULTRA-REVIEW Track 4 CRIT-3 |
| **C11** | DB UPDATE `assistant_proactive_rules` | 2026-05-05 | 3 reactive rules `enabled=true` mas STUBADAS no código (Lead esfriando, Tarefa atrasada, Task vencendo). UI enganava rep mostrando ON. Disabled em prod até implementação. Apenas post_meeting é real. | ULTRA-REVIEW Track 6 C1 |
| **C12** | migration 00053_cron_guards_advisory_lock | 2026-05-05 | Cron pg_cron rodava 30s/30s independente de haver trabalho (pós-00041 removeu WHERE EXISTS guard) = 2880 calls/dia desnecessárias + sem advisory lock = double-execution risk. Recriado com pg_try_advisory_xact_lock(8675309) + WHERE EXISTS triplo (scheduled_tasks + proactive_rules + bulk_message_recipients). | ULTRA-REVIEW Track 6 H3 + Track 12 C1 |
| **C13** | migration 00056_usage_records_schema_drift_recovery | 2026-05-05 | Schema drift catastrófico: charge.ts inseria 8 colunas (cached_tokens, audio_seconds, image_count, claim_token, claimed_at, charged_at, cache_creation_tokens, audio_model) que NÃO existiam na tabela DB real (criada via SETUP.sql pré-00040). Supabase silently dropava → Whisper/Vision/cache billing quebrado em prod. ALTER TABLE retroativa. | ULTRA-REVIEW re-validation 2026-05-05 |
| **C14** | `account-assistant/tools/calendar.ts:calendarHasOpenHoursAt` | 2026-05-05 | Função usava `getUTCDay/getUTCHours` mas openHours/daysOfTheWeek estão em LOCAL time. Pra rep em EDT (UTC-4), slot 14:00 EDT = 18:00 UTC → função comparava 18 com closeHour=18 → fora de BH → INTERSECT-conservador virava no-op silencioso. Caso Marcos podia reaparecer sem detecção. Fix: Intl.DateTimeFormat com timeZone do rep pra extrair local weekday/hour/minute corretos. 8 unit tests passam. | calendar bug-proof re-review 2026-05-05 |
| **C15** | `account-assistant/tools/calendar.ts:listMyFreeSlots` | 2026-05-05 | Tool USER-CENTRIC (`list_my_free_slots`) criada separada de CALENDAR-CENTRIC (`get_free_slots`). Bug histórico: bot misturava semânticas, calculava livre via `list_appointments` + reasoning manual → perdia Google Calendar blocks (cliente Marcos perdeu credibilidade). Fix arquitetural: 2 tools dedicadas — UNION de /free-slots dos rep's calendars + subtract events cross-calendar (filter client-side por assignedUserId, não passa userId que filtra por createdBy) + INTERSECT-conservador best-effort pra detectar Google blocks via gap entre calendars com BH coverage. | bug observado em prod Marcos 2026-05-05 |
| **C16** | `account-assistant/tools/calendar.ts:listMyFreeSlots` + types `ToolResult` | 2026-05-05 | Quando TODOS os event lookups falhavam, tool retornava status:ok com slots — bot apresentava como livres sem ter detectado conflicts. Adicionado novo status `degraded` no `ToolResult` union + warning crítico no payload + prompt instrui LLM a SEMPRE pedir confirmação verbal antes de marcar appointment a partir de slot degraded. computeWindowInTz também ganhou fallback "America/New_York" pra tz inválido (RangeError defense). | calendar bug-proof re-review 2026-05-05 |
| **C17** | `account-assistant/tools/calendar.ts:startOfDayInTz` | 2026-05-05 | BUG GRAVE descoberto via test direto contra GHL real (script `scripts/test-marcos-free-slots.ts`): algoritmo antigo `utcMidnight - h*60min` funcionava só pra timezones com offset POSITIVO (Asia/Europe/Pacific). Pra negative offsets (Americas), calculava midnight do dia ANTERIOR no tz. ROOT CAUSE provável do caso Marcos original — bot retornava window do dia errado pra TODOS reps US. Fix: calcula offset real do tz comparando "what tz sees" vs UTC com Date.UTC(), funciona pra qualquer offset. | test direto Marcos 2026-05-05 |
| **C18** | `account-assistant/tools/calendar.ts:listMyFreeSlots INTERSECT-conservador` | 2026-05-05 | Bug observado via screenshot agenda visual Marcos: heurística era too eager — qualquer 1 calendar missing virava "suspect block", removendo slots GENUINAMENTE LIVRES. Caso real: Marcos tem 7 calendars, mas só 6 usam Work Hours schedule + 1 (Calendário-Agência) é admin-only (nunca retorna slot público). INTERSECT antigo via "Agência missing + BH OK" e removia slots → 0 livres em dia com 4h livres. Fix: (a) silent calendars (zero slots em todo range) filtrados do baseline, (b) threshold 50%+ missing (não 1+), (c) min 3 calendars-com-BH pra ter sample size confiável. | screenshot validation 2026-05-05 |
| **C19** | `lib/ghl/auth.ts:getLocationToken` | 2026-05-05 | Token mutex em getLocationToken — antes, list_my_free_slots disparava 37 requests paralelas que se token expirado batiam todas em /oauth/locationToken simultaneamente (rate limit risk + token invalidation race). Fix: inFlightTokenRefresh Map coalesce concurrent refreshes — só 1 fetch real, restantes aguardam mesma promise. Afeta TODO o sistema (não só calendar). | bug-proof audit 2026-05-05 HIGH-1 |
| **C20** | `account-assistant/tools/calendar.ts:listMyFreeSlots events handling` | 2026-05-05 | Distinguir eventsFailed (transient: 5xx/network) de eventsMissingField (200 OK sem events array — silent GHL corruption) de eventsNotFound (404 calendar deletado). Antes, payload corrompido contava como sucesso "0 events" e bot apresentava livre com falsa confiança; 404 inflava warning_partial desnecessariamente. | bug-proof audit 2026-05-05 CRIT-2 + CRIT-5 |
| **C21** | `account-assistant/tools/calendar.ts:listMyFreeSlots conflict check` | 2026-05-05 | Per-source duration tracking. Antes Math.max usava maior duration → calendar A 30min livre 14h era bloqueado por conflict 14:30 porque calendar B 60min conflitava. Agora slot só removido se TODAS as sources conflitam (mais permissivo, evita esconder livre legítimo). + dedup conflicts por event.id (mesmo event 2x se rep é assignee em 2 calendars). | bug-proof audit 2026-05-05 HIGH-4 + MED-3 |
| **C22** | `account-assistant/tools/calendar.ts:calendarHasOpenHoursAt` | 2026-05-05 | Suporte a overnight calendars (open 22:00 → close 02:00). Antes closeMin < openMin → no-op silencioso, calendars noturnos tratados como NUNCA abertos. Agora detecta wrap-around: `slotMin >= openMin OR slotMin < closeMin`. | bug-proof audit 2026-05-05 MED-1 |
| **C23** | `account-assistant/tools/calendar.ts` (defesa em profundidade) | 2026-05-05 | Múltiplos hardenings: (a) encodeURIComponent em URL paths com IDs (defesa contra path injection), (b) slotDuration validation (rejeita 0/null/negative), (c) endTime <= startTime → ignora event corrupto (antes virava "ocupado dia todo"), (d) cancel statuses inverter pra positive list (antifragil contra GHL adicionar status novo), (e) parsing defensivo slots (string corrupta vira [], date-shape validation pra keys), (f) listAppointments tz-aware (antes setHours UTC servidor). | bug-proof audit 2026-05-05 MED-2/4/5, HIGH-6, LOW-1/3/4 |

## Priority (`P<n>`)

| Code | File:line | Data | Sumário | Ref |
|------|-----------|------|---------|-----|
| **P0** | `lib/billing/charge.ts:26` | 2026-04-28 | `usage_records` referenciada no código mas tabela não existia em prod. Migration 00040 criou. Drift recovery: `chargeUnbilledRecords()` cobra retroativamente. | `_planning/_review-2026-04-28/code-review/billing.md` |
| **P0** (audio) | `lib/ai/history-compressor.ts:39` | 2026-04-28 | Cobrança opcional de audio_seconds via `audioMetaSink` — antes Whisper rodava free. | review 04-28 |
| **P1** | `lib/billing/charge.ts:198` | 2026-04-28 | Claim atômico via `UPDATE ... RETURNING` pra evitar double-charge em retries concorrentes. | review 04-28 |

## New Bugs from validation (`NB-<n>`)

| Code | File:line | Data | Sumário |
|------|-----------|------|---------|
| **NB-1** | (validation 2026-05-02) | 2026-05-02 | Cleanup duplo de `releaseInFlight` em path de dedup SELECT — cosmético, `Map.delete` é safe no-op. |
| **NB-2** | webhook-handler.ts mutex | 2026-05-02 | `inFlightMessages` Map é per-lambda. Documentado nos comments — race cross-lambda fica pra UNIQUE constraint pegar. |
| **NB-3** | webhook-handler.ts:30-39 | 2026-05-02 | GC entries expiradas só roda em entry de `tryClaimInFlight`. Bound: traffic × 60s. Acceptable. |
| **NB-6** | `webhook-handler.ts:410` | 2026-05-02 | Sticky tabular cache extendido pra `kind === "audio"` — rep manda CSV → confirma via voice memo. Antes só `kind === "text"`. |

## Sem código mas relevante (decisões de produto)

| Tema | Data | Decisão |
|------|------|---------|
| **Multi-hub Sparkbot** | 2026-05-02 | Aceita qualquer location com agent ativo `account_assistant`. Antes era single-hub via `ASSISTANT_HUB_LOCATION_ID`. |
| **GHL multi-provider dedup** | 2026-05-03 | Stevo (Evolution) + WhatsApp Business API ambos plugados. Cada msg física gera 2 webhooks com `messageId` diferentes. Stack de 7 camadas de dedup. |
| **OpenAI quota alert** | 2026-05-03 | Quando Whisper retorna 429, msg específica ao rep + log destacado. Sem isso, falha aparecia como "Não consigo processar áudio". |
| **Claude rejeita user msg vazio** | 2026-05-03 | Filter `content=""` antes de mandar histórico ao LLM + nunca persistir vazio. Cleanup retroativo de 4 rows. |
| **Outbound channel routing** | 2026-05-02 | `ASSISTANT_OUTBOUND_CHANNEL` env (`SMS` default agora; `auto` futuro com window 24h check). |

---

## Como adicionar entry

1. Escolha categoria: `H` (high), `C` (critical), `P0/P1`, `NB-` (validation findings)
2. Pegue próximo número disponível: maior `H` atual é H12, próximo é H13
3. Add linha na tabela acima
4. Add comment no código: `// H13 (review YYYY-MM-DD): <sumário curto>`
5. Commit com referência: `fix(scope): <ação> (H13)`
