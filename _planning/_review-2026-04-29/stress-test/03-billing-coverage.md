# Billing Coverage Stress Test — Sparkbot

**Data:** 2026-04-29
**Endpoint testado:** `POST /api/agents/account-assistant/synthetic-test`
**Conversa rodada:** session_id `4d5bb99c-3b8d-4be5-9ff5-74f1024020e4` (5 turnos consecutivos)
**Rep usado:** `+17867717077` (Pedro)
**Modelo apurado:** `claude-sonnet-4-6` (todos os turnos)

---

## Resumo executivo

| Métrica | Valor |
|---|---|
| Turnos executados | 5/5 |
| Cobertura de tokens (turnos com `tokens != null`) | **5/5 = 100%** |
| Total prompt tokens | 105.149 |
| Total completion tokens | 574 |
| Total cached tokens | 98.394 |
| Total fresh input tokens (prompt − cached) | 6.755 |
| Cache hit ratio | **93,6%** |
| **Cost USD (sem markup)** | **$0,058393** |
| **Markup 20%** | **$0,011679** |
| **Total a cobrar (cost + markup)** | **$0,070072** (≈ 7,0 ¢) |
| Custo médio por turno | $0,011679 / turno (com markup: $0,014014) |
| Modelo único usado | claude-sonnet-4-6 |
| Erros de billing observáveis (HTTP/JSON) | nenhum |

> **Caveat de observabilidade:** este teste **não consegue confirmar** que o `INSERT INTO usage_records` efetivamente persistiu. O endpoint `synthetic-test` chama `processIncoming → trackAndCharge`, e ambos os erros do `INSERT` e da chamada de cobrança ao GHL são engolidos por try/catch (apenas `console.error` no log do Vercel). Sem endpoint admin público pra ler `usage_records`, **a cobertura de turnos `tokens != null` é proxy fraco para "billing rolou".** Ver Recomendações.

---

## Tabela turno-a-turno

| # | model | prompt | completion | cached | fresh | duration_ms | cost USD |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | claude-sonnet-4-6 | 12.605 | 12 | 12.144 | 461 | 1.587 | $0,005206 |
| 2 | claude-sonnet-4-6 | 25.474 | 296 | 24.288 | 1.186 | 5.683 | $0,015284 |
| 3 | claude-sonnet-4-6 | 25.085 | 47 | 24.288 | 797 | 3.258 | $0,010382 |
| 4 | claude-sonnet-4-6 | 29.050 | 106 | 24.958 | 4.092 | 5.000 | $0,021353 |
| 5 | claude-sonnet-4-6 | 12.935 | 113 | 12.716 | 219 | 2.548 | $0,006167 |
| **Σ** | — | **105.149** | **574** | **98.394** | **6.755** | 18.076 | **$0,058393** |

Fórmula (per turn): `(fresh/1M)·$3.00 + (cached/1M)·$0.30 + (completion/1M)·$15.00`

### Observações de tokens
- **Nenhum** turno retornou `tokens=null` ou `prompt_tokens=0`.
- Turno 1 (curtinho) já entrou com **96% cache hit** → o system prompt + tool catálogo do Sparkbot é massivo (~12K tokens) e fica todo cacheado. Cache write não é discriminado nas respostas (Anthropic SDK soma `cache_creation_input_tokens + cache_read_input_tokens + input_tokens` em `prompt_tokens` no llm-client.ts), então o cálculo aqui assume 100% do `prompt - cached` como fresh input a $3/MTok. Se houvesse cache_write puro a $3,75, custo seria marginalmente maior; na prática o impacto é < 5% porque a 1ª gravação aconteceu uma única vez no turno 1 e amortiza.
- Turno 4 puxou o maior custo ($0,021): tools `list_opportunities` retornou contexto longo (4K fresh tokens depois do cache).
- Turno 5 (sem tool call, só resumo): tokens caíram pra ~13K com cache hit de 98%, custo ínfimo.

---

## Bloco 2 — Verificação via DB / admin

| Endpoint | Método | Resposta | Status |
|---|---|---|---|
| `/api/admin/carrier-kb` | HEAD/GET | `{"error":"Não autenticado"}` | 401 (gate por sessão SSO) |
| `/api/billing` | GET | `{"error":"Nao autenticado"}` | 401 (gate por sessão SSO) |

**Gap explícito:** **não há endpoint público (Bearer cron-secret) para ler `usage_records` ou `wallet_balance`.** O `/api/billing` exige sessão SSO. Logo, durante stress tests ou auditorias automatizadas, é impossível confirmar:
1. Se a tabela `usage_records` foi criada (migration 00040 aplicada em prod).
2. Se cada `synthetic-test` gerou row.
3. Se `charged_to_wallet=true` foi setado.
4. Se `ghl_charge_id` foi populado.

---

## Bloco 3 — Audio billing (`/api/sparkbot/transcribe`)

**Tentativa de obter JWT via `/api/sparkbot/check-admin`** (com creds do Pedro):

```
POST /api/sparkbot/check-admin (com idToken="")
→ 403 {"ok":false,"reason":"not_admin"}

POST /api/sparkbot/check-admin (sem idToken)
→ 403 {"ok":false,"reason":"not_admin"}
```

O fallback do `/check-admin` requer um GHL idToken válido (não validado pelo nosso lado, mas usado pra puxar dados via GHL API). Sem ele, todo path retorna 403. **Não foi possível obter JWT pra testar `/transcribe` autenticado.**

**Tentativas em `/api/sparkbot/transcribe` sem JWT:**

| Cenário | Resultado | Observação |
|---|---|---|
| POST sem `Authorization` | 401 `{"reason":"unauthorized"}` | gate `verifySparkbotWebToken` |
| POST `Authorization: Bearer fake.jwt.token` | 401 `{"reason":"unauthorized"}` | jwt inválido |
| POST `Content-Type: application/json` (sem multipart) | 401 `{"reason":"unauthorized"}` | auth gate ANTES do form parse |
| OPTIONS (CORS preflight) | 204 | CORS OK |

**Não foi possível atingir os branches 400 (`missing_audio`, `audio_too_small`)** porque o auth check (linha 36-37 de `transcribe/route.ts`) acontece ANTES do parse do form. Os branches existem no código (`audio.size < 100 → 400`, `formData == null → 400`), mas requerem JWT.

A inspeção estática do código confirma:
- `transcribe/route.ts:90` chama `trackAndCharge({ actionType: "audio_transcription", model: "whisper-1", audioSeconds, audioModel: "whisper-1", usesCustomKey })`.
- O custo é calculado em `pricing.ts` via `AUDIO_PRICING["whisper-1"] = 0.006/60` USD/segundo.
- `audioSeconds` vem de `transcription.duration` (response `verbose_json` do Whisper).

---

## Bloco 4 — Análise de gaps de cobertura (estática)

Audit de **todos os arquivos que fazem chamada de LLM** vs **call de `trackAndCharge`**:

| Path | Faz LLM? | Cobra (`trackAndCharge`)? | Status |
|---|---|---|---|
| `processor.ts` (turn principal) | sim (Claude/OpenAI) | sim — linha 249 | OK |
| `webhook-handler.ts` | usa `processIncoming` | sim (via processor) | OK |
| `app/api/sparkbot/send/route.ts` | usa `processIncoming` | sim (via processor) | OK |
| `app/api/agents/account-assistant/synthetic-test/route.ts` | usa `processIncoming` | sim (via processor) | OK |
| `app/api/agents/account-assistant/test/route.ts` | usa `processIncoming` | sim (via processor) | OK |
| `app/api/sparkbot/transcribe/route.ts` | sim (Whisper) | sim — linha 90 | OK |
| `proactive/dispatcher.ts` | sim | sim — linha 393 | OK |
| `queue/processor.ts` (sales agent prod) | sim | sim — linhas 317 e 709 | OK |
| `queue/follow-up-scheduler.ts` | sim | sim — linha 319 | OK |
| `queue/summary-note-generator.ts` | sim | sim — linha 188 | OK |
| `lib/ai/history-compressor.ts` | sim | sim — linha 148 | OK |
| `proactive/reminder-runner.ts` | NÃO (só insert msg) | N/A | OK (sem LLM) |
| `app/api/sparkbot/check-admin/route.ts` | NÃO | N/A | OK (overhead) |
| `app/api/sparkbot/inbox/route.ts` | NÃO | N/A | OK (sem LLM) |
| **`app/api/agents/test/route.ts`** (sales agent test playground) | **sim — `generateText` direto** | **NÃO** | ⚠️ **GAP** |
| **`app/api/agents/test/followup/route.ts`** | **sim** | **NÃO** | ⚠️ **GAP** |
| **`app/api/agents/test/transcribe/route.ts`** | **sim — Whisper** | **NÃO** | ⚠️ **GAP** |

### Detalhe dos gaps confirmados

1. **`app/api/agents/test/route.ts`** (sales agent test sandbox):
   - linha 451 retorna `prompt_tokens` no JSON da response, prova de que tracker existe.
   - Nenhum `import trackAndCharge`, nenhum `from("usage_records")` no arquivo.
   - **Provável intenção:** test sandbox não cobra (só admin/owner do account testa). Mas qualquer admin de qualquer account pode usar — **se um agency owner ficar testando o dia inteiro pra calibrar prompts, ele consome OpenAI/Anthropic sem cobrança**.

2. **`app/api/agents/test/followup/route.ts`**:
   - Mesma forma: simulação de follow-up scheduler, faz LLM call, retorna `prompt_tokens`.
   - **Provável intenção:** mesmo argumento.

3. **`app/api/agents/test/transcribe/route.ts`** (sales agent test):
   - Chama `openai.audio.transcriptions.create` (Whisper).
   - Sem `trackAndCharge`. Comparar com `/api/sparkbot/transcribe/route.ts:90` que cobra.
   - **Provável intenção:** mesmo argumento; mas é o teste da onboarding/test playground do sales agent.

### Outras notas
- **Migration 00040 (`usage_records`)** depende de Pedro ter rodado em prod. Se NÃO rodou:
  - `INSERT INTO usage_records` retorna `relation does not exist` → bloco try/catch em `charge.ts:73` faz `console.error` e retorna sem cobrar.
  - **Resultado:** todos os turnos de Sparkbot estão sendo executados grátis sem alarme externo.
  - Risco financeiro: cada conversa de 5 turnos custa ~$0,07 (com markup); se houver 100 conversas/dia = $7/dia que a Spark paga sem reembolsar.

---

## Recomendações

### P0 — Ação imediata
1. **Verificar em prod se migration 00040 foi aplicada.** Comando SQL no Supabase:
   ```sql
   SELECT count(*) FROM information_schema.tables WHERE table_name = 'usage_records';
   ```
   Se 0, aplicar migração imediatamente.

2. **Criar endpoint admin auth Bearer pra ler `usage_records`** (alguma das opções):
   ```
   GET /api/admin/usage-records?location_id=...&since=2026-04-29
   Headers: Authorization: Bearer <CRON_SECRET>
   → { count, total_cost_usd, total_charged_usd, charged_pct, last_record_at, sample[5] }
   ```
   Sem isso, **toda auditoria de billing depende de SQL direto no Supabase**, o que impede stress tests automatizados de validar cobertura.

3. **Health check de billing no `/api/health` ou similar.** Endpoint simples que faz `SELECT EXISTS (SELECT 1 FROM usage_records WHERE created_at > now() - interval '1 hour')`. Se `false` em hora de pico, **manda alerta** (algo está engolindo o INSERT).

### P1 — Endpoints a auditar / decidir

4. **`/api/agents/test/{route,followup}/route.ts` (sales agent test playground)**: decidir explicitamente
   - **Opção A:** documentar como "free tier de teste" e aplicar **rate limit por sessão/dia/location** pra evitar abuso.
   - **Opção B:** instrumentar `trackAndCharge` com `actionType: "agent_test_turn"` e cobrar normalmente. Mais simples e justo.

5. **`/api/agents/test/transcribe/route.ts`**: mesma decisão. Recomendado **Opção B** (o `/sparkbot/transcribe` cobra; faz sentido o sales agent test também cobrar). Bug histórico de inconsistência.

### P2 — Telemetria sugerida

6. **Métrica de "billing escape rate"**: dashboard que conta `LLM calls` (via observability/log) menos `usage_records inserted`. Diferença persistente > 0 = bug silencioso.

7. **Alerta cron** que roda toda hora: se `count(usage_records WHERE charged_to_wallet=false AND created_at > now() - 6h) > 10`, mandar push pro admin (pode indicar `chargeWallet` quebrado, GHL token vencido etc.).

8. **Discriminar `cache_creation_tokens` separado do `cached_tokens` no JSON de response** do `synthetic-test` e `/test`. Atualmente `llm-client.ts` soma os dois em `prompt_tokens`, o que torna o cálculo de cost reportado externamente impreciso pra Anthropic (cache write é 125%, não 100%). Em conversas longas o impacto é pequeno, mas em primeiro turno pode ser 5–10% off.

### P3 — Cosméticos

9. Padronizar `trackAndCharge` com `actionType` documentado em comentário do tipo (atualmente strings livres: `"account_assistant_turn"`, `"audio_transcription"`, etc.). Listar canônicos em `pricing.ts` ou enum.

---

## Apêndice — Comandos de reprodução

```bash
SECRET="spark-cron-secret-2026"
URL="https://spark-ai-platform.vercel.app/api/agents/account-assistant/synthetic-test"

# Turn 1 (cria sessão)
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message":"Oi","rep_phone":"+17867717077","input_kind":"text"}' | jq .

# Turns 2-5 reusam session_id da response do turn 1
SID="<session_id_do_turn_1>"
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Pesquisa contato chamado Maria\",\"rep_phone\":\"+17867717077\",\"input_kind\":\"text\",\"session_id\":\"$SID\"}" | jq .
# ... repetir pra turn 3, 4, 5
```

Cálculo de custo (Python):
```python
INPUT, CACHED, OUTPUT = 3.00, 0.30, 15.00  # claude-sonnet-4-6 USD/MTok
def cost(prompt, completion, cached):
    fresh = prompt - cached
    return (fresh/1e6)*INPUT + (cached/1e6)*CACHED + (completion/1e6)*OUTPUT
```
