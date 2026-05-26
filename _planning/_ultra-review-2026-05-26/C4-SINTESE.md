# C4 — Segurança/Cyber & Saúde do Código — SÍNTESE

> Ultra-review 2026-05-26 · Coordenador C4 · READ-ONLY (assessment por código + SELECTs).
> Domínio: L4.1 Security, L4.2 Arquivo morto/drift, L4.3 Dependências.
> **Contexto crítico:** a passada anterior (mesma data) já corrigiu vários itens
> (isUserAdmin, IDOR knowledge-base, SSRF `isSafeHttpUrl`, upload size, working-hours
> overnight, eco-handoff tolerante). Este relatório foca no que **sobrou**.

---

## FATO TRANSVERSAL (amplifica tudo abaixo)

**RLS está DORMENTE.** `createServerClient()` (server.ts) e `createAdminClient()`
(admin.ts) usam **ambos** o `SUPABASE_SERVICE_ROLE_KEY` → RLS é bypassada em 100%
das rotas `/api`. `createBrowserClient` (anon key, client.ts) **nunca é chamado**
(grep: zero call-sites reais). Logo, as migrations RLS (00007, 00028) são letra
morta no runtime, e **todo isolamento multi-tenant é puramente aplicacional**
(`.eq("location_id", session.locationId)`). Qualquer rota que esqueça esse `.eq`
= IDOR real, sem rede de segurança.
Evidência: `src/lib/supabase/server.ts:5`, `src/lib/supabase/admin.ts:9`, `src/lib/supabase/client.ts:3`.

---

## P0 — exploitável / vazamento

### P0-1 — SSO fail-open: forja de sessão pra QUALQUER location (sem auth)
- **BREAKS:** `src/lib/auth/sso.ts:62-70` (`validateGHLUser`) + `src/app/api/auth/sso/route.ts:15-61`.
- **O quê:** `POST /api/auth/sso` é público (sem gate). Recebe `{user_id, company_id, location_id}`
  arbitrários e chama `validateGHLUser`. Se a GHL API falha — e ela **falha de cara**
  pra um `company_id` que não tem token OAuth, porque `getCompanyToken` dá throw
  (`src/lib/ghl/auth.ts:31-33`) → `getLocationToken` throw → o `client.get("/users/")`
  rejeita → cai no bloco fail-open (sso.ts:62-70) que **retorna um user fabricado**
  (`isAdmin:false`) em vez de `null`. A rota então emite cookie `spark_session`
  válido (`createSession`) pra aquele `location_id`.
- **Porquê é P0:** atacante anônimo escolhe um `location_id` real (vêm na URL do GHL,
  são enumeráveis) e ganha sessão autenticada não-admin **daquela conta** — e como
  RLS está dormente, passa nos `.eq(location_id)` de TODAS as rotas de leitura
  (billing, settings, conversas, KB, contatos via tools…). Vazamento cross-tenant.
- **Fix (1 linha de intenção):** `validateGHLUser` deve **retornar `null`** quando a
  GHL API não confirma o user (remover o fallback "aceita com acesso limitado");
  a rota já trata `null` → 403. Alternativamente, exigir verificação de assinatura/
  JWT do GHL no `/sso` como já se faz no `/check-admin`.

### P0-2 — `agents/[agentId]/config`: edição do SparkBot global por QUALQUER sessão (cross-company)
- **BREAKS:** `src/app/api/agents/[agentId]/config/route.ts:30` (GET) e `:76` (PUT).
- **O quê:** pra `agent.type === "account_assistant"` a rota **pula** a checagem de
  location/company — basta `getSession()` (qualquer um). NÃO há `isAdmin` nem
  `assertLocationInCompany` (compare com a rota de módulos `modules/route.ts:40-43`,
  que JÁ foi corrigida pra exigir mesma company). O comentário diz "qualquer admin",
  mas o código aceita "qualquer autenticado".
- **Porquê é P0:** `system_prompt_override`/`custom_instructions`/`disabled_tools`/
  `confirmation_mode` do SparkBot (que fala com TODOS os reps) são graváveis por
  sessão de outra conta. Encadeado com P0-1 (sessão forjada) → controle do prompt do
  bot global. Há 2 agentes `account_assistant` em prod (query: 1 company hoje), mas
  o código não impõe isso.
- **Fix:** trocar o gate por `assertLocationInCompany(agent.location_id, session.companyId)`
  (mesma company) **e** exigir `session.isAdmin`, igual ao `modules/route.ts`.

---

## P1 — degrada / IDOR de escrita

### P1-1 — IDOR total nas regras de proatividade do SparkBot (PUT/DELETE por ruleId)
- **BREAKS:** `src/app/api/agents/sparkbot/rules/[ruleId]/route.ts:24-29` (PUT) e `:100-105` (DELETE).
- **O quê:** busca `assistant_proactive_rules` **só por `id`**, sem amarrar ao agent do
  hub, sem location/company, sem `isAdmin`. Qualquer sessão autenticada edita
  `prompt_instruction`/`tools_allowed`/`enabled` ou deleta qualquer regra (custom).
  As rotas-irmãs GET/POST (`rules/route.ts`) resolvem o hub canônico e escopam certo
  — só o `[ruleId]` ficou sem authz. Mesma classe do IDOR de KB que foi corrigido.
- **Porquê P1 (não P0):** `ruleId` é UUID (não enumerável trivialmente), mas sem
  RLS + sem nenhum check = exploitável com o id em mãos (vaza no GET de rules).
- **Fix:** após o fetch, exigir `existing.agent_id === <hub agent id>` (resolvePrimaryHub)
  + `session.isAdmin`; ou validar a company do agent dono da regra.

### P1-2 — `next@15.5.15` com CVEs HIGH de Middleware bypass
- **RISK:** `npm audit --omit=dev` → `next` HIGH. CVEs relevantes:
  *Middleware/Proxy bypass via segment-prefetch* (GHSA-267c-6grr-h53f / GHSA-26hh-7cqf-hhc6)
  e *bypass via dynamic route param injection* (GHSA-492v-c6pp-mqqv).
- **Porquê P1:** o **único** gate de `/admin/*` e `/api/admin/*` é o `src/middleware.ts`
  (Basic Auth). Um bypass de middleware = painel admin + `/api/admin/dashboard`
  (billing de TODAS as locations, reps, PII) expostos sem senha.
- **Fix:** `npm i next@latest` (15.x patched). Verificar build; sem breaking esperado
  num bump de patch/minor recente.

### P1-3 — `xlsx@0.18.5` (SheetJS) HIGH, sem patch no registry npm
- **RISK:** Prototype Pollution (GHSA-4r6h-8v6p-xvw6) + ReDoS (GHSA-5pgg-2g8v-p4x9),
  **"No fix available"** via npm. `xlsx` parseia **upload não-confiável** em
  `src/app/api/knowledge-base/route.ts:43` e no `file-processor.ts` (painel SparkBot).
- **Fix:** migrar pro tarball oficial do SheetJS (`https://cdn.sheetjs.com/xlsx-*/…`,
  que tem as correções) **ou** trocar por lib mantida (ex.: `exceljs`). Mitiga
  parcialmente o limite de 15 MB já existente, mas não cobre prototype pollution.

---

## P2 — polish / defense-in-depth

- **P2-1 — PostgREST `.or()` por string-interp:** `src/lib/account-assistant/tools/followup.ts:499`
  monta `.or(\`contact_name.ilike.%${args.contact_query}%,…\`)` sem escapar `, ( ) * \`.
  **NÃO é cross-tenant** (a query já tem `.eq(rep_id).eq(location_id)` em AND antes),
  mas o rep pode distorcer o próprio filtro. Único filtro interpolado do código.
  Fix: sanitizar `contact_query` (remover `,()%*\\`) antes de interpolar.
- **P2-2 — Dependência morta `pdf-parse@^2.4.5`:** zero refs em `src/` (tudo migrou
  pra `unpdf`, usado em 3 arquivos). É o pacote que quebrou silenciosamente (v2 virou
  classe). Hoje só peso morto. Fix: remover de `package.json`.
- **P2-3 — Código órfão `seedSystemRules`:** `src/lib/account-assistant/proactive/seed.ts`
  exporta `seedSystemRules` mas **nada** chama (grep src+scripts = 0). Dead code.
  (`system-rules.ts` que ele importa segue usado por outros.) Fix: remover seed.ts ou
  ligar num provisioning real.
- **P2-4 — Stevo webhook fail-open de origem:** `src/app/api/webhooks/stevo/route.ts:67-79`
  — sem `STEVO_INSTANCE_TOKEN` setado, aceita qualquer payload (só warn). Aceitável
  em setup, mas P2: garantir a env em prod (o inbound-message GHL já tem o modo
  fail-closed via `WEBHOOK_REQUIRE_SIGNATURE`).
- **P2-5 — `synthetic-test` compara secret sem timing-safe:** `…/synthetic-test/route.ts:39`
  usa `auth !== \`Bearer ${cronSecret}\`` (os crons usam `isAuthorizedCron` constante-
  time). Baixo risco (mesma key dos crons), mas padronizar via `isAuthorizedCron`.

---

## WORKS (verificado — boa higiene, não mexer)

- **Webhook GHL inbound:** HMAC SHA-256 + `timingSafeEqual` + fail-closed opcional
  (`WEBHOOK_REQUIRE_SIGNATURE`). `inbound-message/route.ts:97-120`. ✔
- **CORS:** allowlist por regex de host, ecoa Origin (não `*`) com `Vary: Origin`.
  `src/lib/utils/cors.ts`. (`loader/route.ts:39` usa `*` mas serve só JS público sem
  credenciais — OK.) ✔
- **JWT SparkBot Web + JWKS GHL:** RS256 verify real contra JWKS Firebase, checa
  `iss` conhecido + `user_id`/`company_id` match (corrige o exploit do review 04-29).
  `check-admin/route.ts`, `web-auth.ts`. ✔
- **cron-auth:** constante-time + rejeita secret vazado (00032/753b6a1) explicitamente.
  `src/lib/utils/cron-auth.ts`. ✔
- **SSRF KB (URL do usuário):** `isSafeHttpUrl` bloqueia localhost/privados/link-local
  (169.254)/CGNAT/IPv6 ULA + `redirect:"error"` + timeout. `knowledge-base/route.ts:122-139`. ✔
- **GHLClient não é SSRF:** base é constante (`GHL_API_BASE`), só o path concatena
  (paths internos). `src/lib/ghl/client.ts:102`. ✔
- **IDOR scoping correto** (com `.eq(location_id)` ou `assertLocationInCompany`):
  agents/[agentId] (route, activity, generate-note), media, feedback, settings,
  billing, conversations/resume, agents/test, entitlements (+revoke), agent-platform
  modules. ✔
- **Upload limits:** KB 15 MB + 422 em extração vazia; media 25 MB + MIME allowlist;
  transcribe 25 MB. ✔
- **Secrets:** nenhum hardcoded em src/scripts; `.env.local` gitignored e não-trackeado;
  logs não imprimem token/key (só msg de erro). ✔
- **Schema drift:** **NENHUM** nas colunas suspeitas — `conversation_state.ai_paused_at/
  reason/summary_note_id`, `usage_records.{cached,cache_creation,audio_seconds,audio_model,
  image_count,claim_token,claimed_at,charged_at}`, `agents.{audience,template_key,
  expires_at}`, `agent_configs.conversation_examples` todas presentes em prod (00085
  fechou o gap do `ai_paused_at`). ✔
- **Cron drift:** prod `cron.job` = followup-runner(30s), process-message-queue→
  /api/agents/process-batch(10s), sparkbot-proactive(30s), sparkbot-cleanup(3am),
  dedup-locks-cleanup(5min). `vercel.json` = process-queue(diário) + refresh-ghl-token
  (diário). Sem conflito; todos autenticados. ✔

---

## Falsos-positivos descartados

- `stevo-handler.ts`, `daily-briefing-prompt.ts` → pareciam órfãos no grep estático,
  mas são **dynamic imports** (`await import(...)`) no stevo webhook e no cron
  sparkbot-proactive. NÃO são dead code.
- `.or()` em followup.ts → **não** é IDOR cross-tenant (escopo `.eq` em AND antes).
  Rebaixado a P2.
- Migrations RLS (00007/00028) → não são "drift", são corretas; só estão dormentes
  porque o runtime nunca usa a anon key (ver Fato Transversal).
- `loader/route.ts` `ACAO:*` → benigno (JS público, sem credenciais).

---

## Resumo de contagem
- **P0: 2** (SSO fail-open / SparkBot config cross-company)
- **P1: 3** (IDOR rules / next CVE / xlsx CVE)
- **P2: 5** (or-interp, pdf-parse morto, seed órfão, stevo fail-open, synthetic-test timing)
- Falsos-positivos descartados: 4.
