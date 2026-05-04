# CLAUDE.md — instruções pra Claude Code/Cursor sessions

> **Toda nova sessão Claude começa lendo este arquivo.** Idioma do projeto é PT-BR.

---

## Quem é o user

Pedro Poleza — agency owner BR, dono da Brazillionaires (sub-agência da Five Rings Financial / National Life). Programa em PT, comentários em PT, commits em PT. Operação principal nos EUA mas atende mercado brasileiro.

Stack mental: prefere **velocidade > rigor inicial**, mas reage rápido quando reporta bug em prod. Solo dev — bus factor = 1. Testa em prod com a própria conta.

---

## Convenções

### Commits
- **Conventional Commits em PT-BR**: `fix(sparkbot): notes não sendo persistidos no import`, `feat(carrier-kb): wave 3 — threshold 0.4`, `chore: trigger redeploy`
- Body explica **por que**, não o quê. Cita arquivos quando útil.
- Co-author footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Nunca pular hooks** (`--no-verify`) sem permissão explícita.

### Comentários inline
- **PT-BR**, explicam decisão (não o óbvio).
- Padrão de **decision codes**: `H1 (review 2026-04-28)`, `C4 fix:`, `P0 (review 2026-04-28)`, `NB-6 do agent de validação 2026-05-02`. Veja `docs/DECISIONS.md` pro mapping completo.
- Quando fix de bug observado em prod, anota data: `// Fix bug observado em prod 2026-05-03: ...`.

### Estrutura
- Path aliases `@/...` em todos os imports — zero `../../../`.
- Tipos compartilhados em `src/types/{ai,agent,ghl,account-assistant}.ts`.
- Tools do Sparkbot: 1 arquivo por categoria, exporta `{def, handler}[]`. Registry em `tools/index.ts`.

---

## Padrões críticos (não viole sem discussão)

### Sparkbot — Confirmation gate (H8)
- Tools com `risk: "medium" | "high"` exigem `confirmed_by_rep: true` no input.
- `tools/index.ts` (`withConfirmationParam`) injeta o param no schema dinamicamente, baseado em `agent_configs.confirmation_mode` (default `medium_and_high`).
- `executeTool()` enforça: bloqueia execution se não vier o flag.
- LLM é instruído a perguntar "Confirma?" → esperar "sim/ok/pode/👍" → re-chamar tool com flag.

### Sparkbot — Test mode gate
- `ctx.testSessionId !== null` + `risk !== "safe"` → tool retorna mock JSON `{simulated: true}`.
- Read-only tools (`search_*`, `get_*`, `list_*`, `analyze_tabular_data`) sempre executam pra preservar análises.
- **NÃO bypass nunca.** Test em prod já causou estrago no passado.

### Sparkbot — Idempotency (5 camadas)
Em ordem de precedência:
1. **In-memory mutex** (`inFlightMessages` em webhook-handler.ts) — sub-segundo intra-lambda.
2. **SELECT por `ghl_message_id`** — retry sequencial.
3. **`sparkbot_dedup_locks`** UNIQUE PK — race <100ms multi-provider.
4. **CONTENT-MATCH** (15s window) — texto idêntico do mesmo rep.
5. **TIMING-MATCH** (5s window) — qualquer kind, multi-provider audio/imagem com bodies diferentes.
6. **UNIQUE constraint** em `sparkbot_messages.ghl_message_id` — última defesa, captura via `error.code === "23505"`.

**Placeholder rejection** (`Audio Message.`, `Image`, etc): só rejeita se NÃO tem attachment processável (Stevo manda placeholder + audio_url juntos).

### Sparkbot — Silence tracking
- Counter em `rep_identities.consecutive_proactive_without_reply`.
- Threshold: 0/1=normal, 2=warning soft, 3=warning hard, ≥4=pause.
- **Reset em qualquer inbound** (web ou WhatsApp). Implementação em `silence-gate.ts`.
- Aplica só a proativos (modo `real`), nunca a respostas a inbound do rep.

### Sparkbot — LLM fallback chain
- Primary: Claude Sonnet 4.6
- Secondary: Claude Haiku 4.5 (se primary falhar)
- Tertiary: GPT-4.1 OpenAI (se ambos Claude falharem)
- `STRICT_CLAUDE_ONLY=1` desativa OpenAI fallback (~85% piora compliance no fallback OpenAI per stress test).
- Erro propaga via `result.primary_error` / `result.secondary_error` pra debug.

### Phone normalization (BR-aware)
- `normalizePhone(raw, defaultCountry)`: 10/11 dígitos sem `+` → +55 se BR, +1 se US.
- Country detectado via `inferCountryFromTimezone(location.timezone)`.
- BUG histórico: antes assumia US sempre, quebrava import de listas BR.

### Outbound channel routing
- `pickOutboundChannel()` lê `ASSISTANT_OUTBOUND_CHANNEL` env (default SMS).
- `SMS` agora (Stevo/Evolution roteia pro WhatsApp).
- `WhatsApp` quando API for liberada (Meta review).
- `auto` (futuro) — checa janela 24h + fallback SMS.

### Migrations
- **Sempre criar arquivo em `supabase/migrations/`** mesmo aplicando via MCP em prod.
- Fresh staging branches dependem disso.
- Header com bloco comentado explicando motivação.

### História do conversation
- Sparkbot: lê `sparkbot_messages` (last 30 turns), filtra `content !== ""` (Claude rejeita user msg vazio com 400).
- Sales/Recruitment: lê `messages` table com `compressHistory` (gpt-4.1-nano summarizer) acima de 25 turns.
- **Nunca persistir `content=""`**: usa `"[mensagem vazia]"` como placeholder.

### Webhook GHL
- Multi-tenant: `isSparkbotHub(locationId)` query a `agents` table com cache 5min em memória.
- Hub é qualquer location com agent ativo `type='account_assistant'`.
- **Não usar mais env var `ASSISTANT_HUB_LOCATION_ID` pra detectar hub** — só pra fallback de cron/billing.

### SparkBot Onboarding (Pedro 2026-05-04)
- Nome user-facing: **SparkBot** (camelCase). Variable/type names podem manter `sparkbot_*` no DB e código.
- Ao aceitar termos, bot lê `location.timezone` do GHL e auto-confirma fuso. NUNCA pergunta fuso pro rep upfront.
- `runOnboardingAfterTerms` em processor.ts encadeia: terms → confirm fuso silencioso → guia rápido com 4 exemplos.
- Helper `formatTimezoneHumanFriendly` mapeia IANA → "Cidade (Abrev)" (ex: "Florida (EDT)").
- Agente pode mudar fuso depois ("to em SP agora") via tool `confirm_rep_timezone`.

### SparkBot Billing (Pedro 2026-05-04)
- **Markup**: 10% (em `pricing.ts:MARKUP_PERCENTAGE`). Foco em adoção, não margem.
- **Hard cap mensal**: default $100/sub-account em `agent_configs.monthly_spend_cap_usd`. NULL = sem cap.
- **Internal team**: `is_internal=true` em rep_identities. Detecção em camadas: env `INTERNAL_TEAM_PHONES` → role `agency`/`agency_owner` → heurística "5+ ghl_users". Skipa charge mas mantém audit.
- **Cap atingido**: `cap_blocked=true` em usage_records, charge skipado, bot CONTINUA respondendo (UX preservada).

---

## Anti-patterns conhecidos (não cair de novo)

- ❌ **Try/catch em supabase-js insert**: NÃO captura erros, devolve `{error}`. Use `if (result.error?.code === "23505")`.
- ❌ **Hardcoded contact_id no LLM**: bot alucinava IDs de turns antigos. Sistema prompt agora exige re-search antes de cada tool com contact_id.
- ❌ **Persistir `content=""`**: Claude rejeita histórico com user msg vazio (400 invalid_request). Filtra ao carregar + "[mensagem vazia]" no insert.
- ❌ **Single hub via env var**: `ASSISTANT_HUB_LOCATION_ID` legacy. Multi-hub via DB query.
- ❌ **In-memory state cross-lambda**: `inFlightMessages` Map só funciona intra-lambda. Use UNIQUE constraint pra cross-lambda.
- ❌ **`extractAudioUrl` sem `extractMediaAttachments`**: Stevo manda audio_url em `attachments` array, não em `mediaUrl` direto. Cobrir ambos.
- ❌ **Esquecer Conventional Commits**: nunca `git commit -m "fix"`. Sempre `fix(<escopo>):`.

---

## Quando inserir comments / decision codes

- Bug observado em prod e fixado → comment `Fix bug observado em prod <data>: <causa> → <fix>`
- Decisão arquitetural não-óbvia → comment + entrada em `docs/DECISIONS.md` com código (próximo H/C/NB disponível)
- Stress test descobriu issue → `<código> (review <data>):` no comment

---

## Onde achar contexto adicional

| Pergunta | Onde olhar |
|----------|-----------|
| Schema do DB | `supabase/migrations/00043_*.sql` (último) + grep nos anteriores |
| Decisão histórica (H8, C4...) | `docs/DECISIONS.md` |
| Como rollback | `docs/RUNBOOK.md` |
| Stress test results | `_planning/_review-2026-04-2[89]/stress-test/` |
| Tool catalog completo | `_planning/account-assistant-v2.md` |
| Endpoints GHL usados | `_planning/ghl-api-reference.md` |
| RAG/pgvector setup | `_planning/nlg-kb-implementation-plan.md` |
| Estado de bugs fixados | `_planning/_review-*/00-RELATORIO-EXECUTIVO.md` |
