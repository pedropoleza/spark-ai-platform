# CHANGELOG

Histórico organizado por feature/bugfix. Versionamento semântico informal — pegar marcos por funcionalidade, não por release date.

---

## [Em desenvolvimento] — 2026-05-03+

- Documentação fundacional: README real, CLAUDE.md, docs/DECISIONS, docs/RUNBOOK, CHANGELOG.

---

## [v0.4.2] — 2026-05-03 — Audio fixes + multi-provider dedup completo

### Fixed
- **Whisper falha silenciosa**: erros `429 quota_exceeded`, `401 invalid_key`, `429 rate_limited` agora propagam código estruturado via `transcribeAudioFromUrlVerbose`. Mensagem específica ao rep. Logs com severidade adequada (`⚠️ OPENAI QUOTA EXCEEDED`). Commits `81b2241`, `9cb5b39`, `f062788`.
- **Claude rejeitando todo histórico**: bot caiu 100% em GPT-4.1 silenciosamente porque histórico tinha user msgs com `content=""`. Filter no load + nunca persistir vazio + cleanup retroativo de 4 rows. Commit `f7f8911`.
- **Bot alucinando contact_id**: prompt-builder agora exige re-search antes de qualquer tool com contact_id. NUNCA reuse IDs do histórico (contatos podem ter sido deletados/renomeados). Commit `ac0edb4`.
- **Dedup multi-provider**: GHL+Stevo geram 2 webhooks com `messageId` diferentes pra mesma msg física. Stack de 7 camadas implementada:
  1. In-memory mutex (sub-segundo intra-lambda) — `52cd38d`
  2. SELECT por `ghl_message_id`
  3. `sparkbot_dedup_locks` UNIQUE PK (race <100ms cross-lambda) — `91d13d5`
  4. CONTENT-MATCH (15s window) — `b2094b4`
  5. TIMING-MATCH (5s window, audio/imagem) — `24a6946`
  6. UNIQUE constraint `sparkbot_messages.ghl_message_id`
  7. Placeholder rejection (smart — só sem attachment) — `102f20a`, `1daee41`
- **Áudio webhook sem URL**: Stevo manda body="Audio Message." + audio_url em `attachments`. Reprocessa explícito quando detecta. Commit `1daee41`.

### Added
- **Splitter de mensagens WhatsApp**: bot escreve `---` em linha sozinha → bolhas separadas (max 3 partes, 300ms delay). Commit `91d13d5`.
- **Formatação WhatsApp no system prompt**: `*negrito*`, `_itálico_`, listas numeradas, splitter. Web UI mantém markdown completo. Commit `91d13d5`.
- **Tool calls completos no metadata**: `sparkbot_messages.metadata.tool_calls` agora persiste `{name, input, result_preview}` (truncado 800 chars). Commit `ac0edb4`.
- **`primary_error`/`secondary_error` propagation**: quando Claude falha, mensagem real do erro chega ao metadata + log Vercel. Antes era silent fallback. Commit `ac0edb4`.

---

## [v0.4.1] — 2026-05-02 — Validation pass

### Fixed
- 6 bugs encontrados pelos agentes de validação aplicados antes do rollout WhatsApp:
  - REACTION rejected upstream → adicionado em `validTypes`
  - Idempotency UNIQUE catch dead code → use `error.code === "23505"`
  - Whisper double-bill on race → mutex em memória
  - `__sparkbot_restored` flag never set → variável local `restoredFromCache`
  - Migration sem versionar → `00043_*.sql` criada
  - `loadSilenceDecision` fail-open em PGRST116 → recusa proativo pra rep órfão
- Commit `8082ea5`.

### Added
- Sticky tabular cache extendido pra áudio (`kind === "audio"`). Antes só `text`. Commit `4519fd3`.

---

## [v0.4.0] — 2026-05-02 — WhatsApp readiness

Marco maior: Sparkbot prep pra ir live no WhatsApp via Stevo (Evolution).

### Added
- **Multi-hub Sparkbot**: aceita qualquer location com agent ativo `account_assistant` (antes era single-hub via env var). Cache em memória 5min. Commit `52cd38d`.
- **Idempotency**: `sparkbot_messages.ghl_message_id` UNIQUE INDEX + lookup upfront + UNIQUE constraint catch. Migration `00043`.
- **Silence tracking**: `consecutive_proactive_without_reply`, `proactive_paused_at`, `proactive_warned_at`, `last_inbound_at` em `rep_identities`. Threshold: 0/1=normal, 2=warning soft, 3=warning hard, ≥4=pause. Reset em qualquer inbound. Files `silence-gate.ts` + `silence` schema em `00043`.
- **BR-aware phone normalize**: `normalizePhone(raw, defaultCountry)`. 10/11 dígitos → `+55` se BR, `+1` se US. `inferCountryFromTimezone`. Antes assumia US sempre, quebrava import BR.
- **Sticky tabular cache (WhatsApp parity)**: rep manda CSV → "sim" → bot reusa. TTL 30min, `webhook-handler.ts`. Antes só Web UI tinha.
- **REACTION emoji handling**: 👍✅👌🆗✔✓💯🙏👏❤ → "sim"; 👎❌🚫 → "não, cancela". Strip variation selectors + skin tones.
- **`testSessionId` gate em executeTool**: tools risk≠safe retornam mock JSON em test mode. Antes test em prod mexia no CRM real.
- **Outbound channel routing**: `pickOutboundChannel()` lê `ASSISTANT_OUTBOUND_CHANNEL` env. Default `SMS` (Stevo agora). Futuro `auto` com window 24h check.

---

## [v0.3.x] — 2026-05-01 — Tabular import + JWKS auth

### Fixed
- **Tabular import notes**: handler tinha `void notes; // futuro` — TODO abandonado. Agora cria `/contacts/{id}/notes` em paralelo. Commit `deb6928`.
- **Sticky tabular attachment** (Web UI primeiro): cache server-side em `sparkbot_messages.metadata.attachment_full`, TTL 30min. Antes rep precisava reanexar a cada turn. Commit `deb6928`.
- **`confirmed_by_rep` schema injection**: tools com gate ativo agora declaram o param dinamicamente (`withConfirmationParam`). Antes LLM ficava em loop "Confirma? → sim → bloqueado". Commit `91d2eda`.
- **Owner/assigned_to em import**: `import_contacts_from_data.assigned_to` aceita `'self'` ou user_id. Plus `create_contact.assigned_to` e `update_contact.assigned_to`. Commit `3ff9564`.
- **JWKS verification** (Sparkbot Web UI auth): tokens GHL sem `kid`, multi-issuer (default-platform vs default-crm-marketplace), endpoint correto `/robot/v1/metadata/jwk`. 8+ commits sequenciais. Commits `e5782e3` → `df8796b` → `82dcf63` → `1cd6e7a`.
- **Loader Custom JS**: postscribe parsing quirks com `<` em strings JS. Solução: `fetch + new Function(code)` em vez de `<script src=>`. Reentrância: aceita re-exec se debug fn não montou. Commits `5ac7f50`, `2c21c85`, `03061a3`.

### Added
- **Suporte a uploads no Sparkbot Web UI**: imagem, PDF, CSV, XLSX. Commit `65a9681`.
- **Allowlist de admins por env var**: `ASSISTANT_ALLOWED_AGENCY_USERS` como fallback quando GHL API não retorna user. Commit `3d53e16`.

---

## [v0.2.x] — 2026-04-28/29 — Stress tests + ultra-review

### Added
- **NLG Carrier Knowledge Base com RAG (pgvector)**: ingest de 66/68 transcripts da Brazillionaires + 19/19 tests pass. Voyage AI embeddings (1024 dims, downgrade do OpenAI 1536). 2 KBs: `national_life_group` (técnica) + `agency_brazillionaires` (treinamento). Commits `a683655` → `eea6408` → `6be2713`.
- **Sprint 0 — 4 CRITICAL** do ultra-review 2026-04-29 fixados (`c66b956`).
- **12 bugs P0/HIGH** do ultra-review 2026-04-28 fixados (`6076dd7`).

### Process
- Reviews documentados em `_planning/_review-2026-04-2[89]/` com TL;DR + métricas + status pós-batch.

---

## [v0.2.0] — 2026-04-27 — Tool catalog V2

### Added
- **Tool catalog 38 ferramentas** em 11 módulos (`account-assistant/tools/`). Commit `0f0adc8`.
- **System rules dinâmicas**: 14 regras seed proativas (briefing pré-meeting, no-show, opp parada, etc). Commit `712e0d8`.
- **Dispatcher proativo + UI**: cron Vercel + simulate endpoint. Commits `a54d8c3`, `f6e293e`.
- **`schedule_reminder` + `cancel_reminder` + `list_my_reminders`**. Commit `c93b018`.
- **pg_cron a cada 30s** (substitui Vercel daily cron). Commit `753b6a1`.

### Fixed
- Sparkbot reusa webhook principal com route-by-location (não webhook próprio). Commit `9196973`.

---

## [v0.1.0] — 2026-04-24 — Sparkbot V1

### Added
- **Account Assistant (Sparkbot) V1**: design doc + schema + identity/terms. Commits `1016fec` → `8f66d03`.
- **Sparkbot UI**: página `/agents/account-assistant` com aba de teste. Commit `45e39f7`.
- **Test sessions persistentes**: histórico preservado entre msgs. Commit `3e3e265`.
- **Tool calls completos expostos pra debug**. Commit `7fe18e8`.

### Fixed
- Rebrand Matrix → Spark revertido. Commit `b068b46`.
- API consistency: error helper + Zod em rotas. Commit `9705185`.

---

## Convenções

- **Commits são source of truth**. Pra histórico completo, ver `git log`.
- Adicione entry aqui quando fizer release ou marco visível ao usuário.
- Datas em ISO. SHAs curtos (7 chars).
- Categorias padrão: `### Added` / `### Fixed` / `### Changed` / `### Removed` / `### Process`.
