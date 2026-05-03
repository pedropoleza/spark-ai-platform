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
