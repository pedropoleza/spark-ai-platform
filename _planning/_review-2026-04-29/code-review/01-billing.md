# Code Review — Billing (Sparkbot end-to-end)
Data: 2026-04-29
Reviewer: especialista FinOps

---

## Resumo executivo

O billing do Sparkbot **não está fechando**. Os pontos de cobrança LLM existem nos paths principais (web /send, WhatsApp webhook, dispatcher proactive, scheduled reminders só não cobram porque NÃO chamam LLM — comportamento correto), mas tem **três vazamentos confirmados** e **um bug que faz a INSERT do usage_record falhar silenciosamente** numa rota crítica.

**Cobertura atual (% de turnos cobrando corretamente):**
- Sparkbot WhatsApp turn (texto): cobra LLM. **NÃO cobra Whisper** (vazamento certo).
- Sparkbot WhatsApp turn (imagem/doc): cobra LLM. NÃO cobra image_count nem persiste (telemetria zerada).
- Sparkbot WhatsApp turn (audio): cobra LLM. **NÃO cobra Whisper** (vazamento direto, $0.006/min de áudio do rep).
- Sparkbot Web `/send`: cobra LLM correto.
- Sparkbot Web `/transcribe`: tenta cobrar Whisper, **mas a INSERT falha por FK violation** (passa `tok.rep_id` como `agentId`, e `rep_id` não existe em `agents`). Erro logado mas swallowed → usage_record vira null → cobrança nunca acontece.
- Proactive dispatcher (mode='simulated'): cobra LLM correto.
- Proactive dispatcher (mode='real'): hoje é stub (V3+), não cobra (não roda).
- Scheduled reminders (reminder-runner): correto não cobrar — não chama LLM, só insere msg pronta. Sem ressalvas.

**Subcobrança sistêmica em TODOS paths Claude-based:** o llm-client.ts NÃO captura `cache_creation_input_tokens` da response do Anthropic. Cada turno onde o cache de prompt é gravado pela primeira vez (toda primeira interação numa sessão de 5min) deixa de cobrar 25% premium do cache write. Isso afeta processor.ts, dispatcher.ts e qualquer call site futuro que use Claude.

**Bug crítico de segurança:** `/api/sparkbot/send` e `/api/sparkbot/transcribe` **não têm rate limit**. Atacante autenticado (precisa ser admin do GHL pra obter JWT, mas ainda assim) pode queimar wallet do cliente em poucos segundos disparando dezenas de calls.

**Idempotency:** `chargeWallet` em charge.ts:140 manda `Idempotency-Key` = `usage_record.id`. Cada usage_record gera uma row única (UUID novo), então retry no GHL backend não duplica. Mas **dois processIncoming concorrentes** (cron retry, race do webhook reentregue, etc) geram **dois usage_records distintos** com idempotency-keys distintas → cobra **2x**. Idempotency está no nível errado.

---

## Mapa de chamadas a `trackAndCharge`

| arquivo:linha | actionType | passa agent_id correto? | passa cached_tokens? | passa cacheCreation? | passa audio? | observação |
|---|---|---|---|---|---|---|
| `src/lib/account-assistant/processor.ts:249` | `account_assistant_turn` | sim (`hubAgent.id`) | sim | **NÃO** | não (audio é cobrado a parte ou perdido) | hardcoded `usesCustomKey:false` — ignora `location_settings.openai_api_key` (BYO key cobrança incorreta se cliente trouxe a própria) |
| `src/lib/account-assistant/proactive/dispatcher.ts:393` | `proactive:${rule.name}` | sim (`rule.agent_id`) | sim | **NÃO** | n/a | hardcoded `usesCustomKey:false`. Também: `contactId: rep.id` (UUID rep_identities, não GHL contact id) — auditoria cross-ref com `execution_log.contact_id` (GHL contactId) **não casa** |
| `src/app/api/sparkbot/transcribe/route.ts:90` | `audio_transcription` | **NÃO** (passa `tok.rep_id` como agentId) | n/a (audio) | n/a | sim (`audioSeconds` correto, vem do `transcription.duration` verbose_json) | **BUG CRÍTICO**: FK violation. `agent_id REFERENCES agents(id)` (00040:28) — rep_id não existe em agents. INSERT falha em charge.ts:73, error logged but swallowed → cobrança nunca acontece. Whisper de Web roda **100% free**. |
| `src/lib/account-assistant/webhook-handler.ts` (audio) | nenhum | n/a | n/a | n/a | **BUG**: `transcribeAudioFromUrl` chamado em linha 236 e nunca cobra Whisper. WhatsApp inbound de áudio roda **100% free**. |
| `src/lib/queue/processor.ts:317` | `audio_transcription` | sim (`agent.id`) | n/a | n/a | sim | sales/recruitment: correto |
| `src/lib/queue/processor.ts:709` | `ai_processing` | sim | sim | **NÃO** | n/a | sales/recruitment: correto pra openai (não tem cache_write); errado se virar Claude |
| `src/lib/queue/follow-up-scheduler.ts:319` | `follow_up` | sim | sim | **NÃO** | n/a | follow-up: correto pra OpenAI |
| `src/lib/queue/summary-note-generator.ts:188` | `summary_note` | sim | sim | **NÃO** | n/a | summary: correto pra OpenAI |
| `src/lib/ai/history-compressor.ts:148` | `history_compression` | sim (recebido via `billing` arg) | sim | **NÃO** | n/a | usa `gpt-4.1-nano` (OpenAI) — fora do scope review do Sparkbot, mas review confirma: history-compressor NÃO é chamado de processor.ts/dispatcher.ts atualmente, então no Sparkbot ele NÃO roda nem cobra |

### Observações cruzadas

- **history-compressor não roda em Sparkbot.** processor.ts:185-188 simplesmente faz `(input.conversationHistory || []).map(...)` — nenhum call site do Sparkbot invoca `compressHistory`. Para conversas longas no Sparkbot, hoje só tem o `limit(30)` em sparkbot_messages (webhook-handler.ts:121 e send/route.ts:83) e em agent_test_messages (synthetic-test:144, test:165). Ou seja: NÃO há history compression billing em Sparkbot porque não há history compression em Sparkbot. (Pode ser intencional, mas vale alinhar — se Sparkbot virar verboso e a janela de 30 turns crescer, vai estourar context sem economia de tokens.)

- **scheduled reminders billing:** confirmado `reminder-runner.ts` (todas funções) NÃO chama LLM. Só insere registro pronto. Correto não cobrar.

- **proactive `mode='real'`:** dispatcher.ts:379 é stub `console.warn(...)`. Em V3 quando ligar o WhatsApp real, tem que verificar se o billing flow continua válido.

---

## Bugs críticos

### CRITICAL-1: `/api/sparkbot/transcribe` quebra FK e Whisper Web roda 100% free
**arquivo:linha:** `src/app/api/sparkbot/transcribe/route.ts:93`

Passa `agentId: tok.rep_id`. Mas `usage_records.agent_id REFERENCES agents(id)` (migration `00040_usage_records_and_drift_recovery.sql:28`). `rep_id` é UUID de `rep_identities`, não de `agents`. INSERT falha com FK violation `usage_records_agent_id_fkey`.

charge.ts:73 captura o error com `console.error` e returns silenciosamente. **Nenhum revenue é cobrado pra transcrição Web do Sparkbot.**

**Fix:** resolver `hubAgent.id` no /transcribe (mesma lógica do /send). Adicionar lookup em `agents WHERE location_id=ASSISTANT_HUB_LOCATION_ID AND type='account_assistant'`.

---

### CRITICAL-2: Sparkbot WhatsApp inbound de áudio roda Whisper 100% free
**arquivo:linha:** `src/lib/account-assistant/webhook-handler.ts:236`

`transcribeAudioFromUrl` é chamado dentro de `extractRepInput` mas o resultado (`audio_seconds`) **nunca chega ao `trackAndCharge`**. Comparado com `src/lib/queue/processor.ts:317` (sales/recruitment), está faltando o bloco de billing.

Cliente que receber 50 áudios/dia de reps (típico em equipe de 5-10 reps de seguros) deixa de cobrar ~$0.06/dia × 30 = $1.80/mês/location de Whisper. Pequeno individualmente, multiplica por N locations e a perda escala.

**Fix:** No `extractRepInput`, retornar também `audio_seconds`. No webhook-handler, antes ou depois do processIncoming, chamar `trackAndCharge` com `actionType:'audio_transcription'`, `audioSeconds`, e o `hubAgent.id` que já foi resolvido na linha 89.

---

### CRITICAL-3: Sub-cobrança sistêmica de cache_write Anthropic em TODOS paths Sparkbot
**arquivo:linha:** `src/lib/account-assistant/llm-client.ts:255-261`

Lê `response.usage.input_tokens` e `cache_read_input_tokens` mas NÃO lê `cache_creation_input_tokens`. Anthropic SDK retorna os 3 separadamente:
- `input_tokens`: fresh (não cached, não cache write)
- `cache_read_input_tokens`: cached read
- `cache_creation_input_tokens`: cache write (1ª gravação, premium 125%)

Como o sistema prompt do Sparkbot é grande (5KB carrier overview + persona + tools) e tem `cache_control: ephemeral` (linha 244), a **primeira chamada** dentro do TTL de 5min do cache GERA cache write. Depois da janela expirar, gera de novo.

Resultado: pra cada sessão de teste / cada janela de 5min de WhatsApp, ~500-2000 tokens de cache_write nunca são cobrados. Sonnet 4.6 cache_write = $3.75/M. 1000 tokens × N sessions × N locations/dia = perda mensurável.

Por isso a interface do `trackAndCharge` aceita `cacheCreationTokens` (charge.ts:16) **mas nenhum call site preenche** — em todos os 8 sites, o param é omitido.

**Fix duplo:** 
1. llm-client.ts: capturar `cache_creation_input_tokens`, somar em `totalPromptTokens`, expor no return como `cacheCreationTokens`.
2. processor.ts:249, dispatcher.ts:393, history-compressor.ts:148: passar `cacheCreationTokens: result.cache_creation_tokens ?? 0`.

---

### HIGH-1: Idempotency-Key no nível errado — retry do client duplica revenue
**arquivo:linha:** `src/lib/billing/charge.ts:97-98` + chamadores

`chargeWallet` usa `record.id` como idempotency-key. Mas `record.id` é gerado por `gen_random_uuid()` em cada INSERT. Cada call site cria um NOVO usage_record com NOVO uuid, então retries lógicos no GHL não duplicam — mas se o **mesmo turn lógico** for processado 2x (ex: webhook GHL retransmite, /send chamado 2x do client com mesmo body antes da resposta voltar), são **2 usage_records distintos × 2 idempotency-keys distintas × 2 cobranças**.

O comentário em charge.ts:120-121 ("retry do mesmo record não duplica") está tecnicamente correto mas é uma idempotency rasa demais — protege apenas contra retry **do GHL pra GHL**, não contra retry do client/upstream.

**Mitigação parcial existente:** o webhook principal tem dedup por `ghl_message_id` UNIQUE constraint (route.ts:528). Mas /send web NÃO tem nada equivalente: cliente que aperte F5 ou que tenha problema de network e refaça o POST gera 2 turns + 2 cobranças.

**Fix:** Adicionar dedup explícito em /send (idempotency-key vinda do client, ou hash de `rep_id + message + minute_window`).

---

### HIGH-2: Sem rate limit em /api/sparkbot/send e /api/sparkbot/transcribe
**arquivo:linha:** `src/app/api/sparkbot/send/route.ts` (route inteira) + `transcribe/route.ts`

Atacante autenticado (precisa de JWT — admin do GHL por hora, mas:
- agency owner ou rep sub-account pode ter acesso ao Custom JS injetado e o JWT em sessionStorage,
- ou JWT_SECRET vazado),
pode disparar **N requests/segundo** sem freio. Cada `/send` faz call Claude (~$0.003 input + $0.005 output médio × volume = ~$1/min) e cada `/transcribe` faz call Whisper (audio até 25MB cada).

O webhook GHL tem rate limit `30/min/contact` (route.ts:8-21), mas **só protege contra spam do mesmo contact ID** e nem se aplica a Web. Web bate direto.

**Severidade:** HIGH (não CRITICAL) porque dependa de JWT comprometido OU admin malicioso (TTL 1h, `JWT_SECRET` server-only). Mas em prod multi-tenant é só questão de tempo até alguém abusar.

**Fix:** Same in-memory limiter aplicado a `tok.rep_id` (chave segura, não spoofável dentro do JWT). Sugestão: `60/min/rep` em /send, `30/min/rep` em /transcribe (audio é caro).

---

### HIGH-3: BYO API key (custom key) ignorada nos call sites do Sparkbot
**arquivo:linha:** `src/lib/account-assistant/processor.ts:259` e `dispatcher.ts:403`

Ambos hardcodam `usesCustomKey: false`. Cliente que tenha `location_settings.openai_api_key` setada (pra economizar pagando direto à OpenAI) **continua sendo cobrado** quando interage via Sparkbot. Hoje em produção o Sparkbot roda Anthropic (default Claude), então `openai_api_key` não desativa cobrança Claude — comportamento questionável: ou o setting deveria ser `anthropic_api_key` também (mais provável), ou existe a expectativa de que BYO OpenAI cobre o fallback.

Comportamento do queue/processor.ts:696-720, follow-up-scheduler.ts:309-330 e summary-note-generator.ts:177-200: TODOS verificam `location_settings.openai_api_key`. Sparkbot é o único que não verifica.

**Severidade:** HIGH porque é cobrança INCORRETA (não vazamento, mas overcharge se cliente espera BYO key reduzir custo).

**Fix:** Em processor.ts, lookup `location_settings` antes do `trackAndCharge` (mesma query que sales/recruitment fazem). Se modelo for Claude e cliente trouxe key OpenAI, deixar `usesCustomKey:false` (válido). Se cliente trouxe `anthropic_api_key` (precisa adicionar coluna), aí sim setar `usesCustomKey:true`.

---

### MED-1: `usage_records.contact_id` é `rep.id` (UUID) em vez do GHL contactId
**arquivo:linha:** `src/lib/account-assistant/processor.ts:253`, `dispatcher.ts:397`

`contactId: rep.id`. Mas `execution_log.contact_id` em outros lugares é o `contactId` do GHL (string formato `xxxxx-yyyy`). Cross-ref entre `usage_records.contact_id` e `execution_log.contact_id` (auditoria de "qual contato gerou esse cobrança") **não casa** — quem investiga vê UUID em usage_records mas string GHL em execution_log.

Sales/recruitment: queue/processor.ts:713 usa `group.contactId` (GHL contactId). Consistente.

Sparkbot é diferente porque **rep_identities é o que importa pra Sparkbot** (não há "lead contact" — é o rep humano operando), mas pra cross-ref com webhook GHL inbound, faria sentido manter o contactId GHL **ou** documentar que usage_records.contact_id pode ser tanto string GHL quanto UUID rep_identity.

**Severidade:** MED — não vaza receita, mas confunde dashboard/auditoria.

**Fix:** Decidir e documentar. Mais claro: ter coluna separada `rep_id` em usage_records além de `contact_id`. Ou usar `contact_id = ghl_contact_id` (do webhook body) e populá-lo só no path WhatsApp.

---

### MED-2: Multi-channel duplo: rep no Web + WhatsApp = 1 rep_identity, 2 active_location_ids inconsistentes
**arquivo:linha:** `src/app/api/sparkbot/send/route.ts:104`

Web grava `active_location_id: tok.location_id` (do JWT, sempre fixo). WhatsApp grava `active_location_id: rep.active_location_id` (mutável, atualizado por setActiveLocation em multi-location).

Mesmo rep usando os 2 canais no mesmo dia: `usage_records` registra cobranças **na location_id atual de cada canal**. Se rep trocou active_location no WhatsApp pra location B, mas Web ainda emite com tok.location_id = location A, cobrança vai pra location A errada.

**Severidade:** MED — depende de rep ativamente trocar de location, edge case mas possível. Auditoria de spend por location fica confiável só se garantirmos consistência.

**Fix:** /send deveria respeitar `rep.active_location_id` em vez de `tok.location_id`. Ou mostrar no UI Web que location ativa é a fixa do JWT (re-login pra trocar).

---

### MED-3: Erros de INSERT em usage_records swallowed em silêncio
**arquivo:linha:** `src/lib/billing/charge.ts:73-76`

Se INSERT falha (FK violation, RLS, schema drift), retorna `void`. O comentário em :74 alega "console.error pra ficar visível no Vercel log", mas em prod isso significa que **billing pode estar pifado e ninguém percebe**. Sem alerta agregado, sem fila de retry de INSERT (apenas de cobrança).

CRITICAL-1 (Whisper Web) é exatamente esse cenário: a FK falha silenciosamente, é logged mas ninguém vê.

**Severidade:** MED como sistema (CRITICAL-1 é a manifestação atual).

**Fix:** Sentry/alerting quando INSERT falha. Ou: retentar INSERT via Pg insert + on conflict, ou inserir em fila auxiliar quando FK não bater.

---

## Otimizações (quick wins)

1. **Cache hit ratio audit:** já existe `cache_hit_ratio` em `aiResult` (queue/processor.ts:685). Mostrar no dashboard pra Pedro saber quanto cache está economizando real vs teórico. (Nada de billing, observability.)

2. **Bulk INSERT em chargeUnbilledRecords:** charge.ts:296-298 faz UPDATE individual por batch. Funciona, mas se >50 rows acumular, melhor fazer transação. Já está OK pra volume atual.

3. **AUDIO_PRICING centralizado:** apenas `whisper-1` está mapeado (pricing.ts:58). Se mudar pra `gpt-4o-transcribe` (não anunciado mas possível), preço quebra silenciosamente. Adicionar `console.warn` se modelo não está em AUDIO_PRICING (atualmente só warna em token pricing).

4. **`image_count` zerado em todos paths Sparkbot:** charge.ts:63 default 0. Nenhum call site passa. Vision Sonnet 4.6 cobra como text tokens (Anthropic encoda imagem em tokens de input), então não há sub-cobrança direta — mas a coluna `image_count` no usage_records fica sempre 0, frustando reporting "quantas imagens processamos esse mês".

5. **Em /send, persiste msg DEPOIS do processIncoming pra evitar fantasma:** atualmente persiste user msg ANTES (linha 99-118), depois roda LLM, persiste agent msg (linha 151-172). Se LLM crashar antes do return, user msg fica lá sem agent msg pareada. Não é billing, mas é inconsistência detectável.

---

## Refactors maiores

### R1: Extrair "billing context" único compartilhado
Hoje 8 call sites repetem o boilerplate:
```ts
let usesCustomKey = false;
try {
  const { data: ls } = await supabase.from("location_settings")...
  usesCustomKey = !!ls?.openai_api_key;
} catch { /* sem location_settings */ }

await trackAndCharge({ locationId, companyId, agentId, contactId, ..., usesCustomKey });
```

Refatorar para um helper `chargeForCall({ locationId, agentId, contactId, actionType, llmResult })` que internamente:
1. Resolve `companyId` via `locations` (cached por minuto)
2. Lê `location_settings` (cached por minuto)
3. Decide `usesCustomKey` (com lógica de model-aware: OpenAI key cobre só OpenAI calls)
4. Mapeia llmResult → params do trackAndCharge incluindo `cacheCreationTokens`
5. Logged em telemetria padronizada

Reduz ~200 linhas duplicadas e evita esquecer um campo (que é exatamente o caso atual com cacheCreation/audioSeconds).

### R2: Tabela `billing_idempotency_keys`
`Idempotency-Key` no nível do `usage_record.id` é insuficiente (HIGH-1). Solução: tabela auxiliar com chave lógica do request:
- Web /send: `sha256(rep_id + message_body + minute_bucket)`
- WhatsApp inbound: `ghl_message_id` (já existe UNIQUE em message_queue, replicar no path Sparkbot que hoje só tem sparkbot_messages sem unique constraint)

Antes do `trackAndCharge`, INSERT na tabela com unique violation = skip.

### R3: agent_id como SET NULL é fraco; deveria ser dual-FK
`usage_records.agent_id REFERENCES agents(id) ON DELETE SET NULL` (00040:28). Quando agent é deletado, perde-se rastro de quem cobrou. Pra Sparkbot que tem 1 único agent global por hub, OK. Mas se virar multi-Sparkbot, audit fica órfão.

Opção: adicionar `agent_type` text + `agent_external_id` text como cópia denormalizada (não FK, sobrevive a delete).

### R4: Schema drift — `location_settings.anthropic_api_key`
Atualmente só `openai_api_key`. Se cliente quiser BYO Claude, não tem coluna. Sparkbot usa Claude default, então BYO **não é possível pra path principal**. Adicionar a coluna + lógica de model→provider→key resolution.

---

## Comprovação rápida (file:line)

- Sparkbot WhatsApp audio NÃO cobra Whisper: `src/lib/account-assistant/webhook-handler.ts:236` chama `transcribeAudioFromUrl`, retorno usado só em :238 pra build do RepInput. Nenhum `trackAndCharge` no path. Comparar com `src/lib/queue/processor.ts:308-334` que TEM o billing.
- /transcribe FK violation: `src/app/api/sparkbot/transcribe/route.ts:93` passa `tok.rep_id`. Schema da FK em `supabase/migrations/00040_usage_records_and_drift_recovery.sql:28`.
- cache_creation não capturado: `src/lib/account-assistant/llm-client.ts:255-261`. Compare com a interface oferecida em `src/lib/billing/charge.ts:16`.
- usesCustomKey hardcoded false em Sparkbot: `src/lib/account-assistant/processor.ts:259` e `src/lib/account-assistant/proactive/dispatcher.ts:403`. Compare com `src/lib/queue/processor.ts:696-720`.
- Sem rate limit Web: `src/app/api/sparkbot/send/route.ts` (route inteira), `src/app/api/sparkbot/transcribe/route.ts` (route inteira). Compare com `src/app/api/webhooks/inbound-message/route.ts:8-21,138-142`.
- Idempotency rasa: `src/lib/billing/charge.ts:97-98` (key = uuid próprio = nova a cada call).
- contact_id = rep.id (UUID): `src/lib/account-assistant/processor.ts:253`.
- active_location_id divergente Web vs WhatsApp: `src/app/api/sparkbot/send/route.ts:104` (tok) vs `src/lib/account-assistant/webhook-handler.ts:155` (rep).

---

## Priorização sugerida pra Sprint

1. **CRITICAL-1** (Whisper Web FK fix) — 15min, alta urgência (revenue leak imediato).
2. **CRITICAL-2** (WhatsApp audio Whisper billing) — 30min, mesma intervenção.
3. **CRITICAL-3** (cache_creation capture) — 45min em llm-client + 15min em call sites; impacto de longo prazo.
4. **HIGH-2** (rate limit Web /send + /transcribe) — 30min; hardening de segurança.
5. **HIGH-1** (idempotency proper) — 1h, requer tabela nova ou unique constraint adicional.
6. **HIGH-3** (BYO key Sparkbot) — 30min se aceitar lógica simples (só verificar OpenAI key e ignorar pra Claude).
7. **MED-***: agendar pra próximo ciclo, não bloquear deploy.

Total estimado pra fechar tudo HIGH/CRITICAL: ~3.5h dev + testes.
