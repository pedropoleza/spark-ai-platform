# Spark AI Hub

Plataforma multi-tenant de agentes de IA integrada ao **GoHighLevel (GHL)** como Marketplace App. Hospeda 3 tipos de agentes:

| Agente | Quem fala com | O que faz |
|--------|---------------|-----------|
| **Sales Agent** | Leads (potenciais clientes) | Qualifica, agenda reuniões via WhatsApp/SMS |
| **Recruitment Agent** | Candidatos | Triagem inicial, agendamento de entrevistas |
| **Sparkbot** (Account Assistant) | Reps (vendedores da agência) | Copiloto IA pra operar o CRM via natural language — busca contatos, cria tasks, manda lembretes, importa CSVs, etc. |

**Repositório:** monorepo Next.js 14 (App Router) + Supabase (Postgres + pgvector + pg_cron) + dual-provider LLM (Anthropic Claude primary, OpenAI fallback).

---

## Stack

- **Runtime:** Next.js 14, Node 18+, TypeScript, Vercel (production: `spark-ai-platform.vercel.app`)
- **DB:** Supabase Postgres (project `vyfkpdnwevtuxauacouj`) + 2º Supabase só pra GHL tokens (`tbziahcpkrfiksqhuhpe`)
- **AI:**
  - Conversational: Claude Sonnet 4.6 → Haiku 4.5 → GPT-4.1 (fallback chain)
  - Audio: Whisper-1
  - Embeddings: Voyage AI (`voyage-3.5-lite`, 1024 dims)
- **Integrations:** GHL v2 API (multi-location, OAuth marketplace), Stevo (WhatsApp via Evolution API)
- **Migrations:** `supabase/migrations/` (43 sequenciais, sem buracos)

---

## Estrutura

```
src/
├── app/                              # Next.js App Router
│   ├── api/                          # rotas API (webhooks, sparkbot, agents, cron)
│   ├── agents/                       # dashboard pra configurar agentes
│   └── embed/sparkbot/               # painel flutuante embedado no GHL
├── components/                       # UI components (radix + tailwind)
├── lib/
│   ├── account-assistant/            # SPARKBOT (separado dos sales/recruitment)
│   │   ├── tools/                    # 38 ferramentas (CRUD GHL via natural language)
│   │   ├── proactive/                # regras proativas + cron + reminders
│   │   ├── webhook-handler.ts        # entrypoint WhatsApp inbound
│   │   ├── processor.ts              # pipeline: identity → terms → LLM → tools
│   │   ├── llm-client.ts             # Claude→Haiku→OpenAI fallback chain
│   │   ├── prompt-builder.ts         # system prompt (channel-aware)
│   │   └── identity.ts               # rep_identity (BR-aware phone normalize)
│   ├── ai/                           # SALES + RECRUITMENT shared
│   │   ├── prompt-builder.ts         # diferente do sparkbot (público diferente)
│   │   ├── audio-transcriber.ts      # Whisper (compartilhado com sparkbot)
│   │   ├── media-extractor.ts        # imagem/PDF/CSV
│   │   └── history-compressor.ts     # gpt-4.1-nano summarizer
│   ├── ghl/                          # GHL API client + OAuth
│   ├── billing/                      # trackAndCharge → wallet GHL
│   ├── queue/                        # debounce + processor (sales/recruitment)
│   └── utils/                        # validation (Zod), supabase admin, etc
├── types/                            # tipos compartilhados
└── supabase/
    └── migrations/                   # 43 migrations sequenciais
```

Pasta `_planning/` tem **design docs vivos** (V1/V2 do Sparkbot, reviews 04-28/04-29, NLG KB plan, GHL API reference). Leitura recomendada pra entender decisões.

---

## Setup local

```bash
git clone <repo>
cd "AI platform"
npm install
cp .env.example .env.local
# preencher: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# OPENAI_API_KEY, ANTHROPIC_API_KEY, GHL_CLIENT_ID/SECRET,
# ASSISTANT_HUB_LOCATION_ID, ASSISTANT_HUB_COMPANY_ID,
# CRON_SECRET, JWT_SECRET, VOYAGE_API_KEY
npm run dev
```

**Migrations**: aplicar via Supabase Dashboard (SQL Editor) ou MCP. **Importante:** sempre criar arquivo em `supabase/migrations/` em paralelo — não deixar drift entre prod e git.

---

## Deploy

Auto-deploy via Vercel: `git push origin main` → produção em ~1min. Sem branches por enquanto (solo dev).

Crons rodam em **2 lugares**:
- **Vercel Cron**: `vercel.json` — `/api/cron/process-queue` (1×/dia rebuild)
- **Supabase pg_cron**: dispara `/api/cron/sparkbot-proactive` e `/api/cron/summary-notes` (a cada 30s/5min). Migrations `00008`, `00032`, `00041`. Auth via `CRON_SECRET`.

Ver [`docs/RUNBOOK.md`](docs/RUNBOOK.md) pra rollback, debug, env rotation.

---

## Documentação

| Arquivo | Pra quê serve |
|---------|--------------|
| `README.md` (este) | Visão geral + setup |
| `CLAUDE.md` | Convenções pro Claude Code/Cursor (toda nova sessão deve ler) |
| `docs/DECISIONS.md` | Index de decisões arquiteturais (H1/H8/C2/NB-6/P0…) |
| `docs/RUNBOOK.md` | Operação: rollback, logs, debug routes, env rotation |
| `CHANGELOG.md` | Histórico organizado de releases |
| `_planning/account-assistant-v1.md` | Design original do Sparkbot |
| `_planning/account-assistant-v2.md` | Tool catalog 38 + proatividade dinâmica |
| `_planning/sparkbot-web-ui-setup.md` | Painel embedado via Custom JS |
| `_planning/_review-2026-04-28/00-RELATORIO-EXECUTIVO.md` | 12 bugs P0/HIGH triados (resolvidos) |
| `_planning/_review-2026-04-29/00-RELATORIO-EXECUTIVO.md` | 4 CRITICAL Sprint 0 (resolvidos) |
| `_planning/ghl-api-reference.md` | Endpoints GHL v2 usados |
| `_planning/nlg-kb-implementation-plan.md` | RAG/pgvector pra knowledge base |

---

## Observações

- **Idioma:** comments + commits em **PT-BR** (Pedro é BR). Tools descriptions também.
- **Multi-tenant:** uma instalação serve várias agências (cada agência = `companyId`); cada agência tem N locations.
- **Sparkbot tem 2 hubs ativos**: a location `Cjc1RonkhwcnrMp3vAqt` (Web UI antigo) + `RBFxlEQZobaDjlF2i5px` (WhatsApp via Stevo). Suporta multi-hub via query DB (não env var).
- **Bugs críticos resolvidos recentes**: ver `CHANGELOG.md` "v0.4.0 WhatsApp readiness" + "v0.4.1 audio fixes".
