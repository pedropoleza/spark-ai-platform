# Review crítico — Infraestrutura

**Data:** 2026-04-28
**Reviewer:** SRE/DBA sênior
**Escopo:** 39 migrations + SETUP.sql, vercel.json, package.json, supabase admin client, queue/processor/scheduler, webhooks, rotas cron, agents/process-batch.

---

## Resumo executivo

A plataforma foi construída em ritmo acelerado e isso aparece em todo lugar: **schema drift severo** (3 tabelas usadas em produção sem migration de criação versionada), **secret hardcoded e commitado em git** na migration `00032`, **dependências com 5 CVEs (1 moderate + 4 high)** que continuam não corrigidas, **migration 00007 incoerente com 00028** (RLS habilitado mas sem `FORCE ROW LEVEL SECURITY` — service_role bypassa policies, ok, mas a migration 00007 é fundamentalmente inútil já que as policies só vêm em 00028), **bug de UNIQUE com NULL** no `assistant_alert_state` quebrando o claim atômico que migration 00033 alega resolver, **vercel.json com 1 cron diário absurdo (`0 0 * * *`)** redundante com pg_cron, e **processador de fila estourando timeout serverless** (60s pra processar até 100 msgs com 3-5 chamadas LLM cada — impossível matematicamente).

Os pontos fortes existem: dispatch atômico via SQL function, dedup de webhooks via UNIQUE index parcial, índices parciais bem desenhados em hot paths (`message_queue.process_after WHERE status='pending'`), e RLS deny-anon explícito na migration 00028. Mas a base operacional (DR, observabilidade, secrets management) está em estado embrionário e isso é incompatível com o nome "AI Platform" sendo cobrado de clientes.

**Severidade geral: MÉDIO-ALTO.** Funciona em escala atual (1 client / debug), mas não vai aguentar 10 clients sem retrabalho estrutural.

---

## Schema overview

```
                      ┌──────────────────┐
                      │    locations     │  ← tenant raiz (ON DELETE CASCADE em todas)
                      │  PK: id (uuid)   │
                      │  UN: location_id │
                      └────────┬─────────┘
                               │ 1:N
              ┌────────────────┼─────────────────┬──────────────┬──────────────────┐
              ▼                ▼                 ▼              ▼                  ▼
       ┌─────────────┐ ┌─────────────────┐ ┌──────────────┐ ┌────────────┐ ┌────────────────┐
       │   agents    │ │ media_library   │ │  knowledge_  │ │ location_  │ │ scheduled_     │
       │ UN(loc,type)│ │                 │ │  base        │ │  settings  │ │  followups     │
       └──────┬──────┘ └─────────────────┘ └──────────────┘ │   ⚠ MISSING│ │ ⚠ MISSING      │
              │ 1:1                                          │  MIGRATION │ │  MIGRATION     │
              ▼                                              └────────────┘ └────────────────┘
       ┌──────────────────┐
       │  agent_configs   │  (35+ colunas — JSONB-heavy, low normalization)
       │  UN: agent_id    │
       └──────────────────┘

       ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
       │ conversation_    │    │  message_queue   │    │  execution_log   │
       │   state          │    │ UN: ghl_msg_id   │    │ (audit trail —   │
       │ UN(agent,contact)│    │  partial idx     │    │  unbounded)      │
       └──────────────────┘    └──────────────────┘    └──────────────────┘

       ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
       │ agent_test_      │ 1:N│ agent_test_      │    │  usage_records   │
       │  sessions        │───►│  messages        │    │   ⚠ MISSING      │
       │                  │    │  TRIGGER touch   │    │   MIGRATION      │
       └──────────────────┘    └──────────────────┘    └──────────────────┘
                                                       ┌──────────────────┐
                                                       │ agent_feedback   │
                                                       │   ⚠ MISSING      │
                                                       │   MIGRATION      │
                                                       └──────────────────┘

  ── Sparkbot (Account Assistant) ──────────────────────────────────────────────
       ┌──────────────────┐    ┌────────────────────────┐    ┌───────────────────┐
       │ rep_identities   │ 1:N│ assistant_conversations│    │ assistant_        │
       │ UN: phone        │───►│ (V3 placeholder vazio  │    │   proactive_rules │
       └────┬─────────────┘    │  em V2)                │    │ FK: agent_id      │
            │                  └────────────────────────┘    └────────┬──────────┘
            │ 1:N                                                     │
            ▼                                                         │
       ┌──────────────────┐                                           │
       │ assistant_       │  ◄── try_claim_dispatch_slot()             │
       │ scheduled_tasks  │      (SQL function — SETUP atomic claim)   │
       └──────────────────┘                                            │
            ┌────────────────────────────────────────────────────────  ▼
            ▼                                                  ┌───────────────────┐
       ┌─────────────────────────┐                             │ assistant_alert_  │
       │ carrier_knowledge       │ pgvector(1024)              │   state           │
       │  ivfflat lists=50       │ search_carrier_knowledge()  │ UN(rep,rule,tgt)  │
       │  cross-tenant!          │                             │  ⚠ NULL bug       │
       └─────────────────────────┘                             └───────────────────┘
```

Total: **~22 tabelas + 4 enums + 3 funções SQL + 3 pg_cron jobs**.

---

## Pontos fortes

### Arquitetura
1. **Dispatch atômico via SQL function** (`try_claim_dispatch_slot` em `00033`) — `INSERT ON CONFLICT DO UPDATE WHERE last_fired_at < cutoff` é o padrão correto pra evitar double-dispatch sob crons paralelos. Centraliza a lógica num único lugar (fora do TS client) e é provavelmente a peça mais bem desenhada de toda a infra. (com a ressalva grave de NULL handling — ver Pontos fracos #4.)

2. **Dedup webhook via UNIQUE index parcial** (`00021_dedup_and_fixes.sql`):
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_message_queue_ghl_dedup
     ON message_queue(ghl_message_id)
     WHERE ghl_message_id IS NOT NULL;
   ```
   Index parcial (não inclui NULL) + tratamento `23505` no webhook handler é idempotente correto.

3. **Atomic claim no processor** (`processor.ts:55-64`):
   ```ts
   const { data: pendingMessages } = await supabase
     .from("message_queue")
     .update({ status: "processing" })
     .eq("status", "pending")
     .lte("process_after", new Date().toISOString())
     .select("*")
   ```
   PostgREST traduz isso pra `UPDATE ... RETURNING *` que é uma operação atômica — dois workers paralelos não pegam a mesma row.

4. **Lock atômico em `summary-note-generator`** (linhas 45-52): seta `summary_note_id = "generating"` com `WHERE summary_note_id IS NULL` e checa retorno via `RETURNING`. Mesmo padrão correto. Há também limpeza de locks órfãos (>10min) na linha 273.

5. **Índices parciais bem aplicados nas hot paths**:
   - `idx_message_queue_ready` filtra `WHERE status = 'pending'` (a query mais quente)
   - `idx_conversation_state_status WHERE status = 'active'`
   - `idx_followups_pending WHERE status = 'pending'`
   - `idx_scheduled_tasks_due WHERE status = 'pending'`
   - `idx_conv_state_inactivity_scan WHERE status = 'active' AND summary_note_id IS NULL`

   Tabela `execution_log` que tende a explodir tem o filtro `WHERE success = true` em índices de stats. Boa prática.

6. **Validação de env vars com fail-fast em dev** (`src/lib/utils/env.ts`) — throwa em dev, loga warning audível em prod. Avisa sobre `DEV_MODE=true` em prod, `GHL_WEBHOOK_SECRET` ausente, etc.

7. **Webhook handler com guards múltiplos**: signature HMAC opcional + `WEBHOOK_REQUIRE_SIGNATURE=true` fail-closed, validação de IDs (regex `^[\w-]{2,100}$`), filtro de tipos válidos (whitelist), STOP/opt-out interceptado antes de qualquer processamento, rate-limit per-contact (30/min).

8. **Schema drift "controlado"** via `IF NOT EXISTS` em quase todos os ALTER TABLE (a partir de 00009). Migrations idempotentes — possível rodar de novo sem quebrar.

9. **RLS deny_anon em massa** (`00028_rls_deny_anon.sql`): policy RESTRICTIVE FOR ALL TO anon USING (false) explícita por tabela. Defesa em profundidade caso alguma rota acidentalmente puxe `anon key`.

10. **Comments e documentation in-line nas migrations** — vários `COMMENT ON TABLE/COLUMN` explicando intenção. `00033`, `00036`, `00037` particularmente bem documentadas.

11. **pg_cron com conditional fire** (`00032_sparkbot_pg_cron.sql`): só faz `net.http_post` se `EXISTS` work pendente. Reduz ruído + custo de invocações ociosas no Vercel.

12. **Cleanup automático** (`00034_sparkbot_cleanup_cron.sql`): cron diário que purga `assistant_scheduled_tasks` completed >30d e `assistant_alert_state` >90d. Sinal de maturidade.

---

## Pontos fracos / Bugs (severidade)

### CRÍTICO

1. **CRON_SECRET hardcoded em arquivo versionado** — `supabase/migrations/00032_sparkbot_pg_cron.sql:32`:
   ```sql
   headers := '{"Authorization": "Bearer spark-cron-secret-2026", ...}'::jsonb,
   ```
   O mesmo valor está em `.env.local` (`CRON_SECRET=spark-cron-secret-2026`). Quem clonar o repo (ou ver o histórico via `git log` — commit `753b6a1`) tem acesso direto a invocar `/api/cron/process-queue`, `/api/cron/sparkbot-proactive`, `/api/cron/summary-notes`, `/api/agents/process-batch`. Esses endpoints disparam billing, enviam mensagens GHL, etc. **Rotacionar imediatamente** + remover do git history (`git filter-repo` ou BFG) + reescrever migration 00032 lendo o secret de Postgres GUC ou função `current_setting('app.cron_secret')`.

2. **Schema drift severo — 3 tabelas usadas em produção sem migration de criação**:
   - `usage_records` — usado em `src/lib/billing/charge.ts:33-226` (insert + updates de billing)
   - `location_settings` — usado em `src/app/api/settings/route.ts` e `src/lib/queue/processor.ts:615`
   - `agent_feedback` — usado em `src/app/api/feedback/route.ts` e `src/lib/queue/processor.ts:469`
   - `scheduled_followups` — só existe em `supabase/SETUP.sql:270` (linhas 270-285), não em migration numerada

   Isso significa: clonar o repo + rodar `supabase migration up` deixa o app QUEBRADO (insert em tabela inexistente). Quem fez o deploy provavelmente criou essas tabelas direto no Supabase SQL Editor. Não há single source of truth do schema. Risco em catástrofe: **DR total impossível.**

3. **Bug de UNIQUE com NULL em `assistant_alert_state`** — migration `00030`:
   ```sql
   UNIQUE (rep_id, rule_id, target_id)
   ```
   `target_id` é nullable (`TEXT`, sem NOT NULL). Postgres trata NULL como distinto por padrão, então `ON CONFLICT (rep_id, rule_id, target_id)` em `try_claim_dispatch_slot` (00033:51) **nunca atinge** rows com `target_id IS NULL` — toda invocação cria nova row. O comentário em `00033:54` ("nosso UNIQUE inclui NULLs como iguais") está **errado**. Pra Postgres 15+ precisa `UNIQUE NULLS NOT DISTINCT`.

   **Impacto**: pra alertas sem target específico (resumo matinal etc), o claim atômico falha silenciosamente — duplica disparos quando dois crons rodam paralelo. Exatamente o bug que migration 00033 alega resolver.

   **Fix**:
   ```sql
   ALTER TABLE assistant_alert_state DROP CONSTRAINT IF EXISTS assistant_alert_state_rep_id_rule_id_target_id_key;
   ALTER TABLE assistant_alert_state ADD CONSTRAINT assistant_alert_state_uniq
     UNIQUE NULLS NOT DISTINCT (rep_id, rule_id, target_id);
   ```

4. **vercel.json com cron diário inútil** — `vercel.json`:
   ```json
   { "crons": [{ "path": "/api/cron/process-queue", "schedule": "0 0 * * *" }] }
   ```
   Roda 1x/dia (meia-noite UTC) processando queue + followups + billing + summaries. Mas pg_cron `process-message-queue` (00008) e `sparkbot-proactive` (00032) já rodam a cada 10s/30s. Esse cron diário no Vercel é **redundante e perigoso**: numa execução, pode estourar `maxDuration: 60` (process-queue + followups + billing + summaries em sequência via `Promise.all`) — se billing ficar lento, o cron mata e deixa state inconsistente.

   Provavelmente sobrou de uma versão anterior que só usava Vercel Cron. **Remover.** Ou trocar pra apenas summaries que faz sentido rodar 1x/dia (se eventualmente isso for o caso).

5. **maxDuration: 60s incompatível com workload do processor** — `processor.ts` chama:
   - GHL search conversation + GHL get messages + GHL get contact + GHL free-slots (4 GHL calls em paralelo)
   - OpenAI/Claude completion (2-15s típico, até 30s em pico)
   - executeActions (mais GHL calls)
   - syncCollectedDataToGHL (até 2 GHL calls)
   - generateSummaryNote (mais 2-3 GHL calls + outra LLM call)
   - scheduleFollowUps (5-10 inserts)

   Total estimado: **20-50s por mensagem em condições normais**. Com `LIMIT 100` no batch fetch (linha 64) processando sequencialmente (linha 111 `for (const group of groups)`), facilmente estoura 60s. Quando estoura, `maxDuration` mata o lambda e deixa msgs em `status='processing'` órfãs que NUNCA voltam pra `pending` (não há reaper).

   **Fix**: ou (a) reduzir LIMIT pra 5-10 por tick + invocar mais frequente, ou (b) implementar reaper de "processing" stuck >5min que volta pra pending, ou (c) migrar processor pra background worker (Cloudflare Workers, Railway, Fly.io).

### ALTO

6. **5 CVEs em deps**: `npm audit` reporta:
   - **glob 10.2.0-10.4.5** (high, 7.5 CVSS): GHSA-5j98-mcp5-4vw2 — command injection
   - **next** (multiple high/moderate):
     - GHSA-9g9p-9gw9-jx7f: DoS via Image Optimizer (5.9 CVSS)
     - GHSA-h25m-26qc-wcjf: HTTP request deserialization DoS (7.5 CVSS, high)
     - GHSA-ggv3-7p47-pfv8: HTTP request smuggling em rewrites
     - GHSA-3x4c-7xq6-9pq8: next/image disk cache exhaustion
     - GHSA-q4gf-8mx6-v5v3: DoS Server Components
   - **postcss <8.5.10** (moderate): XSS via unescaped `</style>`

   Next.js está na **14.2.35** — última 14.x; Next 16.2.4 está disponível. Pelo menos os fixes mais críticos do Next (HTTP smuggling, request deserialization) já estão na 14.2.x corrigidos em patches. Verificar exato. **Plano**: rodar `npm audit fix` (não `--force`) e validar build, ou aceitar com plano de upgrade pro Next 15+ no Q3.

7. **RLS — migration 00007 inutil + falta `FORCE ROW LEVEL SECURITY`**:
   - `00007_enable_rls.sql` cobre apenas 6 tabelas (`locations`, `agents`, `agent_configs`, `conversation_state`, `message_queue`, `execution_log`) e **nem cria policies**. Comentário explica "service_role bypass". OK em teoria, mas:
   - `00028_rls_deny_anon.sql` cobre 14 tabelas — falta `assistant_*` (cobertas individualmente em 00029, 00030, 00031, mas 00037 (`carrier_knowledge`) também faz por conta própria).
   - Falta `ALTER TABLE ... FORCE ROW LEVEL SECURITY` — sem isso, **table owner** ainda bypassa RLS. Em Supabase o owner é `postgres`, então conexões diretas via Supabase Studio (que usa postgres user) não respeitam policies. Não é exploit pelo lado do app, mas é defesa em profundidade.

   Adicionar:
   ```sql
   ALTER TABLE locations FORCE ROW LEVEL SECURITY;
   ALTER TABLE agents FORCE ROW LEVEL SECURITY;
   -- ... etc
   ```

8. **`processing` órfãos sem reaper**:
   No `processor.ts:128-133`, o `finally` SEMPRE marca como `completed` ou `failed`. Mas se o lambda for KILLED (timeout, OOM, deploy), o `finally` não roda — msgs ficam `status='processing'` indefinidamente. Não há query que recupere essas. Eventualmente entopem `idx_message_queue_ready`. Mesmo problema em `scheduled_followups` (linha 116).

   **Fix**: cron periódico:
   ```sql
   UPDATE message_queue
     SET status = 'failed', retry_count = retry_count
     WHERE status = 'processing' AND created_at < now() - interval '5 minutes';
   ```
   ou trigger de cleanup similar ao 00034.

9. **Webhook dispara `processMessageQueue()` global no `waitUntil` após debounce** — `inbound-message/route.ts:567-577`:
   ```ts
   waitUntil(
     sleep(debounceSeconds * 1000 + 2000).then(async () => {
       const result = await processMessageQueue();
     })
   );
   ```
   Toda mensagem nova gera um worker que processa **toda** a fila, não só o agent+contact dela. Com 50 mensagens entrando em 10s, são 50 workers concorrentes processando os mesmos grupos — o atomic claim do UPDATE protege contra processar a mesma row duas vezes, mas é desperdício massivo de invocações Vercel + GHL rate limit. Soma com pg_cron rodando a cada 10s e teremos burst de 60+ invocações concorrentes em qualquer pico.

   **Fix**: remover o `waitUntil` aqui. Confiar 100% no pg_cron. Latência aumenta de "imediato após debounce" pra "no máximo 10s + debounce" — aceitável.

10. **Inserção de mensagem + update de pendentes não é atômica** — `inbound-message/route.ts:524-561`:
    1. Insert da nova mensagem
    2. Update `process_after` em todas pendentes do mesmo agent+contact
    
    Se o lambda morre entre 1 e 2, a nova msg fica com `process_after` atrasado mas as anteriores ficam com `process_after` antigo — debounce quebra. Probabilidade baixa mas existe.

    **Fix**: envolver as 2 operações em RPC/SQL function, ou melhor, fazer em transação. Supabase JS client não tem transação client-side, então criar SQL function `enqueue_message_with_debounce_reset(...)`.

### MÉDIO

11. **`agent_configs` virou tabela de 35+ colunas, JSONB heavy, low normalization** — `00003` cria 14 colunas, depois `00009`, `00011`, `00012`, `00015` (que sozinha adiciona 17 colunas via 17x `ADD COLUMN IF NOT EXISTS` num único ALTER), `00019`, `00023`, `00024`, `00026`, `00029`. Total: 35+ colunas. JSONB campos como `automations`, `targeting_rules`, `deactivation_rules`, `handoff_messages`, `data_fields` deveriam estar em tabelas separadas (relação 1:N). Hoje mexer em uma regra força UPDATE da row inteira de config — risco de race condition em edits concorrentes.

12. **`automations`, `targeting_rules`, etc. armazenadas como JSONB sem schema validation** — não há CHECK constraint validando estrutura. Se a UI gravar JSON malformado, o processor vai dar parse error em runtime. Pelo menos `targeting_mode` tem CHECK de enum, mas a estrutura JSONB nova (`targeting_rules`) não tem.

13. **Tabela `execution_log` cresce indefinidamente sem TTL** — log audit puro, sem partição, sem cleanup. Em produção com 1k msgs/dia, isso vira ~30k rows/mês. Em 1 ano, ~360k rows. Indexes ainda funcionam OK até ~1M, mas a tabela vira uma bomba a longo prazo. **Aplicar mesma estratégia do `00034_sparkbot_cleanup`** — cron diário que purga rows >90d ou particionar por mês.

14. **`carrier_knowledge.embedding` index ivfflat com `lists=50`** (`00037:71`) — para ~85 chunks isso ok. Mas o comentário diz "migrar pra hnsw quando passar de 5K chunks". A regra clássica pra ivfflat é `lists = sqrt(N)` ou `N/1000`. Com 5K chunks, lists=50 dá ~100 vectors/list — search vai ler ~10 lists, então 1000 vectors comparadas. Razoável. Mas se cresce pra 50K chunks, lists=50 com 1000 vectors/list vira 10K vectors comparadas — degrada. Anotar limite.

15. **`search_carrier_knowledge` re-criada duas vezes** (00038 e 00039) com signatures diferentes — `vector(1536)` em 00038 e `vector(1024)` em 00039. **00038 ficou no DB como fantasma se 00039 rodou direto sem `DROP FUNCTION`.** Postgres permite multiple overloads, então pode ter 2 versões coexistindo. Risco: cliente chamando a errada. Adicionar `DROP FUNCTION IF EXISTS search_carrier_knowledge(vector(1536), ...)` no início da 00039.

16. **Rate limiter em memória** — `inbound-message/route.ts:7-21`:
    ```ts
    const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
    ```
    Em Vercel serverless, cada lambda tem seu próprio Map. Lambdas concorrentes não compartilham — rate limit é per-lambda, não per-platform. Um contato pode entrar em 5 lambdas paralelas e fazer 150 msgs/min antes de bater no limit. Migrar pra Redis (Upstash) ou tabela `rate_limit_buckets` no Supabase com TTL.

17. **Processador faz `executeActions` antes de salvar `conversation_state`** — `processor.ts:642-650`. Se o GHL POST falhar mas o supabase update do state já tiver passado, ficamos com state ahead da realidade. E vice-versa. Não há outbox pattern.

18. **Falta foreign key cross-tenant em algumas tabelas críticas**:
    - `conversation_state.location_id` é TEXT sem FK pra `locations(location_id)` — se uma location for deletada, conversation_states ficam órfãos.
    - `message_queue.location_id` mesmo problema.
    - `execution_log.location_id` mesmo problema.
    - `assistant_scheduled_tasks.location_id` idem.
    
    Original `agents.location_id` tem FK + ON DELETE CASCADE corretamente. Por que demais não? Provavelmente histórico — adicionar via migration nova.

19. **Webhook handler tem 781 linhas de lógica em 1 arquivo** — `inbound-message/route.ts`. Validação, signature, parsing, audio detection, opt-out, handoff outbound, anti-eco, targeting, deactivation, working hours, debounce, queue insert, processo background. Difícil de testar. Mover pra módulos separados (`webhook-validators.ts`, `webhook-routers.ts`, `webhook-outbound-handler.ts`).

20. **Query N+1 sutil em `outbound` handoff** — linhas 228-245: busca conversation_state, depois busca agents in (stateAgentIds). Se um contato tem 2+ conversas (com sales e recruitment), pega só o primeiro com `limit(1)`. Em casos normais ok, mas misturar sales+recruitment pra mesmo contato em outbound vai ter handoff pulando o agent errado.

### BAIXO

21. **Migrations renumeradas no SETUP.sql** (linhas 6-8 do header) — drift entre `migrations/` (39 arquivos) e `SETUP.sql` (1 file consolidado mas com ordem reordenada). Onboarding novo dev tem que escolher: rodar 39 migrations ou 1 SETUP.sql? Ambos funcionam mas divergem (SETUP.sql não tem 00037-00039 carrier_knowledge nem 00029-00036 sparkbot).

22. **Migration `00026_fix_recruitment_defaults.sql`** faz UPDATE direto de produção dentro de migration. Não é tipicamente reversível. Sem rollback.

23. **Trigger `touch_test_session_updated_at`** (00027:35-49) tem `LANGUAGE plpgsql` — fine, mas usa NEW.session_id no UPDATE direto. Se múltiplas msgs chegam simultâneas, vai bater com LWW (last write wins) que está OK pra esse use case.

24. **`assistant_proactive_rules.tools_allowed`** é `JSONB` sem default — `NULL = todas as 38`. Lógica espalhada (cliente-side decide). Melhor: `DEFAULT '"all"'::jsonb` explícito ou tabela relacional.

25. **`agent_configs.ai_model` tem default `'gpt-4o'`** mas migration 00030 referencia `'claude-haiku-4-5-20251001'` em `assistant_proactive_rules.ai_model`. Não há registro central de modelos válidos. Validar via CHECK ou tabela `ai_models`.

26. **Inconsistência de naming**: `agent_test_messages.role` aceita `'user'` ou `'agent'`, enquanto na lógica de chat usamos `'inbound'/'outbound'` ou `user/assistant`. Renomear OU criar conversion layer.

27. **Falta GIN index em `tags` e `applies_to_companies`** em `carrier_knowledge` (00037 cria GIN só em `product_refs`). Se queries filtrarem por tag, é table scan.

---

## Riscos operacionais

### SLA & Downtime
- **Single point of failure**: pg_cron jobs no Supabase. Se o projeto Supabase tiver downtime, processador para. Não há fallback (Vercel cron está com schedule errado, ver Pontos fracos #4).
- **Vercel functions sem fallback**: webhook GHL bate em 1 endpoint. Se Vercel down, perdemos mensagens — GHL faz retry mas com window limitado.
- **Sem health check endpoint** documentado. `/api/health` não existe (verifiquei via `ls api/`).

### Vendor lock-in
- **Supabase**: pg_cron + pgvector + RLS. Migrar pra outro Postgres é 80% direto, mas pg_cron substituto no AWS RDS = pg_cron extension habilitado na maioria dos providers. pgvector idem. Risco baixo.
- **Vercel**: `waitUntil` é Vercel-specific (`@vercel/functions`). Migração pra Cloudflare/AWS exige refactor desses pontos. Médio.
- **OpenAI**: `processWithAI` abstrai parcialmente; já há suporte a Anthropic via `ai_model` switch. Risco baixo.
- **Voyage AI** (recém adicionado em 00039): risco médio se eles mudarem pricing ou descontinuarem voyage-3-large. Mantenha embedding contract estável (1024 dims é industry-norm também em outros providers).

### Custos crescentes
- **`carrier_knowledge`** com 1024 dims em ivfflat: storage ~4KB/row. 5K rows = 20MB embeddings + 10MB content. Negligível.
- **`execution_log`** sem cleanup: 30 colunas, JSONB action_payload, ~3KB/row. 1k msgs/dia = 3MB/dia, 1GB/ano. Crítico em escala.
- **`message_queue`** com `media_attachments` JSONB pode ficar grande se URLs longas + base64 inline. Verificar se está armazenando só URLs ou conteúdo inline (1KB OK, 1MB sinistro).
- **OpenAI/Claude tokens**: já mitigado via prompt cache + history compression no processor. Bom.

### Observabilidade — basicamente ZERO
- Não há métricas exportadas (Prometheus, Datadog).
- Logs apenas via `console.log` capturados pelo Vercel logs (sem agregação, retenção limitada).
- `execution_log` é audit, não observabilidade — não dá pra responder "qual p99 de latência do processor nos últimos 7 dias?" sem query manual.
- **Recomendação**: Sentry para errors, Axiom/Logtail para logs, Vercel Analytics para edge metrics. ~$50/mês inicial.

### Disaster Recovery
- **Backup**: Supabase faz backup automático no plano Pro (PITR daily). Free tier não tem PITR.
- **Restore**: nunca testado (presumivelmente). Sem playbook.
- **Schema reproducibility**: BAIXÍSSIMA — schema drift severo (Pontos fracos #2). Se DB for perdido, recriação do schema requer descobrir tabelas faltantes via grep no código.
- **Recomendação CRÍTICA**: gerar `pg_dump --schema-only` do prod e versionar como `_baseline_schema.sql`. Toda migration nova baseia daí. Testar restore em dev/staging.

### Secrets management
- `CRON_SECRET` hardcoded em git (Pontos fracos #1) → CRÍTICO.
- `SUPABASE_SERVICE_ROLE_KEY` em `.env.local` — Vercel encrypted secrets em prod. OK.
- **Sem rotação**: nenhum secret tem TTL ou processo de rotação documentado.
- `GHL_WEBHOOK_SECRET` opcional em prod (env.ts apenas warn) — deveria ser **obrigatório**.

---

## Otimizações

1. **Batch fetch agents+configs** no processor — já faz (`*, agent_configs(*)`), mas em 5 lugares diferentes. Centralizar em `getAgentWithConfig(id)` cacheado por request.

2. **Conversation history fetch via `conversation_id` cache** — webhook hoje busca convId em quase toda invocação. Cachear em `conversation_state.conversation_id` agressivamente (já existe parcialmente).

3. **`carrier_knowledge` Tier 1 deveria ser servido via cache em memória** — chunks `priority='always'` (~5KB total) são lidos pra cada msg do Sparkbot. Cachear em-memory com TTL 1h economiza ~50ms/req.

4. **Combinar process-queue + summary-notes + followups em 1 cron** — hoje vercel.json tem só 1 (e o errado), mas pg_cron `process-message-queue` chama process-batch que faz queue + followups. Adicionar summary scan no mesmo. Reduz invocações.

5. **HNSW em vez de ivfflat** quando carrier_knowledge passar de 5K chunks. Migration:
   ```sql
   CREATE INDEX CONCURRENTLY idx_carrier_knowledge_embedding_hnsw
     ON carrier_knowledge USING hnsw (embedding vector_cosine_ops);
   DROP INDEX idx_carrier_knowledge_embedding;
   ```

6. **Particionar `execution_log` por mês** — `CREATE TABLE execution_log PARTITION BY RANGE (created_at)`. Cleanup vira `DROP TABLE execution_log_y2024m05`. Performance idêntica mas administração 100x melhor.

7. **Compressão de `message_queue.media_attachments`** se não comprimida — jsonb_compress (Postgres 15+ via TOAST) já cuida. Verificar.

8. **Remover query `existingStates` redundante no webhook** — linhas 228-232 e 410-414 fazem a MESMA query (conversation_state where location+contact). Em outbound + inbound combinados pode ser cacheada.

9. **Rolling summary write é fire-and-forget** (`processor.ts:514`) — bom, mas se falha não há retry. Adicionar a uma fila de retry separada ou pelo menos logar via execution_log.

10. **Prepared statement reuse** — Supabase JS faz isso por trás. OK.

---

## Refactors maiores

1. **Outbox pattern para sincronização Supabase ↔ GHL**: criar tabela `outbox_events` + worker que processa eventos pendentes. Resolve risco #17 (state inconsistente entre supabase e GHL).

2. **Mover `processMessageQueue` pra worker dedicado**: Cloudflare Workers ou Railway/Fly.io com Redis-backed queue (BullMQ). Resolve riscos #5 (timeout) e #8 (orphans). Vercel passa a ser só HTTP/UI.

3. **Quebrar `agent_configs` em sub-tabelas relacionais**:
   - `agent_automations` (1:N de automations)
   - `agent_targeting_rules` (1:N)
   - `agent_data_fields` (1:N)
   - `agent_handoff_messages` (1:N)
   - Manter scalar settings em `agent_configs` (model, debounce, timezone, etc).

4. **Versionamento de migrations com integridade**: adicionar tabela `schema_migrations` com hash do conteúdo de cada migration aplicada. Se algum migration foi mexido após aplicado, o checksum diverge e falha o deploy.

5. **Background jobs framework**: hoje `waitUntil` é abusado em vários lugares. Adotar Inngest, Trigger.dev, ou queue-based (BullMQ) — qualquer um padroniza retry, dead letter queue, observability.

6. **Multi-tenant isolation com `app_id` GUC**: hoje `service_role` bypassa tudo. Migrar pra padrão Postgres `SET LOCAL app.current_location = '...'` + RLS policies que checam GUC. Defesa em profundidade contra cross-tenant leak.

7. **Tipar schema com `supabase gen types typescript`**: hoje tipos vem de `@/types/agent` manuais. Geração automática a partir do schema garante drift detection automático.

---

## Migrations review

| # | Arquivo | Propósito | Risco |
|---|---------|-----------|-------|
| 00001 | `create_locations.sql` | tabela `locations` (tenants) + 2 índices | BAIXO — base correta |
| 00002 | `create_agents.sql` | enums `agent_type`/`agent_status` + tabela `agents` UNIQUE(loc, type) | BAIXO |
| 00003 | `create_agent_configs.sql` | enum `agent_objective` + 14 colunas iniciais | MÉDIO — a base que vai virar 35+ colunas via incremental ALTER |
| 00004 | `create_conversation_state.sql` | enum `conversation_status` + tabela | BAIXO |
| 00005 | `create_message_queue.sql` | enum `queue_status` + queue + 2 índices | BAIXO |
| 00006 | `create_execution_log.sql` | audit trail unbounded | MÉDIO — sem TTL nem partição (#13) |
| 00007 | `enable_rls.sql` | enable RLS em 6 tabelas SEM policies | BAIXO mas inútil — coberto por 00028 |
| 00008 | `setup_pg_cron.sql` | TODO comentado, instruções manuais | BAIXO — documentação, não executa nada |
| 00009 | `add_handoff_pause.sql` | `ai_paused_at`, `ai_paused_reason` em conv_state | BAIXO |
| 00010 | `knowledge_base_instructions.sql` | `description`, `usage_instructions` em KB | BAIXO — refere-se a KB que ainda não foi criada (00017 cria) — **bug de ordem** |
| 00011 | `kb_general_instructions.sql` | `knowledge_base_instructions` em agent_configs | BAIXO |
| 00012 | `auto_pause_toggle.sql` | `auto_pause_on_human_message` | BAIXO |
| 00013 | `message_queue_agent_id.sql` | adiciona `agent_id` na queue (FIX crítico — sem isso sales/recruitment se misturam) | BAIXO |
| 00014 | `media_library_and_reactions.sql` | tabela `media_library` + `triggered_automations` JSONB | BAIXO |
| 00015 | `recruitment_agent_support.sql` | enum value + 17 colunas em agent_configs (massive ALTER) | MÉDIO — JSONB-heavy, ver Pontos fracos #11 |
| 00016 | `message_queue_channel.sql` | `channel`, `audio_url`, `audio_mime_type` | BAIXO |
| 00017 | `create_knowledge_base.sql` | tabela KB (deveria vir antes de 00010!) | MÉDIO — **ordem incorreta**, mas IF NOT EXISTS salva |
| 00018 | `message_queue_media.sql` | `media_attachments` JSONB | BAIXO |
| 00019 | `media_feature_toggles.sql` | 3 toggles em agent_configs | BAIXO |
| 00020 | `message_queue_retry.sql` | `retry_count` | BAIXO |
| 00021 | `dedup_and_fixes.sql` | UNIQUE INDEX parcial pra dedup webhooks | BAIXO — bem feito |
| 00022 | `performance_indexes.sql` | 4 índices parciais | BAIXO — bem feito |
| 00023 | `conversation_summary_notes.sql` | summary_note_id, segment_number, toggle | BAIXO |
| 00024 | `conversation_examples.sql` | `conversation_examples` TEXT | BAIXO |
| 00025 | `conversation_history_summary.sql` | `history_summary`, `history_summary_covers_count` | BAIXO |
| 00026 | `fix_recruitment_defaults.sql` | UPDATE direto em produção (data fix) | MÉDIO — sem rollback |
| 00027 | `agent_test_sessions.sql` | 2 tabelas + trigger | BAIXO |
| 00028 | `rls_deny_anon.sql` | RLS deny_anon RESTRICTIVE em 14 tabelas | BAIXO — defesa em profundidade |
| 00029 | `account_assistant_schema.sql` | `rep_identities` + `assistant_conversations` + 5 cols agent_configs | BAIXO |
| 00030 | `assistant_proactive_rules.sql` | `proactive_rules` + `alert_state` (com **bug NULL #3**) | ALTO — bug NULLS DISTINCT |
| 00031 | `assistant_scheduled_tasks.sql` | tabela scheduled_tasks | BAIXO |
| 00032 | `sparkbot_pg_cron.sql` | pg_cron job (com **secret hardcoded #1**) | CRÍTICO — secret em git |
| 00033 | `atomic_dispatch_claim.sql` | `try_claim_dispatch_slot` + `finalize_dispatch` | BAIXO (mas afetado por bug #3) |
| 00034 | `sparkbot_cleanup_cron.sql` | cron diário cleanup | BAIXO — bem feito |
| 00035 | `proactive_rules_audit.sql` | created_by/last_modified_by | BAIXO |
| 00036 | `document_v3_placeholder.sql` | só COMMENT statements | BAIXO |
| 00037 | `carrier_knowledge.sql` | tabela vector + ivfflat + RLS + trigger | BAIXO — bem documentado |
| 00038 | `search_carrier_knowledge.sql` | função SQL similarity search vector(1536) | BAIXO |
| 00039 | `carrier_knowledge_voyage_1024.sql` | re-cria coluna pra 1024 dims + recria função | MÉDIO — sem DROP da função antiga (#15) |

**Migrations FALTANDO** que criam tabelas usadas em produção:
- `usage_records` — referenciada em `src/lib/billing/charge.ts`
- `location_settings` — referenciada em `src/app/api/settings/route.ts`
- `agent_feedback` — referenciada em `src/app/api/feedback/route.ts`
- `scheduled_followups` — só existe no SETUP.sql, não migration numerada (mas indexes em 00022 já o assumem)

---

## Recomendações priorizadas (next 30 dias)

### Sprint 1 (1 semana) — emergência
1. **Rotacionar `CRON_SECRET`** + reescrever 00032 para ler de Postgres GUC ou variável de ambiente do Supabase Dashboard. Remover do git history (BFG/filter-repo).
2. **Criar migrations faltantes** (00040, 00041, 00042) para `usage_records`, `location_settings`, `agent_feedback`, `scheduled_followups`. Aplicar em prod via `IF NOT EXISTS` (idempotente).
3. **Fix UNIQUE NULLS** no `assistant_alert_state` (00043).
4. **Remover cron diário do vercel.json** (ou trocar para o que faz sentido).
5. **`npm audit fix`** + retest.

### Sprint 2 (2 semanas) — estabilidade
6. **Reaper de "processing" stuck** + cron diário cleanup do `execution_log`.
7. **Remover `waitUntil(processMessageQueue())` do webhook handler** — confiar 100% no pg_cron.
8. **Health check endpoint** + Sentry integration.
9. **`pg_dump --schema-only` baseline** versionado.
10. **`FORCE ROW LEVEL SECURITY`** em todas tabelas RLS-enabled.

### Sprint 3 (3 semanas) — escala
11. **Particionar `execution_log` por mês**.
12. **Migrar processor pra background worker** (Inngest ou Cloudflare Workers).
13. **Outbox pattern** para sincronização Supabase ↔ GHL.
14. **Quebrar `agent_configs` JSONBs em tabelas relacionais**.
15. **Schema types automation** via `supabase gen types`.

### Sprint 4+ — long-term
16. Upgrade Next.js 14 → 15 (CVEs + perf).
17. Migrar pra HNSW em pgvector quando >5k chunks.
18. Multi-tenant via Postgres GUC + RLS policies (defesa em profundidade).
19. PITR + DR playbook documentado e testado.

---

**Conclusão**: a infra funciona pelo *muscle* dos guards de aplicação (atomic claims, dedup, retry, rate limits). Mas a fundação tem rachaduras estruturais — schema drift, secret em git, bugs em UNIQUE constraints, processador estourando timeout — que vão escalar pior que linearmente quando a base de clientes crescer. Próximos 30 dias: focar em **integridade do schema (migrations completas) + secrets management (rotação + migrations sem secret hardcoded) + reaper de orphans**. Sem isso, o próximo incidente sério não terá DR viável.
