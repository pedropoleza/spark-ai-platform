# B3 — Organização & Limpeza

> Auditoria read-only. Nenhum código foi alterado.
> Repo: `/Users/pedropoleza/SPARK APPS/AI platform`
> Data: 2026-05-19

---

## 1. RESUMO EXECUTIVO

**Nota de organização/limpeza: 5,5/10**

O codebase é **funcionalmente coeso por módulo** (cada subpasta tem propósito claro) mas sofre de três problemas estruturais sérios que aumentam o risco de regressão: arquivos excessivamente grandes com múltiplas responsabilidades, duplicação real no cluster bulk, e violações residuais da regra Spark Leads ≠ GHL no system prompt — algumas instruindo o LLM a dizer "GHL" ao rep explicitamente.

**5 itens de maior impacto (ordem de urgência):**

1. **Violação Spark Leads≠GHL em `prompt-builder.ts:205`** — instrui LLM a dizer "GHL Smart Lists" ao rep explicitamente. Afeta todos os 37 reps em prod hoje.
2. **`bulk-messages.ts` (V1, 1.429 LOC) contém ~544 LOC de funções helper** compartilhadas com V2 e bulk-management. O arquivo é ao mesmo tempo uma biblioteca interna e um conjunto de tools deprecated — mistura que dificulta entender o que pode ser removido.
3. **`prompt-builder.ts` (1.153 LOC) é um monolito de system prompt** — 808 LOC em uma única função (`buildSparkbotSystemPrompt`). Cada seção nova de instrução engrossa esse arquivo; hoje tem 26 seções distintas.
4. **`calendar.ts` (1.363 LOC) tem 9 tools + helpers cross-calendar** — o `list_my_free_slots` (~450 LOC) é quase um módulo autônomo embutido.
5. **87 tools no registry** (index.ts diz "45" no header, mas contagem real é 87) — header desatualizado; 5 tools confirmadas com 0 calls no período do review (dead no LLM, mas registradas e incluídas no schema enviado ao modelo).

---

## 2. ARQUIVOS GIGANTES

| Arquivo | LOC | Responsabilidades | Como quebrar | Esforço |
|---------|-----|-------------------|--------------|---------|
| `tools/bulk-messages.ts` | 1.429 | (1) Helpers compartilhados (cap, schedule, variator) — ~544 LOC; (2) tools V1 deprecated (preview/schedule) — ~160 LOC; (3) tools de job management individual (list/pause/resume/cancel/progress) — ~610 LOC | Extrair helpers para `tools/bulk-shared.ts`; mover job management tools para `bulk-management.ts` (que já importa esses helpers); deixar V1 só como arquivo de compat com 2 tools deprecated | M |
| `tools/calendar.ts` | 1.363 | (1) Tools read (list_appointments, list_calendars, get_free_slots, get_appointment) — ~370 LOC; (2) `list_my_free_slots` cross-calendar complexo — ~480 LOC; (3) Tools write (create/update/delete/block) — ~510 LOC | Extrair `calendar-read.ts` + `calendar-slots.ts` + `calendar-write.ts`; helpers (`buildOverridePayload`, `computeWindowInTz`) em `calendar-helpers.ts` | M |
| `prompt-builder.ts` | 1.153 | (1) `buildSparkbotSystemPrompt` — 808 LOC com 26 seções de instrução; (2) helpers de seções (tones, KB, custom instructions, memory) — ~200 LOC; (3) `buildSparkbotRuntimeContext` — 53 LOC | Extrair cada grupo temático em função: `buildFilterEngineSection`, `buildBulkSection`, `buildCalendarSection`, `buildTasksSection`, `buildSafetySection` etc. — reduziria a função principal para ~200 LOC de joins | L |
| `tools/bulk-messages-v2.ts` | 1.145 | (1) `preview_bulk_message_v2` handler — ~300 LOC; (2) `schedule_bulk_message_v2` handler — ~400 LOC; (3) Tipos/interfaces inline (CoexistenceRecommendation, etc.) — ~100 LOC; (4) lógica de segment processing duplicada entre preview e schedule | Extrair segment processor compartilhado; mover tipos para `bulk-types.ts` | M |
| `tools/bulk-management.ts` | 1.058 | 7 tools de management + helpers de formatação de datas ET | Extrair helpers de formatação (formatDateTimeET, formatDateET, formatDuration) para `bulk-summary-formatter.ts` (já existe!) | S |
| `webhook-handler.ts` | 1.052 | (1) Dedup/mutex (layers 1-7) — ~80 LOC; (2) Extração de RepInput (áudio, imagem, tabular, text) — ~140 LOC; (3) Orchestração principal do turn — ~600 LOC; (4) Splitting/envio de resposta — ~90 LOC | Extrair `extractRepInput` (já existe como função privada, linha 828) para `input-parser.ts`; extrair dedup layer para `dedup-guard.ts` | M |
| `processor.ts` | 939 | (1) Detector de alucinação (`detectHallucination`) — ~60 LOC; (2) Validação isWriteTool/isNegated — ~60 LOC; (3) Orchestração LLM loop + tool execution — ~450 LOC; (4) Onboarding path — ~80 LOC | Extrair `detectHallucination` para `conversational/hallucination-detector.ts`; extrair onboarding path para módulo próprio | M |

---

## 3. DUPLICAÇÃO BULK V1/V2/MANAGEMENT

### O que existe

| Arquivo | LOC | Tools expostas ao LLM | Status |
|---------|-----|-----------------------|--------|
| `tools/bulk-messages.ts` (V1) | 1.429 | `preview_bulk_message` ⚠️DEPRECATED, `schedule_bulk_message` ⚠️DEPRECATED, `list_bulk_jobs`, `get_bulk_job_progress`, `pause_bulk_job`, `resume_bulk_job`, `cancel_bulk_job` (7 tools) | Parcialmente ativo |
| `tools/bulk-messages-v2.ts` (V2) | 1.145 | `preview_bulk_message_v2`, `schedule_bulk_message_v2` (2 tools) | Ativo, preferencial |
| `tools/bulk-management.ts` | 1.058 | `bulk_dashboard`, `bulk_pause_all`, `bulk_resume_all`, `bulk_cancel_all`, `bulk_reschedule_job`, `bulk_edit_pending_job`, `bulk_request_cap_override` (7 tools) | Ativo, adicionado H32 |
| **Total** | **3.632 LOC** | **16 tools** | — |

### Duplicação real

**Helpers compartilhados (não-duplicados, mas mal posicionados):** V2 e bulk-management IMPORTAM diretamente de V1 (`bulk-messages.ts`): `countRecipientsLast24h`, `getDailyCap`, `getEffectiveDailyCap`, `getActiveBulkJobs`, `resolveAgentId`, `toEtDayString`, `findSimilarActiveJobs`, `adjustStartAtForQuietHours`, `computeScheduledAts`. Isso faz V1 ser uma biblioteca disfarçada de tool file — é uma fonte de acoplamento frágil.

**Overlap semântico de tools:**
- `list_bulk_jobs` (V1, simples) vs `bulk_dashboard` (management, completo): coexistem com propósitos distintos — list é simples, dashboard inclui ETA + cap + health.
- `pause_bulk_job` / `resume_bulk_job` / `cancel_bulk_job` (V1, individual por job) vs `bulk_pause_all` / `bulk_resume_all` / `bulk_cancel_all` (management, bulk ops): a overlap SEMÂNTICA gera confusão no LLM sobre qual usar quando rep pede pausar UM job vs todos.

**V1 tools marcadas como DEPRECATED:** `preview_bulk_message:655` e `schedule_bulk_message:779` têm `⚠️ DEPRECATED` no description. Apesar disso continuam registradas em `index.ts:49` e são incluídas no schema enviado ao LLM. O LLM recebe 16 tools de bulk quando precisaria de ~9 (V2 + management - individual ops duplicadas).

### Recomendação de consolidação

1. **Imediato (S):** Mover helpers compartilhados de `bulk-messages.ts` para `tools/bulk-shared.ts`. Nenhuma quebra de comportamento — só reorganização de imports.
2. **Curto prazo (M):** Remover `preview_bulk_message` e `schedule_bulk_message` (V1 deprecated) do TOOL_REGISTRY. Manter o arquivo para os helpers ainda necessários.
3. **Médio prazo (M):** Avaliar se `list_bulk_jobs`, `pause_bulk_job`, `resume_bulk_job`, `cancel_bulk_job` ainda são necessários ao lado das management tools — se não, remover.

---

## 4. DEAD CODE

### Tools com 0 chamadas no período (Fase 1, confirmadas aqui)

| Tool | Arquivo:linha | Status no registry | Por que 0 calls | Veredito |
|------|---------------|--------------------|-----------------|---------|
| `recap_session` | `tools/recap.ts:16` | ✅ Registrada | Sistema prompt instrui LLM a acionar em `prompt-builder.ts:798` ("Quando rep falar 'recap'") mas nenhum rep usou esse comando | Não é dead code — é feature com baixo descobrimento |
| `set_daily_briefing` | `tools/identity.ts:354` | ✅ Registrada | Referenciada em `prompt-builder.ts:801` mas daily briefing cron não está implementado (`CLAUDE.md` diz "stub disabled 2026-05-05") | Dead feature: cron stub. Tool existe mas o trigger pro rep usá-la não chega |
| `set_verbosity_preference` | `tools/identity.ts:615` | ✅ Registrada | `prompt-builder.ts:801` instrui LLM; mas reps não descobrem o comando | Válida, apenas não descoberta |
| `complete_task` | `tools/tasks.ts:181` | ✅ Registrada | Aparece em `proactive/system-rules.ts:114,123` (regras disabled 2026-05-05) e `prompt-builder.ts` | Depende de regras proativas desativadas |
| `update_task` | `tools/tasks.ts:124` | ✅ Registrada | `proactive/system-rules.ts:122,123` (disabled) e `prompt-builder.ts:365,122` | Idem acima |

**Conclusão:** Nenhuma das 5 tools é dead code em sentido estrito (código inacessível). São **features sem trigger ativo**: ou dependem de regras proativas desativadas (`complete_task`, `update_task`, `set_daily_briefing`) ou de comportamentos que os reps simplesmente não exercitaram no período. A Fase 1 identificou 27 tools com 0 calls — a causa provável para as demais 22 é descriptions fracas (LLM não associa intenção do rep ao nome da tool) ou features genuinamente novas (follow-up tools do H33, adicionadas em 2026-05-18, 2 dias antes do fim do período).

### Tools V1 deprecated (que deveriam ser dead)

`preview_bulk_message` e `schedule_bulk_message` têm `⚠️ DEPRECATED` no description mas continuam no registry e são enviadas ao LLM. São **pseudo-dead**: o LLM é instruído a preferir V2, mas a V1 ainda existe como rota de fallback ativa.

### Blocos comentados

Nenhum bloco de código comentado relevante encontrado no módulo `account-assistant`. Há 1 TODO em `outbound-channel.ts:48` (`// TODO(future): when WhatsApp API liberado`) — legítimo, não é dead code.

### Header desatualizado

`tools/index.ts:5` diz "45 tools no total" mas a contagem real é **87 tools** registradas em `ALL_ENTRIES`.

---

## 5. VIOLAÇÕES "SPARK LEADS ≠ GHL"

### ❌ Violações confirmadas — strings LLM-facing

Estas strings são enviadas ao modelo Claude como parte do system prompt ou tool schema. O LLM pode repeti-las ao rep diretamente.

#### System prompt (`prompt-builder.ts`) — 9 ocorrências

| Arquivo:linha | Texto (trecho) | Risco de parrot ao rep |
|---------------|----------------|------------------------|
| `prompt-builder.ts:200` | `"(GHL /opportunities/search não aceita filter por CF)"` | Baixo — instrução técnica |
| `prompt-builder.ts:202` | `"GHL não suporta server-side → engine faz client-side fallback"` | Baixo — instrução técnica |
| `prompt-builder.ts:205` | `"avise rep que pode haver discrepância vs total GHL Smart Lists (Smart Lists do GHL normaliza FL↔Florida)"` | **ALTO** — instrui explicitamente o LLM a dizer "GHL Smart Lists" ao rep |
| `prompt-builder.ts:369` | `"GHL aceita dueDate futuro nativamente"` | Baixo — meta-instrução |
| `prompt-builder.ts:370` | `"task EXIGE contact_id no GHL"` | **MÉDIO** — bot pode parrotar em mensagem de erro |
| `prompt-builder.ts:559` | `"confia no GHL pra agregar regras desse calendar"` | Baixo — meta-instrução |
| `prompt-builder.ts:587` | `"omite meeting_location (GHL gera)"` | **MÉDIO** — bot pode incluir ao confirmar agendamento |
| `prompt-builder.ts:588` | `"meeting_location_type='zoom', omite meeting_location (GHL gera)"` | **MÉDIO** — idem |
| `prompt-builder.ts:595` | `"GHL gera link automaticamente pra zoom/gmeet"` | **MÉDIO** — idem |

#### Tool descriptions (schema enviado ao LLM) — 7 ocorrências

| Arquivo:linha | Tool afetada | Texto (trecho) |
|---------------|--------------|----------------|
| `tools/tasks.ts:20` | `create_task` description | `"GHL aceita dueDate futuro nativamente"` |
| `tools/filter-tools.ts:293` | `count_filtered` description | `"1 chamada GHL otimizada"` |
| `tools/calendar.ts:910` | `create_appointment` description | `"GHL ignora silenciosamente e usa default do calendar"` |
| `tools/calendar.ts:925` | `create_appointment` param `meeting_location_type` | `"GHL respeita o local que você manda"` |
| `tools/calendar.ts:931` | `create_appointment` param `meeting_location` | `"GHL gera automático"` |
| `tools/calendar.ts:1202` | `update_appointment` description | `"GHL ignora silenciosamente"` |
| `tools/calendar.ts:1226` | `update_appointment` param `meeting_location` | `"GHL gera automático"` |

**Total violações LLM-facing: 16** (9 system prompt + 7 tool descriptions)

### Origem do "no GHL" reportado na Fase 1

O bug original estava em `terms.ts` linha 111 (commit `3514789`, 2026-05-04): o `buildOnboardingMessage` dizia `"cria nota no Pedro Silva: cliente quer Term\" — no GHL"` e os termos de uso diziam `"no GoHighLevel"`. O fix substituiu ambos por "no Spark Leads". Reps que onboardaram entre o deploy inicial (2026-05-04 00:35) e o fix (2026-05-04 11:34) — ou em deploys anteriores — receberam a versão violadora. Os dados da Fase 1 cobrem 1–20 mai, com reps "da cauda" sendo justamente os que fizeram onboarding mais tarde e ainda tinham histórico antigo no DB. **O bug de origem já está corrigido no código atual.** O que resta são as 16 ocorrências LLM-facing do system prompt e tool descriptions, que não fazem parte da mensagem de onboarding mas podem vazar em outras interações.

### ✅ Ocorrências técnicas OK

Total aproximado de ocorrências "GHL" no codebase `src/`: **593**. Destas, ~526 são claramente técnicas: nomes de tipo (`GHLClient`, `GHLUser`, `GHLLocation`, `GHLPipeline`, etc.), nomes de variável/função (`ghl_user_id`, `validateGHLUser`, `useGHLData`), imports (`@/lib/ghl/*`), env vars (`GHL_API_BASE`), comentários de código e blocos JSDoc. Não foram listadas individualmente conforme mandato — apenas contabilizadas.

---

## 6. ESTRUTURA DE PASTAS & FILE PLACEMENT

### Veredito

A estrutura de `src/lib/account-assistant/` é **razoavelmente boa** e facilita mudanças isoladas: tools/ por categoria, proactive/ para cron/dispatcher, filter-engine/ coeso, followup/ separado. O problema não está no naming das pastas, mas em três padrões que emergiram organicamente:

**O que funciona bem:**
- `filter-engine/` (11 arquivos, ~1.200 LOC total) — divisão exemplar: compiler, executor, cache, resolvers, capabilities, audit, interpolator, types, disclaimers, index.
- `conversational/` (10 arquivos) — padrão similar ao filter-engine, cada arquivo com propósito único.
- `followup/` (9 arquivos) — mesma disciplina.
- Path aliases `@/` são usados consistentemente fora do módulo. Imports relativos `../` dentro de account-assistant são todos legítimos (mesmo módulo) e não violam a convenção.

**O que atrapalha:**

| Problema | Localização | Impacto |
|----------|-------------|---------|
| Helpers de bulk espalhados em `bulk-messages.ts` (V1) em vez de módulo compartilhado | `tools/bulk-messages.ts:107–650` | V2 e management dependem de V1 — se V1 for removido, quebra |
| `file-processor.ts` na raiz de `account-assistant/` em vez de `tools/` ou subpasta `media/` | `account-assistant/file-processor.ts` | Não segue o padrão de pastas do módulo |
| `prompt-builder.ts` na raiz em vez de subpasta `prompts/` | `account-assistant/prompt-builder.ts` | Arquivo de 1.153 LOC teria melhor visibilidade em `prompts/system-prompt.ts` + `prompts/runtime-context.ts` |
| `identity.ts` (681 LOC) e `llm-client.ts` na raiz — são infraestrutura, não tools | `account-assistant/identity.ts`, `llm-client.ts` | Poderiam estar em `core/` ou `infra/` |
| `tools/recap.ts` (192 LOC, 1 tool) — muito pequeno vs `bulk-messages.ts` (1.429 LOC) | Inconsistência de granularidade | Não problema crítico |

### Sugestões de reorganização (sem alterar comportamento)

```
account-assistant/
  core/                 # infraestrutura do módulo
    identity.ts         # (movido de raiz)
    llm-client.ts       # (movido de raiz)
    outbound-channel.ts # (movido de raiz)
  prompts/              # system prompt
    system-prompt.ts    # (extraído de prompt-builder.ts)
    runtime-context.ts  # (extraído de prompt-builder.ts)
  media/                # processamento de mídia
    file-processor.ts   # (movido de raiz)
  tools/
    bulk-shared.ts      # NOVO: helpers extraídos de bulk-messages.ts
    [resto igual]
  [conversational/, filter-engine/, followup/, proactive/ — sem mudança]
```

---

## Apêndice: contagem de LOC por subpasta

| Subpasta | Arquivos TS | LOC total |
|----------|-------------|-----------|
| `tools/` | 21 | ~8.700 |
| `proactive/` | 15 | ~3.200 |
| `filter-engine/` | 11 | ~1.200 |
| `followup/` | 9 | ~900 |
| `conversational/` | 10 | ~750 |
| Raiz (`account-assistant/`) | 11 | ~3.500 |
| **Total** | **77** | **~18.250** |
