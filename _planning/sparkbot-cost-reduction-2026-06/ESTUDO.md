# ESTUDO — Redução de tokens/custo sem perder qualidade (SparkBot + agentes lead-facing)

> Pedro 2026-06-24. Objetivo: cortar o custo de LLM sem perder qualidade, e habilitar **3 padrões (tiers) por agente** — barato / médio / avançado — inclusive pro SparkBot.
> Base: `BASELINE.md` (custo medido em prod) + pesquisa web (4 frentes) + ultra code-review (4 superfícies, 17 achados com file:line) + cálculo determinístico de custo.
> **Este documento é o ESTUDO. O plano de execução priorizado está em `PLANO.md`.** Nada foi implementado ainda.

---

## 0. Sumário executivo (a resposta em 8 linhas)

1. **O custo do SparkBot é 96% INPUT, não output.** Output é ~336 tok/turno (irrelevante). O dinheiro está em ~177K tokens de input por turno e em **como** esse input é cacheado.
2. **O maior vazamento não é o tamanho do prompt — é cache mal-aproveitado.** Três invalidadores silenciosos (confirmados no código com file:line) transformam `cache-read` (0.1×) em `cache-write` (1.25×). Cada turno mal-cacheado **desperdiça ~$0.076** (55% do custo do turno). O resumo matinal proativo paga **4,6× a mais** (cache=0).
3. **Consertar o cache é o maior lever e tem risco ~zero** — é reposicionar texto (mesmas strings, outra posição), não reescrever regra.
4. **O prefixo é gordo de propósito**: 108 tools (~21K tok) carregadas todo turno + seções (BULK V2, follow-up, scheduling admin) sempre presentes apesar de uso raríssimo. Dá pra cortar ~10-12K tok com **subset FIXO por tier** (nunca por turno — senão fragmenta o cache).
5. **O SparkBot lê 30 turnos CRUS sem comprimir** (os agentes sales/recruit já comprimem acima de 25). Falta também **memória de contatos recentes** — isso reduz tokens E alucinação de `contact_id` ao mesmo tempo.
6. **Os 3 tiers já estão 90% prontos na infra** (`agent_configs.ai_model` lido por turno = modelo já fixo-por-conversa). Falta enum validado + UI + allowlist de tools por tier. Haiku é **3× mais barato** que Sonnet, Opus **5×** mais caro — tudo no mesmo token.
7. **Roteamento certo = por-CONVERSA, não por-turno.** Trocar de modelo no meio invalida o cache inteiro. Classificar a complexidade uma vez e fixar o tier.
8. **Estimativa conservadora: dos ~$280/mês do SparkBot, dá pra cortar $120-180/mês com qualidade preservada** (cada fix atrás de flag + validação de 1 conversa real, padrão da casa).

---

## 1. Anatomia do custo (medido em prod, 30 dias)

| Origem | Modelo | Custo/mês | tokens/turno | cache | Observação |
|---|---|---|---|---|---|
| **SparkBot** `account_assistant_turn` | Sonnet 4.6 | **$280** (81%) | 172K | 84% | **o alvo** |
| Lead-facing `ai_processing` | Sonnet 4.6 | $33 | 12K | ~8% | já enxuto — baixa prioridade |
| Proativo `Pós-reunião` | Haiku 4.5 | $9.6 | 37K | ~2% | prefixo não cacheado |
| Proativo `Resumo matinal` | Sonnet 4.6 | $9.1 | 36K | **0% (quebrado)** | cache=0 confirmado |
| Fallback gpt-4.1 | gpt-4.1 | $8.7 | 104K | — | ~6% dos turnos, cold + compliance pior |
| `follow_up` / áudio / resto | vários | ~$4 | — | — | cauda |
| **TOTAL** | | **~$345** (charged ~$380) | | | |

**Economia por turno do SparkBot (Sonnet 4.6, hoje):** ~177K input (148K cache-read + 29K full) + 336 output = **$0.138/turno** (bate com o medido).
- `29.413 × $3/M = $0.088` (input full) + `148.049 × $0.30/M = $0.044` (cache-read) + `336 × $15/M = $0.005` (output).
- **96% do custo é input.** Otimizar = encolher o input efetivo cobrado por turno.

**De onde vêm os 177K:** system prompt ~22K tok + 108 tool defs ~21K tok + histórico de 30 turnos crus (transcrições de áudio + dumps de busca) que pode passar de 100K. O cache pega 84% (o prefixo estável), mas o delta não-cacheado (~29K/turno) + os turnos em que o prefixo é re-escrito somam o grosso.

---

## 2. As 3 classes de causa-raiz (confirmadas no código)

O ultra code-review (4 agentes lendo o código real) confirmou que o custo **não está no conteúdo** — está em **input mal-cacheado**. Três classes, em ordem de impacto:

### Classe 1 — Invalidadores de cache silenciosos (MAIOR lever, risco ~zero)
O bloco com `cache_control: ephemeral` cobre o prefixo `system → tools` até o marker (`llm-client.ts:401,410`). Tudo que muda **dentro** desse prefixo a cada turno força reescrever ~22K (system) + ~21K (tools) como **cache-WRITE** em vez de READ:

- **`conversationalLayer` no FIM do system** (`prompt-builder.ts:872-879`): `turnContextBlock`, `repStyleHint`, `smartDefaults`, `silenceRecovery`, `verbosity` mudam quase todo turno e estão concatenados **depois** do conteúdo estável, com o marker no fim → o prefixo de 22K vira write na maioria dos turnos.
- **Proativo (resumo matinal) cache=0** (`dispatcher.ts:410-443`): o suffix `# MODO PROATIVO` + `rule.prompt_instruction` (que pro briefing embute `JSON.stringify` dos dados do dia) é concatenado **dentro do systemPrompt**, depois do prompt base → prefixo distinto por regra/dia, nunca casa com o cache do inbound. O comentário em `daily-briefing.ts:6` "mantém cache alto" é **falso na prática**.
- **Histórico fora do prefixo cacheado** (`llm-client.ts:405-416`): os 30 turnos crus vêm em `messages`, depois do último marker → nunca cacheiam, e o tool-loop reprocessa o array a cada iteração. **Só 2 dos 4 breakpoints da Anthropic são usados** — sobram 2.

> **Custo do problema (determinístico):** turno com o prefixo de 22K virando write = **$0.146** vs **$0.070** bem-cacheado → **$0.076 desperdiçados/turno** (55%). Briefing cache=0 = **$0.114** vs **$0.025** cacheado → **$0.089 desperdiçados/disparo** (4,6×).

### Classe 2 — Prefixo gordo (tools + system carregam cauda-longa sempre)
- **Tools:** inbound chama `getAllToolDefinitions()` todo turno (`processor.ts:684`) = **108 defs ~21K tok** (o comentário diz "88" — stale). O subset quente real (~20-25 tools que cobrem ~todo o uso de 30d: `search_contacts` 630, `present_options` 173, calendar core, notes/tasks/tags, messages send/schedule) pesa **~6K**. As outras ~85 (bulk×4, filter-engine, tabular, identity-admin) pesam **~15K** e têm **1-6 usos/mês**.
- **System:** `BULK MESSAGES V2` (~2.9K, a MAIOR seção, sempre presente), Filter Engine avançada (~1.3K), `FOLLOW-UP H33` (~543), scheduling override/admin/meeting-location (~1.5-2K, só relevante p/ admin/conflito), e ~400-600 tok de duplicação narrativa (o "caso Gustavo" repetido em 3 blocos anti-alucinação).
- A infra de subset **já existe** (`getToolDefinitions(allowedNames)` + `agent_configs.disabled_tools`) e o gating condicional no prompt **já é padrão** (task-orchestrator/guided/interactive são `...(flag ? [...] : [])`).
- **Regra de ouro:** subset **FIXO por (template, tier)** — nunca por turno. Seleção dinâmica por turno fragmenta o cache e anula o ganho.

### Classe 3 — Histórico cru sem compressão + sem memória (assimetria com sales/recruit)
- SparkBot lê 30 turnos crus de `sparkbot_messages` SEM comprimir. Confirmado: `compressHistory`/`conversation_state`/`cachedSummary` **não existem** em `account-assistant/` (grep vazio) — só no pipeline sales (`queue-processor.ts:1013`, threshold 25/keep 12, gpt-4.1-nano fail-open).
- Transcrições de áudio entram **inteiras** (`webhook-handler.ts:785`) sem o cap de 500 que o resto tem (`:788`) → voice de 2min = 1500+ chars crus em todo turno seguinte.
- `buildMemorySection` **não guarda contatos recentes** → força parte dos 630 `search_contacts`/mês e reenvia dumps crus no histórico. É o anti-padrão "hardcoded contact_id" na origem.
- **Pré-requisito:** comprimir sem summary-cache regenera todo turno e o ganho evapora. Precisa persistir o summary (coluna em `rep_identities` ou tabela leve `sparkbot_conversation_state`).

---

## 3. Pesquisa web — 4 frentes com evidência

### Frente A — Compressão de contexto (ataca os 177K)
| Técnica | Impacto medido | Fonte |
|---|---|---|
| **Tool Search / `defer_loading`** | 72K → 8.7K tok no bloco de tools (**85% ↓**) **e acurácia SOBE** (menos decision paralysis) | Anthropic "Advanced tool use" |
| **Context editing** (`clear_tool_uses`) | pico −48% a −67% limpando tool-results antigos re-buscáveis | Anthropic context-editing docs/cookbook |
| **Compaction** (sumarizar histórico) | resumo de 2.783 tok substituiu conversa de 165K (**98% ↓** no bulk) | Anthropic cookbook context-engineering |
| **Programmatic tool calling** | 43.588 → 27.297 tok (37% ↓) filtrando resultados grandes antes do contexto | Anthropic "Advanced tool use" |
| **Minificação de schema / system** | ~40% por tool só tirando whitespace/campos; TOON 30-60% < JSON | MCP SEP-1576, ByteDoodle/Intuz |
| **LLMLingua-2** | até 20× compressão com −1.5pt; conversa 3-9× | Microsoft Research / arXiv |

**Aplicável a nós (ranqueado):** #1 Tool Search/subsetting nas 108 tools (maior ROI, acurácia sobe). #2 Compaction/summarization do histórico. #3 Minificação de descriptions verbosas.

### Frente B — Roteamento multi-modelo (os 3 tiers)
| Técnica | Impacto | Fonte |
|---|---|---|
| **Roteamento por-CONVERSA com classifier** | RouteLLM: **95% da qualidade do GPT-4 com 14-26% das chamadas ao modelo forte** (48% economia) | RouteLLM arXiv 2406.18665 / LMSYS |
| **Classifier barato (TF-IDF/DeBERTa) antes da chamada cara** | DeBERTa-small: **~41% economia E melhora de qualidade**; TF-IDF+logreg >95% acc em ms, custo ~zero | markaicode / HuggingFace |
| **Subagentes Haiku p/ subtarefas** | corte de **60-80%** em multi-agente (Haiku executa, Sonnet raciocina) | aiforanything/codewithseb |
| **Cascata por confiança (FrugalGPT)** | até **98% economia** igualando o melhor LLM — **só p/ tarefas de 1 passo, NÃO chat** | FrugalGPT arXiv 2305.05176 |
| **3 tiers FIXOS por conversa** | Haiku read $0.10 vs Sonnet $0.30 vs Opus $0.50/MTok; conversa simples 100% em Haiku = 3× mais barato | Anthropic caching docs |

**Gotcha central (confirmado):** "model switch invalidated [tools, system, messages cache]". Por isso o tier é fixo **por-conversa**, decidido no 1º turno, nunca trocado mid-thread.

### Frente C — Memória (curto + longo prazo, anti-alucinação)
| Técnica | Impacto | Fonte |
|---|---|---|
| **Perfil persistente via fact-extraction** | Mem0: **>90% economia de token**, média <7K tok/chamada vs 25K+, +26% qualidade vs memória do OpenAI | Mem0 arXiv 2504.19413 (ECAI 2025) |
| **Anthropic Memory Tool (`/memories`)** | **84% redução** em workflows estendidos (não recarrega o que já sabe) | Anthropic memory-tool docs |
| **Summarization-buffer híbrido** | buffer cresce O(n); summary cresce sublinear → economia aumenta com a duração | Pinecone/LangChain; Anthropic context-eng |
| **Taxonomia (episódica/semântica/procedural)** | escala custo por tier sem refazer arquitetura (tier barato corta o episódico caro) | Atlan / Letta |
| **MemGPT/Letta (paging)** | contexto "ilimitado" mantendo input/turno baixo e estável (just-in-time) | MemGPT research |

**Aplicável a nós:** #1 summarization-buffer no SparkBot (reusar `compressHistory` do sales). #2 perfil de contatos recentes em `buildMemorySection` (reduz tokens E alucinação de ID). #3 (futuro) Memory Tool nativo p/ a orquestração de workflows grandes.

### Frente D — Prompt caching (a fundo)
- **Cache-read = 0.1× do input** (Sonnet $0.30 vs $3/MTok). Com 177K e 84% hit, ~147K já vêm a 0.1× — mas os invalidadores derrubam isso.
- **Invalidadores silenciosos:** timestamp/uuid/JSON não-ordenado/tool-set variável **antes do último breakpoint** → "Cache hits require 100% identical prompt segments". Cada um vira write 1.25×/2×.
- **TTL 1h (write 2×) vs 5min (write 1.25×):** re-write de 177K custa ~10× vs read. Evitar 1 re-write por retorno-de-idle paga o premium 1h muitas vezes. **Break-even baixo** p/ reps com gaps de 5-60min.
- **4 breakpoints, lookback 20 blocos:** sem breakpoint extra, conversas >20 blocos começam a dar miss no prefixo grande.
- **Pre-warming (`max_tokens:0`):** refresca a 0.1× em vez de esfriar e pagar write 10×, sincronizável ao cron de 30s.
- **OpenAI (fallback):** caching automático, mas cold ao trocar de provider — não reaproveita o cache Anthropic.

**Já temos 84% hit. O que falta pra ~95%:** caçar os invalidadores (Classe 1) + 3º/4º breakpoint + TTL 1h pros idle.

---

## 4. Benchmark de modelos — qualidade × custo × latência

### 4.1 Custo (determinístico — preço × tokens, exato)
| Cenário | Haiku 4.5 | Sonnet 4.6 | Opus 4.8 | GPT-4.1 |
|---|---|---|---|---|
| **Turno simples** (~30K in cacheado, 200 out) | **$0.0067** | $0.0201 | $0.0335 | $0.0211 |
| **Turno pesado** SparkBot hoje (29K full + 148K read, 336 out) | $0.0459 | **$0.1377** | $0.2295 | — |
| Ratio no mesmo token | **1×** | 3× | 5× | ~3× |

→ **Haiku é exatamente 3× mais barato que Sonnet e 5× que Opus.** Num turno simples bem-cacheado, Haiku custa **$0.0067**. Essa é a base econômica dos 3 tiers.

### 4.2 Qualidade (benchmarks publicados — eixo que decide o tier)
- **RouteLLM:** 95% da qualidade do modelo forte roteando 14-26% ao forte → a maioria das conversas **não precisa** do tier caro.
- **Anthropic evals (Haiku 4.5):** forte em execução/extração; **degrada** em raciocínio multi-passo com gates (confirmation-gate, identity, agendamento override) — exatamente o atrito #1 do SparkBot (falsas confirmações). → **Haiku como default é arriscado; Haiku só onde o trabalho é simples e o gate é leve.**
- **Sonnet 4.6:** o ponto de equilíbrio atual — mantém compliance dos gates. **Continua o default.**
- **Opus 4.8:** ganho marginal de qualidade a 1.67× o custo do Sonnet — **opt-in** p/ contas premium/casos difíceis.

### 4.3 Benchmark empírico SparkBot-específico — 👤 pendente
- Script pronto: `scripts/bench-models-cost.ts` (6 tarefas reais × 6 modelos, juiz Sonnet, mede qualidade 1-5 + tokens + custo + latência).
- **Bloqueado localmente:** `ANTHROPIC_API_KEY` é **Sensitive na Vercel** (puxa vazio via `env pull`, por design). Não dá pra rodar sem colar o secret — o que **não** fazemos (entrar com API key é proibido; secret não vai no chat).
- **Como rodar (👤 Pedro):** adicionar `ANTHROPIC_API_KEY=...` no `.env.local` local (1 linha, fica na máquina) e `npx tsx scripts/bench-models-cost.ts`. O script já lê `/tmp/spark-bench.env` se existir (override), então também funciona com `vercel env pull` se a key não estiver marcada Sensitive.
- **Por que não bloqueia o plano:** o eixo **custo** é matemática exata (acima) e o eixo **qualidade** está coberto pelos benchmarks publicados + nosso atrito-#1 conhecido. O bench empírico só **confirma** o threshold "Haiku é bom o suficiente pra tarefa X" — refina, não muda, a arquitetura.

---

## 5. Arquitetura dos 3 tiers + roteamento (a peça central)

```
Conversa nova/retomada
   │
   ▼
[Resolver TIER — UMA vez por conversa, a partir de agent_configs.ai_model]
   │   (NÃO troca mid-thread → preserva cache)
   ├── barato   → Haiku 4.5  + allowlist 'lite' (~25 tools) + memória mínima
   ├── médio    → Sonnet 4.6 + allowlist 'lite'/'full'      + memória completa   ← DEFAULT
   └── avançado → Opus 4.8   + allowlist 'full'             + memória + tools completas
   │
   ▼
[Mesmo prefixo estável (system+tools) por (template, tier) → cache compartilhado]
   │
   ▼
[runtimeContext / user message = tudo que é volátil (turn-context, dados do dia, histórico)]
```

**Princípios:**
1. **Tier FIXO por conversa.** Decidido no 1º turno (config do agente, ou classifier futuro), nunca trocado no meio. Trocar = cache_creation cheio (~22K+).
2. **Allowlist de tools FIXA por (template, tier).** `lite` = ~25 quentes + `report_missed_capability`; `full` = +bulk/filter/identity-admin. Nunca seleção dinâmica por turno.
3. **Default permanece Sonnet.** Haiku só em agentes/contas explicitamente marcados de baixo valor; Opus opt-in. Mudança de tier só vale a partir da **próxima** conversa.
4. **Infra já existe:** `input.config.ai_model` é lido por-turno de `agent_configs` (`processor.ts:546`, `dispatcher.ts:494`) — como é lido fresh do mesmo config, **já é fixo-por-conversa de fato**. Falta enum validado + UI + a allowlist por tier.
5. **Roteamento automático (Fase futura):** classifier barato (regex → embedding) no Edge decide barato/médio no 1º turno. Custo ~zero, ~41% economia (DeBERTa). Por ora, **tier manual por agente** já entrega o pedido dos "3 padrões".

---

## 6. Memória personalizada por agente (curto + longo prazo)

| Camada | O que é | Onde hoje | O que falta |
|---|---|---|---|
| **Working (curto)** | últimos ~12 turnos crus | `sparkbot_messages` 30 turnos | comprimir os antigos (summarization-buffer) |
| **Episódica** | resumo da conversa | **não existe** no SparkBot | `compressHistory` + summary-cache persistido |
| **Semântica (longo)** | perfil do rep + contatos recentes | `rep_identities.profile` (parcial) | `recent_contacts` (id+nome+stage+quando) no bloco cacheado |
| **Procedural** | preferências (calendário, fuso, nome) | já em `profile.preferences` | ok — manter |

**Anti-alucinação:** a memória de contatos recentes ataca o "hardcoded contact_id" na raiz — o bot vê id+nome+stage no prompt cacheado (marcado "pista, re-valide antes de WRITE") em vez de re-buscar e reenviar dumps crus. **Reduz tokens E alucinação simultaneamente** — alinhado com a regra de re-search que já existe.

**Alinhamento com o que existe:** reusa `compressHistory` (sales, validado em prod), `autoRegisterFromToolResult` (já captura tool-results), `buildMemorySection` (já renderiza o perfil). Nada é construído do zero.

**Futuro (orquestração de workflows grandes — H41):** quando os fluxos multi-mensagem/multi-turno do task-orchestrator escalarem, avaliar o **Anthropic Memory Tool nativo** (`/memories`, 84% redução) como camada archival — fora do escopo deste plano, anotado.

---

## 7. O que NÃO mexer (preservar qualidade)

- A **lista de frases proibidas** e a verificação do anti-alucinação (`prompt-builder.ts:672-684`) — só cortar a duplicação narrativa, nunca a regra.
- O **confirmation-gate (H8)** e os fixes de agendamento (Manuela/Erika/override) — são regras caras de reaprender; tier Haiku e enxugamento do módulo scheduling exigem **eval supervisionado**.
- `present_options` (2ª tool mais usada) — fica no tier `lite`.
- Os **claims atômicos** dos runners (cron guards) — não confundir cache com idempotência.

---

## 8. Conclusão do estudo

O custo do SparkBot é um problema de **engenharia de cache e de contexto**, não de "prompt grande demais". A maior economia (Classe 1) é quase de graça e quase sem risco. As Classes 2 e 3 e os 3 tiers vêm depois, atrás de flag + validação. A meta de **$280 → ~$120-150/mês** é conservadora e atingível **sem degradar a experiência** se a sequência for respeitada (cache-fixes ANTES de tiers) e cada passo validado com 1 conversa real.

→ **Execução priorizada em `PLANO.md`.**
