# RV2 — Re-avaliação de Arquitetura & Organização (pós-V2)

> Auditoria READ-ONLY. Re-avalia ARQUITETURA e ORGANIZAÇÃO do SparkBot **após** a
> refatoração V2 (commits `sparkbot-v2-baseline..HEAD`, Ondas 1–4). Baseline:
> `B1-arquitetura.md` (6,5/10) e `B3-organizacao.md` (5,5/10), de 2026-05-19.
> Toda afirmação ancorada em `arquivo:linha`, commit ou contagem `grep`. PT-BR.

---

## 1. RESUMO EXECUTIVO

A V2 foi uma refatoração **cirúrgica e honesta**: atacou exatamente os pontos onde
o baseline foi mais duro **na qualidade de comportamento** (gate de coerência,
governança de escopo/IAM) e fez uma limpeza real de duplicação (bulk V1) e de
violações Spark Leads≠GHL — mas **conscientemente adiou** a maior dívida estrutural
(camada de repositório, decomposição do `webhook-handler`, multi-tenant, colisões de
nome) para a "Fase Estrutural V2.1".

O que entrou é **bem-feito e devidamente plugado**, não cosmético:

- **`core/coherence-gate.ts`** (240 LOC, módulo PURO sem I/O) extraiu ~290 LOC do
  god-file `processor.ts` (939→720 LOC, **−23%**). E não é só extração: virou um
  **gate que age** — verifica o RESULTADO da tool (não só o nome), separa
  criar-vs-mover opportunity (caso Henry), e escolhe caminho seguro `rerun`/`rewrite`
  (`coherence-gate.ts:197-240`, plugado em `processor.ts:480,542`). Antes era
  signal-only ("não bloqueava a resposta").
- **`ghl/scope-manager.ts`** + `client.ts` IAM-não-retryable + `types.ts` classificador
  (`scope_or_location`/`unsupported_endpoint`) + migration `00068`. Isto fecha **a raiz
  estrutural comum dos dois P0/P1** que o B1 §5 apontou como "escopo mora FORA do
  código": agora 5xx-IAM dá throw imediato (`client.ts:68-75`, sem desperdiçar 3 calls)
  e o erro vira signal acionável pro admin ("reconecte a location X") via
  `flagScopeIssue`, fire-and-forget no `executeTool` (`index.ts:234-247`).
- **Bulk consolidation**: `bulk-messages.ts` 1.429→992 LOC (**−437**), tools V1
  deprecated `preview_bulk_message`/`schedule_bulk_message` **removidas do registry**
  (`bulk-messages.ts:20-21`). O LLM não recebe mais 2 tools mortas no schema.
- **Spark Leads≠GHL (achado forte)**: as **16 ocorrências LLM-facing** que o B3 §5
  listou como o item #1 de urgência (system prompt + tool descriptions, incl. o
  `prompt-builder.ts:205` "GHL Smart Lists") **foram ZERADAS**. `grep` de string
  literal com `\bGHL\b` em `prompt-builder.ts` + `tools/*.ts` = **0** (Onda 3).
- **`proactive/silence-gate.ts`**: novo `kind: "requested"` (`:54,71`) — lembrete
  pedido pelo rep não conta no contador de silêncio. Corrige punição indevida.

**Mas a tese central do B1 segue de pé:** a **camada de repositório continua
inexistente** (158× `createAdminClient()` crus, **idêntico** ao baseline), as 42→**43**
chamadas `ctx.ghlClient.*` nas tools **aumentaram** (nenhuma migrou pra `operations.ts`),
`webhook-handler.ts` segue **1.052 LOC intacto**, multi-tenant segue meio-feito
(`ASSISTANT_HUB_LOCATION_ID` ainda load-bearing, 21 refs) e as colisões de nome
(2× `processor.ts`, 2× `prompt-builder.ts`) + pg_cron URL hardcoded **não foram tocadas**.

### Veredito

| Eixo | Baseline | Pós-V2 | Δ |
|------|:---:|:---:|:---:|
| **ARQUITETURA** | 6,5 | **7,0** | **+0,5** |
| **ORGANIZAÇÃO** | 5,5 | **6,5** | **+1,0** |

**Por que arquitetura sobe só +0,5:** dos 5 problemas estruturais que o B1 listou, a V2
resolveu **1 inteiro** (escopo/IAM, problema #2) e mitigou parte do #5 (orquestração LLM —
o gate foi extraído, mas o loop `processor`×`dispatcher` ainda é duplicado). Os 3 mais
pesados — **sem camada de repositório (#1, P0), fronteira GHL vazada (#3), multi-tenant
inconsistente (#4)** — seguem **integralmente abertos**. O movimento foi correto em
direção, mas a maior dívida estrutural por LOC e por superfície de risco continua. Subir
mais que +0,5 seria premiar intenção, não estrutura entregue.

**Por que organização sobe +1,0:** aqui a V2 mirou o que o B3 chamou de mais urgente e
acertou — zerou as 16 violações LLM-facing (item #1, afetava 37 reps em prod), removeu
duplicação real de tools (item #2/#5, −437 LOC + 2 tools mortas fora do schema) e tirou
290 LOC do `processor`. São ganhos **mensuráveis e de baixo risco de regressão**, que é o
exato critério do eixo organização. Não sobe mais porque os arquivos gigantes seguem
(`prompt-builder.ts` 1.181, `webhook-handler.ts` 1.052, `calendar.ts` ~1.363), o header
do `index.ts` segue desatualizado (diz "88 tools") e o file-placement (raiz vs
`core/`/`prompts/`/`media/`) só começou — `core/` nasceu, mas só com 1 arquivo.

---

## 2. O QUE MELHOROU / O QUE FALTA

| Tema | Baseline (2026-05-19) | Estado pós-V2 | Veredito |
|------|------------------------|----------------|----------|
| **Gate de coerência / alucinação** | Detector inline no `processor.ts` (300 LOC regex), **signal-only**, não bloqueava resposta; create satisfazia "movido" (caso Henry) | Extraído p/ `core/coherence-gate.ts` (módulo puro, testável). Verifica RESULTADO da tool; `rerun`/`rewrite` seguros; nunca duplica escrita já feita | ✅ **Resolvido + melhorado** |
| **Governança de escopo GHL/IAM (raiz dos 2 P0/P1)** | Escopo salvo e **nunca lido**; 100% reativo; 5xx-IAM tratado como transitório (3 retries desperdiçados); 403 só virava string pro LLM | `scope-manager.ts` + `00068` + IAM não-retryable (`client.ts:68`) + classificador `types.ts:241-261` + signal admin acionável (`index.ts:238`) | ✅ **Resolvido** (raiz fechada) |
| **Bulk V1/V2 duplicação** | 3.632 LOC, 16 tools, V1 era "biblioteca disfarçada de tool file"; 2 tools DEPRECATED ainda no schema | `bulk-messages.ts` −437 LOC (1.429→992); V1 `preview/schedule` removidas do registry | ✅ **Melhorado** (helpers ainda em V1) |
| **Violações Spark Leads≠GHL (LLM-facing)** | **16** ocorrências (9 prompt + 7 tool desc), incl. `:205` instruindo "GHL Smart Lists" ao rep | **0** — `grep \bGHL\b` em strings = vazio (Onda 3) | ✅ **Resolvido** |
| **Silence-gate (lembrete solicitado)** | Proativo solicitado punia contador de silêncio | `kind:"requested"` não conta (`silence-gate.ts:54,71`) | ✅ **Resolvido** |
| **Camada de repositório (B1 #1, P0)** | **158×** `createAdminClient()` crus, nomes de tabela/coluna hardcoded em ~34 arquivos | **158×** — **idêntico**. Nenhum `repo/`/`dao/` criado | ❌ **Adiado** (maior dívida aberta) |
| **Fronteira GHL vazada (B1 #3, P1)** | 42× `ctx.ghlClient.*` em 8 tool files furando `operations.ts` | **43×** (subiu — `opportunities.ts` mexido sem migrar) | ❌ **Adiado / piorou marginalmente** |
| **`webhook-handler.ts` god-file** | 1.052 LOC, 8 tabelas, dedup+billing+persist+envio | **1.052 LOC** — não tocado | ❌ **Adiado** |
| **Multi-tenant inconsistente (B1 #4, P1)** | `ASSISTANT_HUB_LOCATION_ID` load-bearing em proactive/tools/admin | **21 refs** — não tocado; pg_cron URL hardcoded (3 migrations) | ❌ **Adiado** |
| **Colisões de nome / loop duplicado** | 2× `processor.ts`, 2× `prompt-builder.ts`; loop LLM duplicado `processor`×`dispatcher` | Colisões intactas; loop ainda duplicado (só o gate foi extraído) | ❌ **Adiado** |
| **Arquivos gigantes / file-placement** | `prompt-builder.ts` 1.153, `calendar.ts` 1.363; raiz poluída | `prompt-builder.ts` **1.181** (+28); `core/` nasceu mas só 1 arquivo; header `index.ts` ainda erra ("88 tools") | ⚠️ **Parcial** (`processor` −219, mas outros estáveis/+) |

---

### Apêndice — números medidos (read-only, 2026-05-20)

- `createAdminClient()`: **158** (baseline 158 — sem mudança).
- `ctx.ghlClient.{verb}` direto em tools: **43** (baseline 42 — +1).
- `ASSISTANT_HUB_LOCATION_ID`: **21** refs.
- LOC: `processor.ts` **720** (era 939, −219/−23%) · `bulk-messages.ts` **992** (era 1.429, −437)
  · `prompt-builder.ts` **1.181** (era 1.153, +28) · `webhook-handler.ts` **1.052** (inalterado)
  · novo `coherence-gate.ts` **240** · novo `scope-manager.ts` **105**.
- LLM-facing "GHL" em `prompt-builder.ts` + `tools/*.ts`: **0** (era 16).
- Diffstat V2: 16 arquivos, **+643 / −797** em `src/`.
- Novos: `core/coherence-gate.ts`, `ghl/scope-manager.ts`, migration `00068_location_scope_coverage.sql`.
- Colisões de nome: 2× `processor.ts`, 2× `prompt-builder.ts` (inalterado).
- pg_cron URL `spark-ai-platform.vercel.app` hardcoded: migrations `00032`, `00041`, `00053`.
