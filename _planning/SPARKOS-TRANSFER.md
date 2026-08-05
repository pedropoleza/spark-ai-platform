# SparkOS — Handoff de contexto / transferência

> **Objetivo deste doc:** dar a um chat novo (sem memória) TODO o contexto técnico da operação Spark pra centralizar/transferir pro **SparkOS**. Gerado 2026-06-15. Idioma do projeto: PT-BR. Dono: Pedro Poleza (Brazillionaires / Five Rings / National Life).
>
> ⚠️ Este doc lista **nomes** de secrets e onde moram — NUNCA os valores. Os valores estão em Vercel/Supabase env.

---

## 0. O que é a operação Spark (orientação rápida)

**Spark Leads** = SaaS de CRM + automação + IA pra agentes de seguro de vida BR (mercado EUA, recrutados na Five Rings/National Life). É um **white-label do GoHighLevel (GHL)** + camadas próprias por cima:
- **SparkBot** — assistente de IA que opera o CRM por WhatsApp (produto principal, no repo AI platform).
- **Provisionamento** — quando alguém compra um plano, automações criam a sub-account, aplicam snapshot, registram no Notion e taggeiam (Edge Functions).
- **spark-plans-tracker** — ferramenta interna que versiona o conteúdo dos 3 planos (templates, funis, workflows, custom fields) e roda bootstrap/cross-intelligence.
- 3 planos: **Starter $79 · Growth $119 · Agency $249/mês**.

> Regra de marca: em qualquer coisa user-facing é **"Spark Leads"/"Spark"**, NUNCA "GHL"/"GoHighLevel".

---

## 1. Mapa dos componentes (visão de cima)

| Componente | Onde mora (local) | Git | Deploy | Banco (Supabase) |
|---|---|---|---|---|
| **AI Platform** (SparkBot, agentes, hub, admin) | `/Users/pedropoleza/SPARK APPS/AI platform` | ✅ GitHub `pedropoleza/spark-ai-platform` | Vercel `prj_xSvhYTFDumLhkrmbLEbgIWKU2kuc` | **AI Agent Hub** `vyfkpdnwevtuxauacouj` |
| **spark-plans-tracker** (planos + provisioning + cross-intel) | `/Users/pedropoleza/spark-plans-tracker` | ❌ **NÃO é git** (só local + Vercel) | Vercel `prj_dYbpbhzPatEW6MGPyQMgpuSQsMZ1` | **Sparkleads OS** `nsqwgjbgcdqyzozyaltz` |
| **Edge Functions** (provision, stripe-webhook, cross-intelligence) | fonte em `spark-plans-tracker/supabase/functions/` | (segue o tracker) | Supabase Functions | **Sparkleads OS** `nsqwgjbgcdqyzozyaltz` |
| **GHL Token store** (token OAuth rotativo) | — | — | Supabase | **GHL Token** `tbziahcpkrfiksqhuhpe` |
| **Demo interativa de vendas** (NOVO, planejado) | ainda não existe código | — | (futuro `demo.sparkleads.pro`) | — |

Org Vercel: `team_jQzzIs3ymfUoqtXAcHyv8CeA`. Org Supabase: `eqkzihusqowloaetmnvl`.

---

## 2. Repo: AI Platform (produto principal)

- **Path:** `/Users/pedropoleza/SPARK APPS/AI platform`
- **GitHub:** `https://github.com/pedropoleza/spark-ai-platform.git`
- **Branch atual de trabalho:** `feat/task-orchestrator` (worktrees ativas em `.claude/worktrees/`). Branch principal: `main`.
- **package.json name:** `matrix-ai-hub` (legado — rebrand "Matrix" foi revertido; não confiar nesse nome).
- **Stack:** Next.js 15.5 (App Router) · React 18 · TypeScript · Tailwind · Supabase JS · **Anthropic SDK** + **OpenAI** + **Groq** (fallback) + **Voyage** (embeddings) · Sentry · jose (JWT) · unpdf/mammoth/xlsx/papaparse (parse de mídia) · zod.
- **Áreas (`src/app/`):** `admin`, `api`, `demo`, `embed` (painel SparkBot injetado no GHL), `hub` (Spark Hub), `tv`, + `lib`, `components`, `hooks`, `types`, `middleware.ts`.
- **DB:** Supabase **AI Agent Hub** (`vyfkpdnwevtuxauacouj`). **116 migrations** em `supabase/migrations/` (sempre criar arquivo de migration mesmo aplicando via MCP).
- **Docs no repo:** `docs/DECISIONS.md` (decision codes H1, C4, NB-6…), `docs/RUNBOOK.md`, `CLAUDE.md` (instruções de sessão), `_planning/`.
- **O que faz:** SparkBot (~62 tools em 14 módulos, multi-canal WhatsApp+Web, proatividade, billing, RAG carrier KB), agentes de Sales/Recruitment (falam com leads), provisioning helpers, admin/signals, onboarding.

---

## 3. Repo: spark-plans-tracker (ferramenta interna) ⚠️

- **Path:** `/Users/pedropoleza/spark-plans-tracker`
- **Git:** ❌ **NÃO está versionado** (`fatal: not a git repository`). Existe só nesta máquina + build na Vercel. **RISCO ALTO de perda.**
- **Deploy:** Vercel `prj_dYbpbhzPatEW6MGPyQMgpuSQsMZ1` (app em `app.sparkleads.pro/tracker` ou domínio próprio).
- **Stack:** Next.js (App Router) · Supabase · Anthropic SDK · **react-flow + dagre** (canvas Miro-like dos snapshots) · Tailwind.
- **Estrutura (`app/`):** `api`, `snapshot/` (canvas + editores CRUD por entidade), `seed-data.ts`, `constants.ts`, `tracker-client.tsx`, `lib`.
- **DB:** Supabase **Sparkleads OS** (`nsqwgjbgcdqyzozyaltz`) — tabelas de planos/snapshot (templates, funis, workflows, custom fields/values, tags, calendars, onboarding) + tabelas de provisioning + undo log.
- **Edge Functions (fonte em `supabase/functions/`):** `_shared`, `provision`, `stripe-webhook`, `cross-intelligence` → deployadas no projeto **Sparkleads OS**.
- **O que faz:** versiona o conteúdo dos 3 planos, gera/edita templates com IA, roda bootstrap real no GHL (cria custom fields/funis/calendars/tags nas masters), e hospeda as Edge Functions de provisioning/cross-intel.

---

## 4. Backend — projetos Supabase (org `eqkzihusqowloaetmnvl`)

**Core Spark (confirmado):**
| Projeto | Ref | Papel |
|---|---|---|
| **Sparkleads OS** | `nsqwgjbgcdqyzozyaltz` | DB do tracker + planos + provisioning + **as 3 Edge Functions** |
| **AI Agent Hub** | `vyfkpdnwevtuxauacouj` | DB do AI platform (SparkBot, rep_identities, sparkbot_messages, agents, agent_configs, proactive, carrier KB/pgvector, usage_records) |
| **GHL Token** | `tbziahcpkrfiksqhuhpe` | Token OAuth da company GHL, rotativo. RPC `get_ghl_company_token(p_company_id)` — lido cross-project pelas Edge Functions |

**Possivelmente no escopo (confirmar com Pedro):**
- **spark-referral-hub** `mumdhdiliejulkblwhuw` — sistema de Indicações (nav "Indicações").
- **Brazllionaires Portal** `whsactqctszcpppebfmk` — portal da agência.
- **Notification pop-up** `bofqjmxiwjmxrkokplnp` / **Support Platform** `vgnhqycgfbuyyrsrwjxr` — observabilidade/suporte.

(Os demais projetos na org — poker, driveon, polex, vincit, ies, boazz, robinhood etc. — NÃO são Spark.)

---

## 5. Edge Functions (no projeto Sparkleads OS `nsqwgjbgcdqyzozyaltz`)

Base URL: `https://nsqwgjbgcdqyzozyaltz.supabase.co/functions/v1/<slug>`. Todas `verify_jwt:false`.

| Slug | Versão | Trigger | O que faz |
|---|---|---|---|
| **provision** | v14 ACTIVE | Webhook do Marketplace GHL (instalação/SaaS plan no checkout) | Pega company token via RPC → GET user+location → **tag `plano X` + custom fields no Master CRM** → **registra no Notion** (DB Clients) → seta **custom values**, **permissões do user**, **timezone** na sub-account. Idempotente (dedup_key). |
| **stripe-webhook** | v7 ACTIVE | Eventos Stripe | Caminho Stripe-driven: cria/valida sub-account a partir de evento Stripe. |
| **cross-intelligence** | v4 ACTIVE | POST manual (`?phase=inventory\|activity\|usage\|cleanup`) | Cruza Stripe × GHL × Notion pra achar discrepâncias (cancelado-mas-usando, credit leak). Relatório em `spark-plans-tracker/_planning/cross-intelligence-report-*`. |

> Fonte das 3 está em `spark-plans-tracker/supabase/functions/` — que **não está em git** (ver risco §10).

---

## 6. Serviços externos & IDs

**GHL / Spark Leads (white-label):**
- Company ID: `TdmQMjj86Y3LgppiB96K`
- Marketplace App ID: `67cf4ed48fa066a72e313796` (app plugado pro token refresh)
- API base: `https://services.leadconnectorhq.com` (Version `2021-07-28`)
- Domínios white-label: `app.sparkleads.pro` (CRM), `internal.sparkleads.pro` (checkout/sale links), `checkout.sparkleads.pro` (landing do Gabriel), `demo.sparkleads.pro` (demo futura)
- **SparkBot hub:** location `RBFxlEQZobaDjlF2i5px`, WhatsApp **+1 (813) 407-9657** (inbound via painel **Stevo**/Evolution — SPOF, sem API oficial). Hub legacy: `Cjc1RonkhwcnrMp3vAqt`.
- **SaaS products (GHL):** starter `6a0cbb5dd9543eecdf1cb42d` · growth `6a0cbc6f9f3f186fa16ba653` · agency `6a0cbce993431a895fbde019`
- **Sale links (payment-link GHL):** starter `6a28e93e71a0aa761e463f38` · growth `6a298c7603b17c94f5715957` · agency `6a298c8e71a0aa761e464078`
- **Conta de demo populada:** location `6J00coEYiQ0OaLITveML` ("Growth Snapshot", Orlando) — ~73 contatos/75 opps/17 tasks/conversas fictícias (funis Vendas `K9v7lZclsqDLzQR7fUHq` + Apólices `73KwD4xMICoTPZcMbbXj`).

**Stripe:** products `prod_UXzOUwJ7hVRqNI` (starter) · `prod_UXzTvmFOXqbhPW` (growth) · `prod_UXzVvD1ci47Aup` (agency). Conta `acct_1NfTc7BWo9pIJAZW`. Restricted key `rk_live_*` (precisa scope `subscription_write` pra cancelar subs).

**Notion:** DB "Clients" `c84f9daf-b8cf-4ef1-955d-7fb4d88b70a8` (data source `ee340e48-85e3-4864-8fc3-ffdae7b4b77b`). API `2022-06-28`.

**IA/infra:** Anthropic (Claude — primário SparkBot/sales), OpenAI (fallback + geração de imagem), Voyage (embeddings 1024d, carrier KB), Groq (fallback). Vercel (org `team_jQzzIs3ymfUoqtXAcHyv8CeA`).

---

## 7. Secrets / env vars (NOMES — valores em Vercel/Supabase)

**AI Platform (Vercel env, projeto `prj_xSvhYTFD…`):**
`NEXT_PUBLIC_SUPABASE_URL` (=AI Agent Hub), `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GHL_TOKEN_SUPABASE_URL` (=GHL Token proj), `GHL_TOKEN_SUPABASE_SERVICE_KEY`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_API_BASE`, `NEXT_PUBLIC_GHL_COMPANY_ID`, `GHL_MARKETPLACE_APP_ID`, `GHL_BILLING_METER_ID`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `VOYAGE_API_KEY`, `JWT_SECRET`, `CRON_SECRET`, `NEXT_PUBLIC_SENTRY_DSN`, `DEV_MODE`/`NEXT_PUBLIC_DEV_MODE`. (Falta no `.env.local`, conferir na Vercel: `ANTHROPIC_API_KEY`.)

**tracker (Vercel env, projeto `prj_dYbpbhz…`):** `NEXT_PUBLIC_SUPABASE_URL` (=Sparkleads OS), `SUPABASE_ANON_KEY`, + `ANTHROPIC_API_KEY` (gerar templates).

**Edge Functions (Supabase secrets, projeto Sparkleads OS):** `STRIPE_SECRET_KEY`, token/anon do projeto GHL Token (pra RPC), `NOTION_TOKEN`, IDs do Notion. (Hoje alguns estão hardcoded no source — ver §10.)

---

## 8. Crons / jobs agendados

- **pg_cron (Supabase):** `sparkbot-proactive` (cada 30s, advisory lock `8675309`), refresh do token GHL (self-heal), `signals-alert` (5min), cleanup de proativos. (Ver migrations 00053/00034 etc. no AI platform.)
- **Vercel cron:** refresh centralizado do token GHL + billing. (`CRON_SECRET` obrigatório.)

---

## 9. Base de conhecimento (memória) — mover junto

A memória persistente deste agente está em:
`/Users/pedropoleza/.claude/projects/-Users-pedropoleza-SPARK-APPS-AI-platform/memory/`
Index em `MEMORY.md`. Arquivos-chave: `sparkbot.md` (subsistema completo), `architecture.md`, `features_status.md`, `file_structure.md`, `ghl_integration.md`, `ghl_token_refresh.md`, `stevo-inbound-outage.md`, `anthropic-credits-outage.md`, `spark-brand-colors.md` (azul `#1675F2`), `spark-demo-interativa.md`, `observability-alerts.md`. **Esses arquivos são parte do contexto a centralizar no SparkOS.**

---

## 10. ⚠️ Riscos & o que precisa ser feito pra transferir

1. **🔴 `spark-plans-tracker` não está em git.** Antes de qualquer transferência: `git init` + push pra GitHub (ex: `pedropoleza/spark-plans-tracker`). Hoje um `rm -rf` perde tudo (inclui o source das 3 Edge Functions).
2. **🟠 Secrets hardcoded em Edge Functions.** A `cross-intelligence` (e talvez provision) tem tokens/IDs no source (Notion token, anon key do GHL Token). Mover pra Supabase secrets / `Deno.env` antes de versionar/publicar.
3. **🟠 Definir o que "SparkOS" centraliza:** (a) **monorepo** unindo AI platform + tracker (+ referral)? (b) **central de conhecimento** (docs/Notion + estes memory files)? (c) **consolidar Supabase** (hoje são 3 projetos: AI Agent Hub + Sparkleads OS + GHL Token)? Cada caminho muda os passos. → **decisão do Pedro.**
4. **🟠 Nome legado `matrix-ai-hub`** no package.json do AI platform — renomear no rebrand pro Spark.
5. **🟡 Dependência Stevo (WhatsApp)** é SPOF sem API oficial — documentar no SparkOS como ponto frágil.
6. **🟡 Mapear acessos** (abaixo) e transferir/compartilhar ownership.

**Checklist de transferência (genérico, serve pra qualquer formato de SparkOS):**
- [ ] `git init` + push do `spark-plans-tracker`
- [ ] Tirar secrets hardcoded das Edge Functions → Supabase secrets
- [ ] Inventariar e re-provisionar env vars nos 2 projetos Vercel + Supabase secrets
- [ ] Decidir destino (monorepo / knowledge base / consolidação de infra) — §10.3
- [ ] Mover os memory files (§9) pra central do SparkOS
- [ ] Transferir/compartilhar ownership: GitHub, Vercel (org `team_jQzzIs3ymfUoqtXAcHyv8CeA`), Supabase (org `eqkzihusqowloaetmnvl`), GHL Marketplace app, Stripe, Notion, Stevo, Anthropic/OpenAI/Voyage/Groq
- [ ] Atualizar `CLAUDE.md` + `docs/` apontando pra estrutura SparkOS

---

## 11. Em andamento / pendências

- **Demo interativa de vendas (NOVA)** — planejada, sem código ainda. Contexto em `spark-demo-interativa.md` (memória) + brief pro "Claude Design" (no chat). 7 cenas, quiz→plano, 2 modos (apresentação/solo), telas fiéis ao GHL, marca azul. Pendente: 3 dados reais do Pedro (prova social, claims de segurança, urgência).
- **Conta de demo** `6J00coEYiQ0OaLITveML` populada (ver §6). Faltam agendamentos + respostas outbound nas conversas (opcional).
- **Tasks abertas do tracker:** #64 (expor 3 tabelas de provisioning no Browse), #73 (cupom no SaaS sale link).
