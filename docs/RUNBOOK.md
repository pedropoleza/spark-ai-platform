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
