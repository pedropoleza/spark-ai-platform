# RV4 — Re-avaliação pós-Fase Estrutural V2.1

> Auditoria READ-ONLY. Re-avalia ARQUITETURA e ORGANIZAÇÃO do SparkBot **após a V2.1**
> (commits `338d6c8`, `87d6987`, `ab22b40`, `62efcdd`). Baselines: Original B1/B3 (6,5 /
> 5,5) e pós-V2 RV2 (7,0 / 6,5). Toda afirmação ancorada em `arquivo:linha`, commit,
> contagem `grep` ou resultado de teste. PT-BR. Data: 2026-05-20.

---

## 1. RESUMO EXECUTIVO

A V2.1 fez **exatamente o que prometeu** e atacou as 3 maiores dívidas estruturais que a
RV2 deixou explicitamente abertas — e o fez **sem regressão comportamental** (golden suite
100%, `tsc --noEmit` limpo). Diferente da V2 (que foi forte em organização mas tímida em
estrutura), a V2.1 é uma refatoração **de fronteiras** — o tipo de trabalho que move o eixo
ARQUITETURA, não só o de ORGANIZAÇÃO.

Os três movimentos pesados entregues:

- **Fronteira GHL FECHADA (B1 §3 violação 3 — resolvida).** As 42–43 chamadas com **verbo
  cru** `ctx.ghlClient.{get,post,put,delete}` nas tools foram **ZERADAS**: `grep -rnE
  "ctx\.ghlClient\.(get|post|put|delete|patch)\b" src/lib/account-assistant/` = **0**.
  `operations.ts` cresceu de ~33 para **47 primitivas exportadas** (+497 LOC, commit
  `338d6c8`). As 61 referências `ctx.ghlClient` que ainda aparecem em `tools/` são agora
  **o client passado como argumento** para uma primitiva (`searchOpportunities(ctx.ghlClient,
  …)`, `createNoteOnContact(ctx.ghlClient, …)`) — que é precisamente o padrão-alvo. A
  violação não é "grep literal vazio" (a expectativa do brief estava imprecisa nesse ponto),
  mas o **objetivo arquitetural — nenhuma tool fura `operations.ts` com verbo HTTP cru —
  está cumprido**.
- **Multi-tenant real via `hub-resolver.ts` (B1 §6 — resolvido com backward-compat).**
  Novo helper DB-first (`agents WHERE type='account_assistant' AND status='active'`, cache
  5min) com fallback env (`hub-resolver.ts:40-120`). 11 pontos migrados (admin routes,
  `reminder-runner`, `whatsapp-delivery:124,169`, `followup`, synthetic-test). A env
  `ASSISTANT_HUB_LOCATION_ID` caiu de **21 → 14 refs** e virou **fallback explícito**
  (`getEnvHubLocationId()`), não mais load-bearing. Comportamento idêntico com 1 hub.
- **Camada de repositório (B1 §3 violação 1 — PARCIAL, honesto).**
  `src/lib/repositories/` com **4 repos / 40 funções** (`sparkbot-messages` 9,
  `rep-identities` 13, `agents` 9, `usage-records` 9), barrel único, `createAdminClient()`
  encapsulado dentro de cada repo. Call sites **seguros** migrados (`identity.ts`,
  `onboarding.ts`, `reminder-runner`, `followup-completion-notifier`). **Idempotência do
  `webhook-handler` PRESERVADA** — 1.052 LOC intactos, 5 `createAdminClient` crus de
  propósito, 25 markers de dedup (`inFlightMessages`/`sparkbot_dedup_locks`/`23505`)
  presentes; o repo `rep-identities.repo.ts:7-13` documenta por escrito o que **NÃO** migrar.

Mais: **colisões de nome RESOLVIDAS** (`queue/processor.ts`→`queue-processor.ts`,
`ai/prompt-builder.ts`→`sales-prompt-builder.ts`; sobra 1 `processor.ts` e 1
`prompt-builder.ts`) e **drift de `confirmation_mode` resolvido** (migration `00069`,
DB default → `high_only`, sem alterar rows existentes).

### Validação independente

- `tsc --noEmit` → **0 erros** (renames + 497 LOC de operations não quebraram imports).
- Golden suite: coherence-gate **14/14**, silence-gate **10/10**, sanitizer **19/19**,
  opportunity-routing **6/6**, scope-errors **19/19** — **comportamento preservado**.

### Veredito

| Eixo | Original (B1/B3) | Pós-V2 (RV2) | **Pós-V2.1 (RV4)** | Δ vs V2 |
|------|:---:|:---:|:---:|:---:|
| **ARQUITETURA** | 6,5 | 7,0 | **7,8** | **+0,8** |
| **ORGANIZAÇÃO** | 5,5 | 6,5 | **7,3** | **+0,8** |

**Por que ARQUITETURA sobe +0,8 (e não mais):** dos 3 problemas estruturais pesados que a
RV2 deixou abertos, a V2.1 **fechou 1 inteiro** (fronteira GHL #3 — verbo cru = 0), **fechou
em substância o multi-tenant #4** (resolver DB-first, env só fallback) e **iniciou de forma
sólida e segura o #1** (repos existem, encapsulam, com guard escrito do que não tocar). Não
chega a 8,0+ porque a maior dívida por LOC — **decompor `webhook-handler.ts` (1.052) +
migrar o resto dos ~103 `createAdminClient` de `account-assistant/` para os repos** — segue
aberta e o loop LLM continua duplicado. Mas o movimento foi **estrutural e verificado**, não
intenção: +0,8 reflete fronteiras realmente fechadas.

**Por que ORGANIZAÇÃO sobe +0,8:** colisões de nome (item recorrente desde o B3) **eliminadas**,
drift de config **resolvido com migration documentada**, e um `repositories/` limpo e
barrel-izado melhora muito o "cada coisa no seu lugar". Não sobe mais porque os arquivos
gigantes seguem (`prompt-builder.ts` ~1.181, `webhook-handler.ts` 1.052, `calendar.ts`
~1.363 — embora calendar tenha encolhido com a migração p/ operations) e a adoção dos repos
ainda é minoria dos call sites.

---

## 2. RESOLVIDO NA V2.1 / AINDA ABERTO

| Tema | Baseline / RV2 | Estado pós-V2.1 | Veredito |
|------|----------------|-----------------|----------|
| **Fronteira GHL vazada (B1 §3 #3)** | 42→43 verbos crus `ctx.ghlClient.*` em 8 tool files | **0 verbos crus** (`grep` verbo HTTP = vazio); 47 primitivas em `operations.ts`; tools passam client como arg | ✅ **Resolvido** |
| **Colisões de nome (B1 P2)** | 2× `processor.ts`, 2× `prompt-builder.ts` | `queue-processor.ts` + `sales-prompt-builder.ts`; sobra 1 de cada | ✅ **Resolvido** |
| **`confirmation_mode` drift** | DB default `medium_and_high` × código `high_only` | Migration `00069` → DB default `high_only` (não toca rows) | ✅ **Resolvido** |
| **Multi-tenant inconsistente (B1 §6 #4)** | `ASSISTANT_HUB_LOCATION_ID` load-bearing, 21 refs | `hub-resolver.ts` DB-first + fallback; 11 pontos migrados; env 21→**14** refs, vira fallback | ✅ **Resolvido em substância** (env ainda existe como safety net) |
| **Camada de repositório (B1 §3 #1, P0)** | 158× `createAdminClient` crus, 0 repo | `repositories/` 4 repos/40 fn; call sites seguros migrados; idempotência preservada; **resto não migrado** (~103 ainda crus em `account-assistant/`; total subiu 158→191 pelos repos + migração parcial) | 🟡 **Parcial** (fundação sólida + documentada) |
| **`webhook-handler.ts` god-file** | 1.052 LOC, 8 tabelas, dedup+billing+persist+envio | **1.052 LOC intactos** (idempotência preservada de propósito) | ❌ **Diferido V2.2** |
| **Loop LLM duplicado (B1 §5 #5)** | `processor` × `dispatcher` montam o mesmo `runWithTools` | Ainda duplicado (`processor.ts` 4× / `dispatcher.ts` 2× `runWithTools`) | ❌ **Diferido V2.2** |
| **pg_cron URL hardcoded** | `spark-ai-platform.vercel.app` literal | Ainda hardcoded em migrations `00032`/`00041`/`00053` | ❌ **Diferido V2.2** |
| **Arquivos gigantes / file-placement** | `prompt-builder` 1.181, `calendar` 1.363 | `calendar.ts` encolheu (migração operations); demais estáveis; `core/` ainda raso | ⚠️ **Parcial** |

### Apêndice — números medidos (read-only, 2026-05-20)

- Verbo cru `ctx.ghlClient.{get|post|put|delete|patch}` em `account-assistant/`: **0** (era 42–43).
- `ctx.ghlClient` total em `tools/` (agora = client passado a primitiva): **61**.
- Primitivas exportadas em `operations.ts`: **47** (+497 LOC, commit `338d6c8`).
- `repositories/`: 4 repos, **40 funções** exportadas; `createAdminClient` encapsulado (40 calls internos).
- `ASSISTANT_HUB_LOCATION_ID`: **14** refs (era 21), em 6 arquivos — agora fallback.
- `createAdminClient()` total: **191** (era 158; +33 = repos novos + migração parcial). `account-assistant/`: **103**.
- `webhook-handler.ts`: **1.052 LOC** (inalterado, idempotência preservada — 25 markers).
- Renames: `queue/queue-processor.ts` ✅, `ai/sales-prompt-builder.ts` ✅; 1× `processor.ts`, 1× `prompt-builder.ts`.
- Migration nova: `00069_confirmation_mode_default_high_only.sql`.
- `tsc --noEmit`: **0 erros**. Golden suite: coherence **14/14**, silence **10/10**, sanitizer **19/19**, opp-routing **6/6**, scope-errors **19/19**.
- Diffstat V2.1 (`4a917b1..HEAD`): 39 arquivos, **+1.895 / −412**.

---

## 3. GO / NO-GO PARA DEPLOY

### ✅ **GO**

A V2.1 é a refatoração **mais segura de aprovar** das três fases: é majoritariamente
**movimento estrutural sem mudança de comportamento**, e isso está **verificado por máquina**
— `tsc` limpo (a prova de que renames + nova fronteira GHL não quebraram nenhum import) e
**toda a golden suite passa 100%**. A fronteira GHL fechada e os repos com `createAdminClient`
encapsulado **reduzem** a superfície de risco de drift de spec/schema, não aumentam. O
multi-tenant via `hub-resolver` mantém **backward-compat byte-a-byte** no caso de 1 hub
(prod hoje) e o fallback env preserva o safety net. A migration `00069` não altera rows
existentes (só default de inserts futuros) — zero risco retroativo.

**Ressalvas (não bloqueiam, mas registrar):**

1. **`webhook-handler.ts` segue 1.052 LOC e idempotência intacta** — foi a decisão correta
   NÃO mexer agora; a decomposição é V2.2 e exige bateria de teste de dedup multi-provider
   própria antes de tocar.
2. **Repos com adoção minoritária** — bom como fundação, mas o ganho de blindagem só se
   realiza quando o resto dos ~103 call sites migrar. Sem urgência de deploy.
3. **pg_cron URL hardcoded** persiste — risco operacional **só** se subir staging/fork (aponta
   pra prod). Para o deploy de prod atual, inerte.

**Recomendação:** **deploy liberado.** Validar pós-deploy o caminho do `hub-resolver` em prod
(confirmar que `resolvePrimaryHub()` retorna o mesmo location da env antiga) e seguir o plano
V2.2 documentado para a dívida remanescente.
