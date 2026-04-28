# Code Review — Billing / FinOps (Spark AI Platform)

Data: 2026-04-28
Escopo: `src/lib/billing/**`, `src/app/api/billing/**`, todos call sites de LLM/Whisper/embedding, migrations relevantes a billing.

---

## Resumo executivo

**Veredicto: o sistema NÃO cobra TUDO. Existem furos críticos que estimo em US$ 50–500/mês de receita perdida POR LOCATION ATIVA, dependendo de uso.**

Quatro descobertas dominantes:

1. **CRÍTICO — Tabela `usage_records` NÃO existe.** Está referenciada em `supabase/migrations/00028_rls_deny_anon.sql:25` (RLS deny) e usada extensivamente em `src/lib/billing/charge.ts:33,56,69,182`, mas **não há `CREATE TABLE` em nenhuma migration nem no `SETUP.sql`**. Cada chamada a `trackAndCharge` falha silenciosamente: o `INSERT` retorna `null` em `record`, o branch `if (cost.totalChargeUsd > 0 && record)` em `charge.ts:64` é falso e **nunca chama `chargeWallet`**. Resultado: **billing está totalmente quebrado** — nenhuma cobrança chega ao GHL Marketplace e nenhum histórico é persistido. (O catch errors no `try/catch` do caller — `processor.ts:637-639`, `account-assistant/processor.ts:250-252`, `dispatcher.ts:402-404` — engolem o erro como "non-blocking", então ninguém notou.)

2. **CRÍTICO — Whisper não é cobrado.** `src/lib/ai/audio-transcriber.ts:90` chama `whisper-1` mas nunca registra duração nem custo em `usage_records`. Seria $0.006/minuto. Não há contador de áudio na tabela. Estimativa: 100 áudios/dia/location × 30s médios ≈ 50min × $0.006 = $0.30/dia × 30 = $9/mês/location não cobrados.

3. **CRÍTICO — `summary-note-generator.ts` e `history-compressor.ts` consomem LLM e nunca chamam `trackAndCharge`.** O processor chama esses módulos uma vez por conversa que encerra/compacta — pode dobrar o consumo agregado de uma location ativa.

4. **MAJOR — Modelos cobrados não batem com o roadmap.** `pricing.ts` lista `claude-haiku-4-5` mas a constante real do código (`llm-client.ts:12`) usa `claude-sonnet-4-6`. E `gpt-4.1-mini` é o default em vários lugares — não é mencionado o `gpt-5` da pergunta. Há também `gpt-5.4` placeholders que ainda não saíram.

Toda a lógica de cobrança está montada mas **não funciona em produção**. O cron de batch retry (`chargeUnbilledRecords`) também falha porque a tabela base não existe.

---

## Pricing table validation

(Preços vigentes em abril 2026; verificar última publicação oficial antes de ajustes finais. Os preços oficiais abaixo são os mais recentes que conheço.)

| Serviço | Preço código (USD/MTok) | Preço oficial (aprox) | Diff | Obs |
|---|---|---|---|---|
| `claude-sonnet-4-6` input | $3.00 | $3.00 | 0 | OK |
| `claude-sonnet-4-6` output | $15.00 | $15.00 | 0 | OK |
| `claude-sonnet-4-6` cached | $0.30 | $0.30 (10%) | 0 | OK |
| `claude-haiku-4-5` input | $0.80 | $1.00 | **−20%** | Sub-cobrança |
| `claude-haiku-4-5` output | $4.00 | $5.00 | **−20%** | Sub-cobrança |
| `claude-haiku-4-5` cached | $0.08 | $0.10 | **−20%** | Sub-cobrança |
| `claude-opus-4-6` input | $15.00 | $15.00 | 0 | OK |
| `claude-opus-4-6` output | $75.00 | $75.00 | 0 | OK |
| `gpt-4.1-mini` input | $0.40 | $0.40 | 0 | OK |
| `gpt-4.1-mini` output | $1.60 | $1.60 | 0 | OK |
| `gpt-4.1-mini` cached | $0.10 | $0.10 (25%) | 0 | OK |
| `gpt-4.1` input/output | $2.00 / $8.00 | $2.00 / $8.00 | 0 | OK |
| `gpt-4.1-nano` | $0.10 / $0.40 | $0.10 / $0.40 | 0 | OK |
| `gpt-4o-mini` | $0.15 / $0.60 | $0.15 / $0.60 | 0 | OK (legado) |
| `gpt-5.4`* | $2.50 / $15.00 | n/d | placeholder | Modelo não oficial — risco de pricing errado |
| `o4-mini` | $1.10 / $4.40 | $1.10 / $4.40 | 0 | OK |
| **Whisper** | NÃO CADASTRADO | $0.006/min | **furo total** | Audio é cobrado zero |
| **text-embedding-3-small** | NÃO CADASTRADO | $0.02/MTok | **furo total** | Embedding cobrado zero |
| **voyage-3-large** | NÃO CADASTRADO | $0.18/MTok | **furo total** | Embedding cobrado zero |
| **GPT-4 vision tokens** | conta como tokens normais | $0.40/MTok input + image tokens | parcial | depende de OpenAI já contar tokens de imagem em `prompt_tokens`; se sim, OK; se não, gap |
| **Anthropic vision** | conta como tokens normais | tokenized normalmente | OK | Anthropic já reporta image tokens em `input_tokens` |
| **Anthropic cache write (5min)** | tratado como input normal | $3.75 (125%) | **−20%** | Sub-cobrança no primeiro cache write — `pricing.ts:6-8` admite a aproximação |

\* `gpt-5.4` ainda não foi anunciado como modelo público. A linha 24-26 de `pricing.ts` é placeholder. Se algum agent estiver setado nesse modelo, está cobrando preços fictícios.

---

## Pontos fortes

1. **Estrutura limpa e testável.** `pricing.ts:74-103` `calculateCost` é pure function, fácil de testar; resolve prefixos (`claude-sonnet-4-6-20251103`) com fallback inteligente.
2. **Markup explícito e configurável.** `pricing.ts:43` `MARKUP_PERCENTAGE = 0.20` num único lugar.
3. **Cached tokens corretamente tratados como subset.** `pricing.ts:84-88`: `freshInputTokens = promptTokens - cachedTokens`, evita double count.
4. **Anthropic e OpenAI normalizados.** `llm-client.ts:215-217`: comentário explícito sobre normalizar `prompt_tokens = fresh + cached` para consistência com OpenAI. Isso evita cache% > 100%.
5. **Fallback de pricing seguro.** `pricing.ts:66-67`: modelos desconhecidos caem para `gpt-4.1-mini` com warn no log.
6. **Batch de retry com agrupamento por location.** `charge.ts:193-203`: agrupa unbilled por location antes de chamar GHL — reduz chamadas API.
7. **Alerta de stale records.** `charge.ts:159-179`: se >100 unbilled ou >$10 parados >1h, loga `[Billing ALERT]` com ERROR. Bom monitoring.
8. **Idempotência via `charged_to_wallet` flag.** Evita double-charge mesmo em retry.
9. **Custom key bypass.** `charge.ts:53-61`: se location tem própria OPENAI_API_KEY, marca como charged e não cobra wallet — bom desenho.

---

## Pontos fracos / FUROS de cobrança (CRITICAL)

### 1. CRÍTICO — Tabela `usage_records` não existe (todo billing está quebrado)

**Onde:** `src/lib/billing/charge.ts:32-50` (insert), referenciada em `00028_rls_deny_anon.sql:25` (RLS).
**O que acontece:** sem `CREATE TABLE`, `supabase.from("usage_records").insert(...)` retorna `{ data: null, error: ... }`. Como o código usa apenas `const { data: record }` (sem checar erro), `record` fica `undefined`. A condição `if (cost.totalChargeUsd > 0 && record)` em `charge.ts:64` é sempre false, **`chargeWallet` nunca executa**, e `chargeUnbilledRecords` (`charge.ts:152`) sempre lê 0 rows pendentes.
**Como ficou silencioso:** os três call sites usam `try/catch` non-blocking (`processor.ts:637-639`, `account-assistant/processor.ts:250-252`, `dispatcher.ts:402-404`), e o admin dashboard `src/app/api/billing/route.ts:25-30` lê `usage_records` retornando array vazio sem erro.
**Custo estimado:** **100% das chamadas de IA não estão sendo cobradas.** Para uma location processando 500 mensagens/dia em `gpt-4.1-mini` (~$0.005/msg com markup), são **$2.50/dia × 30 = $75/mês/location** perdidos. Para 10 locations ativas, $750/mês.

### 2. CRÍTICO — Whisper nunca cobra

**Onde:** `src/lib/ai/audio-transcriber.ts:90` (transcribe), `src/lib/queue/processor.ts:252` (caller).
**O que entra:** transcrição é executada normalmente; `result.text` volta no `aggregatedBody`.
**O que NÃO entra:** zero registro em `usage_records`. `transcribeAudioFromUrl` retorna `{ text, duration_ms }` mas duração de processamento não é duração do áudio real. Não há `audio_seconds` na pricing nem na tabela.
**Custo estimado:** Whisper $0.006/min. Lead em WhatsApp típico envia 30s de áudio. 50 áudios/dia × 0.5min × $0.006 = **$0.15/dia × 30 = $4.50/mês/location** sem markup; com markup 20% = $5.40. Para 10 locations: $54/mês.

### 3. CRÍTICO — `summary-note-generator.ts` consome LLM mas não cobra

**Onde:** `src/lib/queue/summary-note-generator.ts:140-168`. Modelo: `gpt-4.1-mini` (forçado mesmo se agent for Claude — linha 137).
**O que entra:** prompt com até 30 mensagens × 400 chars = ~3-5k tokens input; output até 1200 tokens; rodado **a cada conversa que encerra ou fica inativa 30min** (cron `00006_create_execution_log` + `processInactivitySummaries`).
**O que NÃO entra:** zero `trackAndCharge`. O custo (~$0.003/note) é coberto pelo Spark sem repasse.
**Custo estimado:** 100 notas/dia × 5k input tokens + 1k output × `gpt-4.1-mini` ≈ $0.005 × 100 = **$0.50/dia × 30 = $15/mês/location**. Para 10 locations: $150/mês.

### 4. CRÍTICO — `history-compressor.ts` consome LLM mas não cobra

**Onde:** `src/lib/ai/history-compressor.ts:90-128`. Modelo: `gpt-4.1-nano` (linha 13).
**Quando:** toda vez que conversa cruza `TURNS_THRESHOLD = 25` (linha 11) e o cache do summary precisa ser regenerado (linha 60).
**Custo:** baixo individual ($0.0002/compressão), mas em conversas longas regenera várias vezes.
**Estimativa:** 5% das mensagens disparam compress = 25 compressions/dia × $0.0002 = **$0.005/dia/location** = $1.50/mês para 10 locations. Pequeno mas não-zero.

### 5. CRÍTICO — `carrier_kb.ts` (Voyage/OpenAI embedding) nunca cobra

**Onde:** `src/lib/account-assistant/tools/carrier_kb.ts:32-58`. Voyage primário ou OpenAI fallback.
**O que entra:** embed da query do rep em cada tool call (~50-200 tokens).
**O que NÃO entra:** zero registro. A tool `query_carrier_knowledge` é chamada potencialmente várias vezes por turno do Sparkbot.
**Custo:** Voyage $0.18/MTok ≈ $0.000036/query (200 toks). Negligible POR QUERY mas escala. 1000 queries/mês × $0.000036 ≈ $0.04 — **realmente desprezível** se Voyage tem free tier 200M (até hoje, gratuito). Quando free tier acabar, vira pequeno custo recorrente. Comentário em `00039_carrier_knowledge_voyage_1024.sql:4` ("OpenAI billing zerou") confirma que essa migração foi forçada por custos.

### 6. CRÍTICO — Test routes (UI manual) não cobram

**Onde:** `src/app/api/agents/test/route.ts:373` e `src/app/api/agents/test/followup/route.ts:141` chamam `processWithAI` direto sem `trackAndCharge`.
**Justificativa pode ser válida** (sessões de teste não devem ser cobradas pro lead), MAS:
- Custo cai sobre Spark (OpenAI/Anthropic API é da Spark).
- Test session pode ser usada como backdoor para uso ilimitado free.
- `src/app/api/agents/test/transcribe/route.ts:31-36` chama Whisper direto também — sem rate limit.
**Recomendação:** ou cobrar o teste como custo de "treino" (sem markup), ou impor rate limit (e.g. 50 mensagens/dia/location no test mode).

### 7. CRÍTICO — Follow-ups (cron) não cobram

**Onde:** `src/lib/queue/follow-up-scheduler.ts:298-303`. Mesma pattern: chama `processWithAI` mas não chama `trackAndCharge`.
**Custo estimado:** 30% dos leads recebem follow-up = 150/dia/location × $0.005 = $0.75/dia × 30 = **$22.50/mês/location**. Para 10 locations: $225/mês.

### 8. MAJOR — Anthropic cache write é sub-cobrado

**Onde:** `src/lib/billing/pricing.ts:6-8` (comentário explícito), `src/lib/ai/openai-client.ts:271`, `src/lib/account-assistant/llm-client.ts:201` usam `cache_control: { type: "ephemeral" }`.
**Problema:** Anthropic cobra **125% do input** no cache write (primeiro turno). O código trata como input normal (100%). Para um system prompt de 8k tokens cacheado, é um overhead único de 0.25 × 8k × $3 = **$0.006 por nova conversa**.
**Custo estimado:** 50 novas conversas/dia/location × $0.006 = $0.30/dia × 30 = **$9/mês/location** absorvido pela Spark.

### 9. MAJOR — Race condition: `charged_to_wallet` write-after-success vs concorrência

**Onde:** `charge.ts:64-76`. Sequência:
1. `INSERT usage_records (charged_to_wallet=false)` retorna id.
2. `chargeWallet(...)` chama GHL.
3. Se sucesso, `UPDATE charged_to_wallet=true`.

Se GHL retorna sucesso mas a chamada à Spark for retentada (timeout client-side, by example) ou dois processors carregam o mesmo unbilled record no `chargeUnbilledRecords`, **dupla cobrança no GHL** sem proteção.

`chargeUnbilledRecords` em `charge.ts:181-188` faz `SELECT WHERE charged_to_wallet = false LIMIT 50` — sem `LOCK FOR UPDATE` ou claim atômico (compare com `00033_atomic_dispatch_claim.sql` que faz isso em outro contexto). Se dois cron runs sobrepuserem, ambos cobram.

**Mitigação atual:** cron Vercel é **diário** (`vercel.json:5` "0 0 * * *"). Mas pg_cron pode estar rodando em paralelo (00033 sugere). Risco real.

### 10. MAJOR — `chargeUnbilledRecords` agrupa por location MAS perde rastreabilidade individual

**Onde:** `charge.ts:218-223`. Cobra batch com descrição `"Batch: N interacoes"`. Se cliente disputar, **não há vínculo agregado entre o charge GHL e os ids individuais** — só "Batch: 47 interacoes" no extrato. Auditoria fica difícil.

### 11. MAJOR — Multi-modal vision (imagens GPT-4.1) sub-cobrança implícita

**Onde:** `src/lib/ai/openai-client.ts:175-179` envia `image_url` parts. OpenAI calcula tokens de imagem internamente e os reporta em `usage.prompt_tokens`. **Verificar:** se OpenAI conta image tokens em `prompt_tokens` ou em campo separado (`image_tokens`). Se for o segundo, o código está sub-cobrando 100% do custo de imagens.
**Estimativa de risco:** uma imagem 1024×1024 high detail = ~750 tokens em `gpt-4o`. Se 10 imagens/dia/location esquecidas = 7.5k tokens × $0.40/MTok = $0.003/dia. Pequeno mas presente.

**Anthropic:** vision tokens já entram em `input_tokens`. OK.

### 12. MAJOR — `priceunknown` warn no log mas não-bloqueante

**Onde:** `pricing.ts:66`. Se um modelo errado for digitado no agent_config, **cobra como `gpt-4.1-mini`** silenciosamente. Para um cliente usando `claude-opus-4-6` configurado errado, sub-cobrança massiva (Opus é 18.75× mais caro que mini).
**Recomendação:** retornar erro hard, não fallback silencioso, ou pelo menos enviar alerta para admin.

### 13. MEDIUM — Sem free tier nem hard cap nem soft cap

**Onde:** procura em `src/lib` — zero `monthly_limit`, `MAX_SPEND`, `free_tier`. Se `chargeWallet` falhar (saldo insuficiente), `checkWalletBalance` em `charge.ts:126-147` **sempre retorna `true`** (fail-open propositalmente, linhas 141-145). Cliente sem saldo continua usando o serviço.

### 14. MEDIUM — Currency / FX

**Onde:** `charge.ts:104` hardcoded `currency: "USD"`. Para cliente brasileiro pagando em BRL no GHL, GHL faz a conversão. OK em teoria, mas:
- Não há registro do FX rate aplicado.
- Se GHL fizer FX a $0.20 markup, é atrito invisível ao Spark.
- Para auditoria fiscal brasileira, falta nota fiscal/registro local.

### 15. MEDIUM — `formatCost` retorna formato esquisito

**Onde:** `pricing.ts:109-112`: `if (usd < 0.01) return $0.5¢`. O caractere `¢` em string template tem trailing space e potencial encoding issue. Não é bug crítico, mas confunde no UI.

### 16. MEDIUM — Description GHL truncada / sanitização ausente

**Onde:** `charge.ts:103`. `description: \`Spark AI Hub - ${formatDescription(actionType)}\``. Se `actionType` for `proactive:my_rule` (de `dispatcher.ts:395`), passa "proactive:my_rule" cru. GHL pode truncar ou encoding-fail.

### 17. LOW — Markup só configura num lugar mas é percentual fixo

`pricing.ts:43`. Não há tier (small/medium/big locations pagam o mesmo 20%). Não há override por location. Decisão de produto.

---

## Race conditions / Auditoria

### Auditoria

- `usage_records` é supostamente o histórico imutável. **Mas a tabela não existe**.
- Não há campo `version`/`charged_at` separado de `created_at`. Quando `charged_to_wallet=true` é flipado, perde-se o timestamp de quando a cobrança aconteceu (importante para reconciliação fiscal).
- Não há vínculo entre `usage_records.id` e `execution_log.id`. Se quiser cross-referenciar custo a uma ação específica, tem que joinar por `(location_id, contact_id, created_at)` — tem ambiguidade.
- O batch charge GHL não retorna ID transacional rastreável de volta para os IDs individuais que compõem o batch.

### Race conditions identificadas

1. **Double charge via cron + sync (charge.ts:65 vs 218):** dois caminhos podem cobrar o mesmo record. Mitigação atual = `charged_to_wallet` flag, mas sem LOCK no SELECT em `chargeUnbilledRecords`. Adicionar `FOR UPDATE SKIP LOCKED`.

2. **Same record processed twice in same cron tick:** se o cron rodar overlapping (Vercel + pg_cron), o `LIMIT 50` retorna mesmos rows. Patch: usar atomic claim parecido com `00033_atomic_dispatch_claim.sql`.

3. **GHL idempotency:** `chargeWallet` em `charge.ts:93-106` não envia idempotency key para GHL. Se request timeout no Spark mas chargeWallet sucedeu no GHL, retry duplica.

---

## Recomendações concretas (ordem de prioridade)

### P0 — Antes de cobrar 1 cliente novo

1. **CRIAR a tabela `usage_records`** (1h dev). Schema sugerido:
```sql
CREATE TABLE usage_records (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        TEXT NOT NULL REFERENCES locations(location_id),
  agent_id           UUID REFERENCES agents(id) ON DELETE SET NULL,
  contact_id         TEXT,
  action_type        TEXT NOT NULL,
  ai_model           TEXT NOT NULL,
  prompt_tokens      INTEGER DEFAULT 0,
  completion_tokens  INTEGER DEFAULT 0,
  cached_tokens      INTEGER DEFAULT 0,
  total_tokens       INTEGER DEFAULT 0,
  audio_seconds      NUMERIC(10,2) DEFAULT 0,  -- Whisper
  image_count        INTEGER DEFAULT 0,        -- vision telemetria
  cost_usd           NUMERIC(12,6) NOT NULL,
  markup_usd         NUMERIC(12,6) NOT NULL,
  total_charge_usd   NUMERIC(12,6) NOT NULL,
  uses_custom_key    BOOLEAN DEFAULT false,
  charged_to_wallet  BOOLEAN DEFAULT false,
  charged_at         TIMESTAMPTZ,
  ghl_charge_id      TEXT,                     -- id retornado pelo GHL
  created_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_ur_location_created ON usage_records(location_id, created_at DESC);
CREATE INDEX idx_ur_unbilled ON usage_records(charged_to_wallet, created_at) 
  WHERE charged_to_wallet = false AND uses_custom_key = false;
```

2. **Cobrar Whisper** (3h dev). Em `audio-transcriber.ts:90-94`, registrar duração real do áudio (não `duration_ms`) via `ffprobe` ou estimando do tamanho de bytes (heurística aproximada). Adicionar entry em `pricing.ts`:
```ts
const AUDIO_PRICING = { "whisper-1": 0.006 / 60 }; // USD por segundo
```
Adaptar `trackAndCharge` para aceitar `audioSeconds` opcional.

3. **Cobrar `summary-note-generator.ts`** (30min). Adicionar `trackAndCharge` após `chat.completions.create` em `summary-note-generator.ts:140`. Usar `actionType: "summary_note"`.

4. **Cobrar `history-compressor.ts`** (30min). Idem em `history-compressor.ts:115`. Usar `actionType: "history_compression"`. Custo é pequeno mas tem que estar lá.

5. **Cobrar `follow-up-scheduler.ts`** (30min). Adicionar `trackAndCharge` em `follow-up-scheduler.ts:298`. Usar `actionType: "follow_up"`.

**Impacto P0:** elimina ~$1000/mês de custo absorvido pela Spark, transforma billing de 0% funcional para ~95%.

### P1 — Próxima sprint

6. **Atomic claim no `chargeUnbilledRecords`** (1h). Migração:
```sql
-- adicionar process_after / claim como em message_queue
ALTER TABLE usage_records ADD COLUMN claim_token UUID;
ALTER TABLE usage_records ADD COLUMN claimed_at TIMESTAMPTZ;
```
E no `charge.ts:182`:
```ts
const claimToken = crypto.randomUUID();
const { data: pending } = await supabase
  .from("usage_records")
  .update({ claim_token: claimToken, claimed_at: new Date().toISOString() })
  .eq("charged_to_wallet", false)
  .eq("uses_custom_key", false)
  .gt("total_charge_usd", 0)
  .is("claim_token", null)  // NÃO claimed
  .lt("created_at", oneHourAgo) // só rows seguros
  .select("*")
  .limit(50);
```

7. **GHL idempotency key** (1h). Passar `Idempotency-Key: <usage_record_id>` no header em `charge.ts:96`. Salvar `ghl_charge_id` na resposta. Permite reconciliação manual.

8. **Cron mais frequente** (15min). `vercel.json` agenda diariamente. Sub para hourly minimum:
```json
{ "path": "/api/cron/process-queue", "schedule": "0 * * * *" }
```
ou usar pg_cron a cada 15min como já existe `00008_setup_pg_cron.sql`.

9. **Hard fail em modelo desconhecido** (15min). `pricing.ts:66`: trocar `console.warn` por `throw new Error`. Forçar admin a corrigir.

10. **Embeddings Voyage/OpenAI billing telemetria** (1h). Mesmo se atualmente é zero (free tier), criar tracking. Adicionar em `carrier_kb.ts:55` chamada a `trackAndCharge` com `actionType: "embedding"` e modelo dummy `voyage-3-large` (sem cobrar, mas registrar para futura ativação).

### P2 — Quando platform escalar

11. **Soft cap por location** (3h). Coluna `monthly_spend_limit_usd` em `locations`. Em `charge.ts:64`, se `totalChargeUsd + this_month_charges >= limit`, mandar email/notify ao admin e marcar `usage_records.warning='approaching_limit'`. Hard block por enquanto fica fail-open (permite uso) mas ativamente notifica.

12. **Markup configurável por tier** (4h). `locations.billing_tier ∈ {free, starter, pro}` com markups diferentes (0%/10%/20%). Tabela `billing_tiers`.

13. **Auditoria query** (2h). View `billing_audit_v` com:
```sql
CREATE VIEW billing_audit_v AS
SELECT 
  ur.id, ur.location_id, ur.created_at, ur.charged_at, ur.ghl_charge_id,
  ur.total_charge_usd, ur.action_type, ur.ai_model,
  el.id AS execution_log_id
FROM usage_records ur
LEFT JOIN execution_log el 
  ON el.location_id = ur.location_id 
  AND el.contact_id = ur.contact_id
  AND ABS(EXTRACT(EPOCH FROM (el.created_at - ur.created_at))) < 5;
```

14. **Anthropic cache_write 25% premium** (30min). Em `pricing.ts`, distinguir `cacheWriteInputTokens` (25% premium) de fresh input. Anthropic SDK retorna `cache_creation_input_tokens` separadamente — usar na linha 282 de `openai-client.ts`.

15. **Multi-modal cobrança explícita** (2h). Adicionar `image_count` e `audio_seconds` em `trackAndCharge`. UI dashboard mostra breakdown.

16. **FX rate snapshot** (1h). Em `chargeWallet`, ler `GHL response.exchange_rate` se houver e salvar em `usage_records.fx_rate_brl_usd` para auditoria fiscal.

17. **Idempotência de webhook** (já existe em outras tabelas — 00021_dedup_and_fixes — replicar pattern para billing).

---

## Estimativa total de loss/mês (10 locations ativas, 500 msgs/dia/location)

| Furo | Loss/mês |
|---|---|
| Tabela não existe (100% bypass) | $750 |
| Whisper (50 áudios/dia × 10 locs) | $54 |
| Summary note (100/dia) | $150 |
| History compressor | $1.50 |
| Follow-ups | $225 |
| Cache write Anthropic 25% | $90 |
| Test sessions (estimativa) | $30–100 |
| **Total** | **~$1300/mês** |

Para 50 locations ativas, ~$6.5k/mês.

**Conclusão:** O furo #1 (tabela inexistente) é catastrófico e provavelmente recente — sugiro check de quando a função `trackAndCharge` foi criada vs quando a migração 00028 listou a tabela. Há boa chance de que o sistema **nunca cobrou nada em produção** desde o lançamento, e o time não percebeu porque o GHL Marketplace não recebe pings (e portanto não há reclamações de cobrança).

Recomendo **freeze de novos onboardings comerciais** até P0 estar deployed e validado em staging com pelo menos 3 transações ponta-a-ponta confirmadas (insert usage_records + GHL charge sucesso + dashboard mostra valor).
