# Runbook — Spark AI Hub

Procedimentos operacionais. Tudo que você precisa quando algo quebra ou precisa rotacionar credenciais.

---

## 🔥 Bug em prod — sequência de triagem

1. **Identificar**: Pedro reporta via chat ou cliente reclama. Pegar timestamp aproximado.
2. **Verificar logs Vercel**: dashboard Vercel → Logs (filter por `[Sparkbot]`/`[Sales]`/`[Webhook]`).
3. **Verificar Supabase logs**: MCP tool `mcp__e105db99-...__get_logs` (project_id `vyfkpdnwevtuxauacouj`, service `api`).
4. **Verificar metadata recente**:
   ```sql
   SELECT id, role, content, metadata->>'model' as model,
          metadata->>'primary_error' as claude_err,
          metadata->'tool_calls' as tools,
          created_at
   FROM sparkbot_messages
   WHERE created_at > NOW() - INTERVAL '15 minutes'
   ORDER BY created_at DESC LIMIT 20;
   ```
5. **Decidir**: rollback ou hotfix?
   - Rollback: bug recente (último deploy), reverter
   - Hotfix: causa identificada rápida, push direto

---

## ↩️ Rollback

### Reverter último commit
```bash
git revert HEAD
git push origin main  # auto-deploy ~1min
```

### Reverter range (volta pra commit X)
```bash
git revert <SHA_BAD>..HEAD --no-edit
git push origin main
```

### Force rollback (último recurso, dangerous)
```bash
git reset --hard <SHA_GOOD>
git push --force origin main  # ⚠️ destructive — confirme com Pedro
```

### Vercel rollback (sem mexer git)
1. Dashboard Vercel → Deployments
2. Find o deploy anterior bom
3. `...` → "Promote to Production"
4. Lembrar de reverter no git em sequência (senão próximo push reintroduz bug)

---

## 🩺 Health checks

### Sparkbot
```bash
# Loader endpoint funcional?
curl -sI "https://spark-ai-platform.vercel.app/embed/sparkbot/loader/" | head -5
# 200 OK + Content-Type: application/javascript

# Webhook entrypoint funcional?
curl -sI "https://spark-ai-platform.vercel.app/api/webhooks/inbound-message"
# 405 Method Not Allowed (POST only) — esperado
```

### Banco de dados
```sql
-- Quantos webhooks Sparkbot processados última hora?
SELECT count(*) FROM sparkbot_messages WHERE created_at > NOW() - INTERVAL '1 hour';

-- Algum stuck em processing?
SELECT id, status, created_at FROM message_queue
  WHERE status = 'processing' AND created_at < NOW() - INTERVAL '30 minutes';
-- Esperado: vazio. Se aparecer, reaper está parado.

-- Migrations vs realidade
SELECT count(*) FROM supabase_migrations.schema_migrations;
-- Comparar com count de arquivos em supabase/migrations/
```

### Cron secret rotation
```bash
# CRON_SECRET é validado em /api/cron/* via header
# Rotacionar:
# 1. Gerar novo: openssl rand -hex 32
# 2. Update Vercel env: vercel env add CRON_SECRET production
# 3. Update pg_cron jobs no Supabase (migration 00041 mostra como)
# 4. Trigger redeploy
```

---

## 🔑 Env vars — rotation

| Var | Onde | Como rotacionar |
|-----|------|----------------|
| `OPENAI_API_KEY` | Vercel | Platform OpenAI → revogar antiga + criar nova → Vercel env update |
| `ANTHROPIC_API_KEY` | Vercel | Console Anthropic → idem |
| `VOYAGE_API_KEY` | Vercel | Voyage AI dashboard → idem |
| `GHL_CLIENT_SECRET` | Vercel | GHL Marketplace App → re-roll → Vercel update + redeploy |
| `CRON_SECRET` | Vercel + Supabase | `openssl rand -hex 32` → Vercel + cada `cron.schedule` no Supabase |
| `JWT_SECRET` | Vercel | `openssl rand -hex 64` (Sparkbot Web JWT). Atenção: invalida sessões existentes. |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Supabase Settings → API → reset (cuidado: usado em backend todo) |

**Padrão Vercel CLI:**
```bash
npx vercel env rm <NAME> production --token <token>
npx vercel env add <NAME> production --token <token>  # prompt interativo pro valor
git commit --allow-empty -m "chore: trigger redeploy <NAME>"
git push origin main
```

---

## 🔍 Debug routes (todas auth-protegidas)

Atualmente NÃO há debug routes deployadas. As que existem temporariamente são removidas após uso:

- `/api/sparkbot/debug/replay-audio` — REMOVIDA (commit `9cb5b39`). Pra recriar quando precisar de debug Whisper:
  ```ts
  // Aceita { audioUrl } ou { debugRowId }, roda transcribeAudioFromUrlVerbose, retorna stages
  ```

**Princípio:** debug routes devem ser TEMPORÁRIAS. Cleanup obrigatório quando issue resolver. Ver template em `git log --all -- 'src/app/api/sparkbot/debug/**'`.

---

## 📊 Logs & observability

### Vercel
- Dashboard → Logs (real-time + 7-day retention)
- Filter por path (`/api/webhooks/inbound-message`) ou message (`[Sparkbot]`)
- Console.error vai pra log severity ERROR

### Supabase
- Dashboard → Logs Explorer (api, postgres, auth, edge-function, storage, realtime)
- `mcp__e105db99-...__get_logs` MCP (programmatic)

### `execution_log` table
Logs estruturados de turns Sparkbot + agent dispatches:
```sql
SELECT id, action_type, action_payload, success, error_message, created_at
FROM execution_log
WHERE location_id = '<LOCATION_ID>'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

### `sparkbot_messages` metadata
Campos úteis em `metadata->>` ou `metadata->`:
- `model` — claude-sonnet-4-6 / gpt-4.1 / etc
- `primary_error` — erro do model primário se houve fallback
- `secondary_error` — erro do secundário (haiku) se também falhou
- `tool_calls` — array de `{name, input, result_preview}` (limit 5)
- `prompt_tokens` / `completion_tokens` / `cached_tokens`
- `llm_failed` — bool, true se chain inteira falhou

---

## 🚨 Incidentes recentes (referência rápida)

### Whisper 429 quota exceeded (2026-05-03)
- **Sintoma:** bot responde "Não consigo processar áudio"
- **Causa:** OpenAI key sem créditos
- **Diagnostico:** `metadata->>'transcribe_status'` na sparkbot_webhook_debug (tabela já dropada)
- **Fix:** recarregar créditos em https://platform.openai.com/settings/organization/billing
- **Prevenção:** logs `⚠️ OPENAI QUOTA EXCEEDED` agora visíveis + msg específica ao rep

### Claude 400 invalid_request (2026-05-03)
- **Sintoma:** bot 100% em fallback OpenAI silenciosamente
- **Causa:** user msg com `content=""` no histórico (de transcribe falho)
- **Diagnostico:** `metadata->>'primary_error'` exposto via commit `ac0edb4`
- **Fix:** filter content vazio + cleanup retroativo
- **Prevenção:** webhook handler nunca persiste content vazio

### GHL multi-provider duplication (2026-05-03)
- **Sintoma:** bot processa msg 2x (e responde 2x)
- **Causa:** Stevo + WhatsApp API gerando 2 webhooks com `messageId` diferentes
- **Fix:** stack de 7 camadas de dedup (in-memory mutex, SELECT, sparkbot_dedup_locks UNIQUE PK, content-match, timing-match, UNIQUE constraint, placeholder rejection)
- **Prevenção:** confirmar ASSISTANT_OUTBOUND_CHANNEL=SMS enquanto WhatsApp API em review

### Sparkbot loop "exige confirmação" (2026-05-01)
- **Sintoma:** rep responde "sim" e bot pergunta de novo
- **Causa:** schema das tools não declarava `confirmed_by_rep` — LLM não tinha como passar
- **Fix:** `withConfirmationParam` injeta o param dinamicamente baseado em `confirmation_mode`
- **Prevenção:** sempre testar gate em `medium_and_high` mode

### Calendar — bot lista slot livre que tem Google block (2026-05-05)
- **Sintoma:** rep ou cliente avisa que bot ofereceu horário X, mas Google Calendar tinha block. Caso real: Marcos Alves (+1 786 461-5477, location `YuR0LCZomFzrfkDK2ezo`).
- **Causa raiz:** bot calculava livre via `list_appointments` + reasoning manual — `/calendars/events` NÃO expõe Google Calendar synced blocks (visíveis na UI mas não na API). Plus, `userId` no events filter era `createdBy.userId` (não assignedUserId).
- **Fix arquitetural (C15):** 2 tools dedicadas com semânticas separadas:
  - `list_my_free_slots(when)` — USER-CENTRIC: UNION /free-slots dos rep's calendars + subtract events cross-calendar (filter client-side por assignedUserId) + INTERSECT-conservador best-effort pra detectar Google blocks via gap entre calendars com BH coverage. Pra "EU tô livre?".
  - `get_free_slots(calendar_id, start, end)` — CALENDAR-CENTRIC puro: confia em /calendars/{id}/free-slots do GHL pra agregar regras desse calendar específico (BH + Google sync interno + conflicts internos). Pra "horários no Calendar X?".
- **Diagnóstico em prod:**
  ```sql
  -- Ver qual tool foi chamada pra um rep
  SELECT created_at, content, metadata->'tool_calls'
  FROM sparkbot_messages
  WHERE rep_identity_id = '<rep_id>' AND metadata ? 'tool_calls'
  ORDER BY created_at DESC LIMIT 10;
  ```
  Se vir `list_appointments` sendo usado pra "tô livre?" — bot regrediu pra padrão antigo, checa system prompt.
- **Bugs subsequentes corrigidos (re-review 2026-05-05):**
  - **C14**: `calendarHasOpenHoursAt` usava `getUTC*` mas openHours é LOCAL → INTERSECT-conservador era no-op silencioso pra reps fora UTC. Fix: Intl.DateTimeFormat com timeZone do rep.
  - `computeWindowInTz` lançava RangeError pra tz inválido → fallback "America/New_York".
  - **C16**: All-events-fail retornava status:ok enganoso → novo status `degraded` no ToolResult + warning crítico + LLM exige confirmação verbal antes de marcar.
- **Prevenção:** rep ou Pedro pode forçar test manual via WhatsApp pro SparkBot: "que horários tenho livre amanhã?" — bot DEVE chamar `list_my_free_slots`, NUNCA `list_appointments`.

---

## 📦 Migrations

### Aplicar nova migration
1. Criar arquivo `supabase/migrations/00044_<descritivo>.sql`
2. Aplicar via MCP: `mcp__e105db99-...__apply_migration` (name + query)
3. Commit + push em paralelo (não deixar drift)

### Verificar drift
```sql
SELECT count(*) FROM supabase_migrations.schema_migrations;
```
vs `ls supabase/migrations/*.sql | wc -l`

### Rollback de migration
Postgres não tem `down`. Pra rollback:
1. Criar nova migration `00045_revert_<algo>.sql` que desfaz
2. NUNCA editar migration aplicada (quebra fresh staging)

---

## 🤖 Crons

### Vercel cron (em `vercel.json`)
- `/api/cron/process-queue` — daily rebuild

### Supabase pg_cron (em migrations 00008, 00032, 00041)
- `/api/cron/sparkbot-proactive` — every 30s (regras proativas)
- `/api/cron/summary-notes` — every 5min (sales summary notes)

Ver migrations pra schedule exato. Auth via header `Authorization: Bearer <CRON_SECRET>`.

### Cron parado, suspeita?
```sql
SELECT jobid, schedule, command, last_run, last_status
FROM cron.job_run_details
ORDER BY start_time DESC LIMIT 20;
```

---

## 📞 Quem chamar

- Bug urgente em prod: Pedro (info@sparkleads.pro)
- Bug GHL/marketplace: GHL support
- Bug OpenAI: dashboard OpenAI status
- Bug Anthropic: status.anthropic.com
- Bug Stevo/Evolution: a ser definido (suporte do Stevo)

---

## 💰 Billing (SparkBot)

### Markup atual
- **10%** sobre vendor cost (Anthropic/OpenAI/Voyage/Whisper). Definido em
  `src/lib/billing/pricing.ts:MARKUP_PERCENTAGE`. Pra ajustar: editar +
  rebuild + deploy.

### Hard cap mensal por sub-account
- Default **$100/mês** por location. Configurável via
  `agent_configs.monthly_spend_cap_usd`. NULL = sem cap.
- Lógica: `isMonthlyCapReached` em `lib/billing/charge.ts` soma
  `total_charge_usd` da location no mês corrente, compara com cap.
- Comportamento ao atingir: `cap_blocked=true` em usage_records, charge
  skipado, bot CONTINUA respondendo (custo vira do Pedro até reset
  mensal ou aumento manual do cap).

### Como aumentar cap pra um rep específico
```sql
-- Find agent_id da sub-account
SELECT a.id, a.location_id, ac.monthly_spend_cap_usd
FROM agents a
JOIN agent_configs ac ON ac.agent_id = a.id
WHERE a.type = 'account_assistant' AND a.location_id = '<LOCATION_ID>';

-- Subir cap (ou setar NULL pra sem cap)
UPDATE agent_configs SET monthly_spend_cap_usd = 500
WHERE agent_id = '<AGENT_ID>';
```

### Como ver gasto do mês por sub-account
```sql
SELECT location_id,
       SUM(total_charge_usd) AS spent_usd,
       SUM(CASE WHEN cap_blocked THEN total_charge_usd ELSE 0 END) AS blocked_usd
FROM usage_records
WHERE created_at >= date_trunc('month', NOW())
  AND charged_to_wallet = true
GROUP BY location_id
ORDER BY spent_usd DESC;
```

### Internal team (não cobrar)
- Reps na env `INTERNAL_TEAM_PHONES` (CSV de phones E.164) ou com role
  `agency`/`agency_owner` em `ghl_users[]`, ou com 5+ ghl_users → flag
  `is_internal=true` em `rep_identities`. Aplicado dinamicamente em
  cada turn via `syncRepInternalFlag`.
- Pra forçar manualmente:
  ```sql
  UPDATE rep_identities SET is_internal = true
  WHERE phone IN ('+17867717077', '+15555555555');
  ```

---

## 🚦 SparkBot — onboarding de novo agente

### UX atual (v0.5.1)
1. **Pre-requisito**: agente cadastrado como GHL user em alguma sub-account
   com phone E.164 (ex: `+17867717077`). Phone configurável via Settings →
   My Profile no GHL deles.
2. **Setup Wizard no AI Hub** (`/agents/account-assistant`): se admin
   nunca interagiu, aparece card em destaque com QR code do WhatsApp.
   Polling 5s detecta primeira msg.
3. **Primeira mensagem WhatsApp**: agente clica no QR / link wa.me →
   abre WhatsApp com mensagem pré-preenchida → manda → bot identifica via
   phone → termos → confirm fuso da `location.timezone` → guia rápido.
4. **Pos-aceite**: bot lê `location.timezone` do GHL e auto-confirma fuso.
   Se rep quer mudar: "to em SP agora" → bot chama `confirm_rep_timezone`.

### Onde está o número WhatsApp do SparkBot
- **+1 (813) 407-9657** — Hub `RBFxlEQZobaDjlF2i5px` (Stevo conectado).
  Configurável via env `SPARKBOT_WHATSAPP_NUMBER`.
- Hub legacy `Cjc1RonkhwcnrMp3vAqt` ainda existe mas não é a "principal".

### Debug: botão SparkBot não aparece em alguma sub-account
1. Abre browser console (F12) na sub-account, filtra por "Sparkbot"
2. Procura erros tipo `check-admin:1 Failed (500)` → backend issue
3. Confere postgres log via MCP get_logs — `duplicate key value` indica
   rep_identity dedup bug (já fixado em H21 deploy d1d6180)
4. Confere se Custom JS está injetado em Agency Settings → Custom JS
5. `Ctrl+Shift+R` pra hard reload se loader.js cacheado

---

## 🌐 CORS allowlist

`src/lib/utils/cors.ts` controla quais origens podem bater nos endpoints
`/api/sparkbot/*`. Pra adicionar nova origem (ex: novo white-label):
```typescript
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  // ...
  /^https:\/\/(?:[a-z0-9-]+\.)*MEU-NOVO-DOMINIO\.com$/i,
];
```

---

## 🔄 Resetar rep que rejeitou termos

Rep mandou "não" ao TERMS_OF_USE_TEXT → bot persiste `terms_rejected_at` e
silencia daqui em diante (Track 1 C1 fix 2026-05-05). Pra desbloquear:

```sql
UPDATE rep_identities
SET terms_rejected_at = NULL,
    updated_at = now()
WHERE phone = '+5511XXXXXXXXX';
```

Próxima msg do rep cai no `!terms_accepted_at` branch normalmente — bot
re-envia termos.

---

## 🔐 Cron secret rotation (CRON_SECRET)

**Secret atual hardcoded em `cron.job.command`** (pg_cron) — visível em
qualquer dump/snapshot DB. Quando rotacionar:

1. Gerar novo secret: `openssl rand -hex 32`
2. Setar GUC no Postgres (via SQL Editor com superuser):
   ```sql
   ALTER DATABASE postgres SET app.cron_secret TO '<novo-hex>';
   ```
   (precisa reconectar pra GUC entrar em vigor — feche/reabra SQL Editor)
3. Atualizar Vercel env: `vercel env add CRON_SECRET production` (paste new)
4. Re-deploy: `vercel --prod`
5. Aplicar migration que substitui hardcoded por `current_setting('app.cron_secret', true)`:
   ```sql
   -- Drop + re-schedule cron com:
   --   'Authorization', 'Bearer ' || current_setting('app.cron_secret', true)
   ```
6. Verificar: `SELECT current_setting('app.cron_secret', false);` retorna o novo.

**Hoje (2026-05-05)**: NÃO foi rotacionado. Migration 00041 declarava o
GUC pattern mas nunca foi aplicada de fato. Fica como TODO pra Pedro.

---

## 🆔 Onboarding nova sub-account (Brazillionaires sub)

Pra adicionar nova sub-account ao Spark Leads + ativar SparkBot:

1. **Provisionar location no GHL** (Pedro faz no admin Spark Leads).
2. **Tokens GHL**: location precisa ter OAuth aprovado — verificar em
   `locations` table no Supabase (`SELECT * FROM locations WHERE
   location_id = '<NEW>'`). Se não está, fazer OAuth flow no admin GHL
   pra permitir Spark Leads app.
3. **Custom JS**: copiar `loader.js` URL pra Agency Settings → Custom JS.
   Pode mudar location_id no script se sub-account isolada.
4. **AI Hub**: admin (Pedro) entra no `/agents/account-assistant`,
   Setup Wizard mostra QR code + número WhatsApp +18134079657.
5. **Phone do admin** precisa estar cadastrado no GHL user dele —
   senão Wizard avisa `reason_no_phone=true`.
6. **Primeira msg do admin via WhatsApp**: bot envia TERMS_OF_USE_TEXT.
   Admin responde "aceito" → onboarding inline (auto-detecta fuso da
   location, mostra guia rápido).
7. **`agent_configs`**: defaults aplicados auto. Se admin quer override
   `monthly_spend_cap_usd` ou `daily_proactive_limit`, edita via UI
   `/agents/account-assistant/config`.

**Internal team flag**: se admin é agency owner ou tem 5+ ghl_users,
`detectIsInternal()` setará `is_internal=true` automaticamente —
bot NÃO cobra wallet pra esse rep.

---

## 🔧 Reactive rules stub vs implementado

Apenas **`post_meeting`** é reactive rule REAL hoje. Lead esfriando,
Tarefa atrasada, Task vencendo, Briefing pré-reunião, etc são stub
(retornam `{fired:0}`). Em 2026-05-05 esses 3 foram desabilitados em
prod (`UPDATE assistant_proactive_rules SET enabled=false WHERE name
IN (...)`) pra não enganar o rep.

**Pra ativar uma stub no futuro**:
1. Implementar polling específico em `cron/sparkbot-proactive/route.ts`
   `processReactivePolling()` (siga modelo de `processPostMeetingPolling`).
2. Test com synthetic-test endpoint.
3. `UPDATE assistant_proactive_rules SET enabled=true WHERE name='X'`.
Em DEV (`NODE_ENV !== production`), tudo passa.
