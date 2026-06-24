# PLANO — Redução de custo do SparkBot + 3 tiers por agente

> Pedro 2026-06-24. Companheiro do `ESTUDO.md`. **Nada implementado ainda — este é o plano pra aprovar antes de começar.**
> Meta: **$280 → ~$120-150/mês** no SparkBot, qualidade preservada. 17 fixes (F1-F17) do ultra code-review, agrupados em 5 fases por ROI.

---

## Princípios (não violar)

1. **Cada fix atrás de flag + validação de 1 conversa real** antes de ligar (padrão da casa). Nenhum fix de comportamento mergeia sem eval supervisionado.
2. **Cache-fixes (Fase 1) ANTES dos tiers (Fase 4).** Sem prefixo estável, NENHUM tier cacheia bem e a economia do tiering some.
3. **Subset de tools FIXO por (template, tier) — nunca por turno.** Seleção dinâmica fragmenta o cache e anula tudo.
4. **Default permanece Sonnet 4.6.** Haiku é opt-in por agente; mudança de tier só vale na próxima conversa (não torrar cache mid-thread).
5. **Migrations sempre em `supabase/migrations/`** mesmo aplicando via MCP. Decision codes nos comments (`H44`?, alinhar com Pedro).
6. **Medir antes e depois.** `usage_records` já tem `cached_tokens`/`cache_creation_tokens` — comparar cache-hit e $/turno por origem antes/depois de cada fase.

---

## Fase 0 — Rede de segurança (medir o baseline real) · risco zero

Antes de tocar em qualquer linha, instrumentar pra provar o ganho (e pegar regressão).

- 🤖 **F0.1** Query de baseline por origem: cache-hit %, $/turno, tokens full vs read, distribuição de **gap inter-turno** (decide se TTL 1h ajuda — F4). Salvar snapshot em `_planning/sparkbot-cost-reduction-2026-06/baseline-snapshot.md`.
- 🤖 **F0.2** Script `scripts/measure-cache-hit.ts` que roda 1 conversa real de teste e reporta cache_creation vs cache_read por turno (replay antes/depois de cada fix).
- 👤 **F0.3** (opcional, refina) Pedro adiciona `ANTHROPIC_API_KEY` no `.env.local` local e roda `scripts/bench-models-cost.ts` → tabela empírica qualidade×custo por modelo. Não bloqueia.

**Critério de saída:** 🤖 snapshot de cache-hit/$ por origem salvo; 🤖 replay reproduzível.

---

## Fase 1 — Cache-fixes (MAIOR ROI, risco ~zero) · "reposicionar, não reescrever"

> ✅ **IMPLEMENTADA 2026-06-24 (DECISIONS H44).** tsc 0 · motor-parity 7/7 · sales-parity 5/5 · proactivity 14/14 · build OK · review adversarial (4 frentes: parity ok byte-a-byte, cache/API ok, edge-cases ok). **Refinamento do review:** F4 (TTL 1h) foi **escopado só pro inbound** (`cacheTtl` threaded por `runSparkbotTurn`) — o proativo é one-shot e o write 2x do 1h seria custo puro nele, então fica 5m. Comments de F2/F3 ajustados pra não superestimar o cache-share (cross-inbound depende de modelo+tools+location → fecha com F8). **Validar pós-deploy 👤:** re-rodar as 2 queries de `baseline-snapshot.md`.

São 4 fixes que transformam cache-write em cache-read. **Mesmas strings, outra posição.** Economia projetada: **30-60% do input em conversas longas + 80-90% nos proativos.**

| # | Fix | Onde | Economia | Esforço/Risco |
|---|---|---|---|---|
| **F1** | Mover `conversationalLayer` (5 blocos voláteis) do fim do system → user message (`buildSparkbotRuntimeContext`) | `prompt-builder.ts:872-879` + `:1134` + `processor.ts:466-489` | ~$0.076/turno afetado (write→read de 22K) | small / low |
| **F2** | Proativo/briefing: tirar suffix de regra + JSON do dia do `systemPrompt` (mover p/ `initialUserMessage` que já existe) | `dispatcher.ts:410-443,478-481` + `daily-briefing-prompt.ts:62-74` | ~$0.089/disparo (cache=0 → cacheado) | small / low |
| **F3** | 3º cache breakpoint no fim do histórico estável (sobram 2 dos 4) | `llm-client.ts:405-416` | 30-60% do input em conversas longas | trivial / none |
| **F4** | TTL 1h no system+tools (em vez de 5min) — **só após F0.1 confirmar gaps 5-60min** | `llm-client.ts:401,410` | corta re-writes de reps idle | trivial / none |

**Sequência:** F1 e F2 primeiro (destravam o prefixo), depois F3 (history), depois F4 (medido). Cada um: flag implícita (é reposicionamento) + replay com `measure-cache-hit.ts` (cache_creation deve cair pra ~0 no prefixo) + 1 conversa real idêntica em comportamento.

**Critério de saída:** 🤖 cache-hit do system sobe pra ~100% nos turnos com turn-context mudando; 🤖 briefing deixa de pagar 36K cheios; 🤖 comportamento byte-idêntico validado em 1 conversa real (interativa) + 1 disparo proativo.

---

## Fase 2 — Prefixo enxuto (subset de tools + seções condicionais) · ROI alto

Cortar ~10-12K tok do prefixo. **Allowlist FIXA por tier** (não por turno). A infra de subset e de gating condicional já existe.

| # | Fix | Onde | Economia | Esforço/Risco |
|---|---|---|---|---|
| **F17** | Corrigir comentário stale "88 tools" (são 108) + teste de drift | `tools/index.ts:4-5` | visibilidade (0 direto) | trivial / none |
| **F7** | `TOOL_TIERS` estáticos: inbound usa allowlist `lite` (~25 quentes) em vez de `getAllToolDefinitions` | `run-sparkbot-turn.ts:118`, `processor.ts:684`, `tools/index.ts:149-173` | ~15K → ~6K tok de tools | medium / med |
| **F13** | Mover bulk/filter/tabular/identity-admin p/ tier `full` (fora do `lite` default) | `tools/index.ts:47-73` + bulk/filter/identity | ~5-6K tok no `lite` | medium / med |
| **F8** | Padronizar `tools_allowed` dos ~12 proativos no MESMO subset `lite` (hoje cada array distinto = prefixo distinto = cache=0) | `proactive/system-rules.ts:36,67,195,210` | destrava cache-read ~22K nos proativos | medium / low |
| **F9** | Gatear seções BULK V2 + Filter avançada + FOLLOW-UP H33 atrás de entitlement/flag (stub de 2-3 linhas + tool on-demand) | `prompt-builder.ts:222-368,171-220,830-865` | ~4.7K tok do prefixo em ~99% dos turnos | medium / med |
| **F12** | Enxugar ~10 descriptions >400 tok (mover exemplos p/ o system, manter gatilho + 1-2 exemplos) | `carrier_kb.ts:73`, `calendar.ts:281`, `identity.ts:298`, `tabular.ts` | ~2-2.5K tok no prefixo de tools | medium / med |

**Sequência:** F17 (visibilidade) → F7 + F13 (definir tiers de tool juntos) → F8 (alinhar proativos ao mesmo allowlist; depende de F2) → F9 → F12. Validar com **log de uso real de 30d** (nenhuma tool quente cai no corte) + replay de tool-routing antes/depois (F12 — descriptions guiam roteamento).

**Critério de saída:** 🤖 prefixo de tools cai de ~21K p/ ~6K no tier `lite`; 🤖 uso real 30d confirma 0 tool quente removida; 🤖 proativos compartilham o prefixo cacheado do inbound; 👤 Pedro valida 1 caso real de bulk/follow-up (que agora carrega sob demanda).

---

## Fase 3 — Compressão de histórico + memória · ROI alto, risco médio (eval)

Ataca a maior fatia NÃO-cacheada. **Pré-requisito: summary-cache persistido** (senão regenera todo turno).

| # | Fix | Onde | Economia | Esforço/Risco |
|---|---|---|---|---|
| **F5** | Wire `compressHistory` + summary-cache no SparkBot (paridade com sales: threshold 25/keep 12, prompt EXIGINDO preservar IDs/nomes/slots/confirmações literais) | `webhook-handler.ts:736-768` + `stevo-handler.ts:384-406`; reusa `history-compressor.ts`; nova migration | 8-15K tok/turno em conversas longas (2-4× num turno multi-tool) | medium / med |
| **F6** | Cap/resumir transcrições de áudio antigas (alinhar `:785` com o cap `:788`; manter íntegra só nos KEEP_RECENT) | `webhook-handler.ts:785` | centenas a poucos K tok em conversas com áudio | trivial / low |
| **F16** | Memória de contatos recentes em `buildMemorySection` (até 5: id+nome+stage+quando, marcado "pista, re-valide") | `prompt-builder.ts:1045-1102` + `processor.ts:400-416` | corta parte dos 630 search/mês + remove dumps crus | medium / med |

**Migration (🤝):** 🤖 Claude escreve o SQL (coluna `history_summary`/`summary_covered_count` em `rep_identities` OU tabela `sparkbot_conversation_state`); 👤 Pedro aplica em prod via MCP. Arquivo em `supabase/migrations/`.

**Sequência:** F5 (com a migration de summary-cache) → F6 (ou deixa o F5 absorver os áudios) → F16. **Eval supervisionado obrigatório** (a compressão não pode perder contact_id/slot/confirmação — as regras anti-alucinação de re-search são a rede). Flag `SPARKBOT_HISTORY_COMPRESSION` (default OFF).

**Critério de saída:** 🤖 conversa longa de teste mantém todos os IDs/nomes/slots após compressão; 🤖 input/turno cai em conversa de 30 turnos; 👤 Pedro valida 1 conversa real com áudio + contato recorrente (bot não re-erra ID nem re-busca à toa).

---

## Fase 4 — 3 tiers + roteamento + fallback · habilita o pedido do Pedro

**Pré-requisito: Fases 1 e 2 aplicadas** (prefixo estável). Só então o tiering cacheia bem.

| # | Fix | Onde | Economia | Esforço/Risco |
|---|---|---|---|---|
| **F14** | Enum validado de tier + UI (Cat de modelo grava `agent_configs.ai_model`) + travar fixo-por-conversa | `processor.ts:546`, `dispatcher.ts:494`, `llm-client.ts:12,166`, `constants.ts:10` | Haiku ~1/3 do preço onde aplicado | medium / high (eval) |
| **F15** | Atacar a CAUSA dos ~6% de gpt-4.1 (credit/rate-limit Anthropic), não o fallback; avaliar `STRICT_CLAUDE_ONLY=1` default | `llm-client.ts:169-289,610-619` + `admin_signals` | elimina os 6% mais caros + mais arriscados | small / med |
| **F10** | (opcional, eval pesado) Parametrizar módulo scheduling: omitir override/admin/anti-bounce p/ rep comum | `modules/scheduling.ts:89-134` + `prompt-builder.ts:646` | ~1.5-2K tok | large / **high** |
| **F11** | (opcional, eval pesado) Consolidar os 3 blocos anti-hallucination num só (cortar só duplicação narrativa) | `prompt-builder.ts:670-684,689-694,726-762` | ~400-600 tok | medium / **high** |

**UI (3 padrões por agente):** na Cat de modelo do `/hub`, seletor **Barato (Haiku) · Médio (Sonnet, recomendado) · Avançado (Opus)** por agente, com aviso "muda a partir da próxima conversa". Grava `agent_configs.ai_model` validado contra `constants.ts:10`. Vale pro SparkBot e pros lead-facing (mesmo campo).

**Sequência:** F14 (tiers + UI) → F15 (fallback). **F10 e F11 são opcionais e de alto risco** — só se o ganho justificar, com eval supervisionado pesado (são regras de receita/qualidade-#1). Recomendo **deixar F10/F11 fora do MVP** e reavaliar depois de medir o ganho das Fases 1-3.

**Parity por tier antes de expor:** rodar o smoke real (`F23`-style) em Haiku e Sonnet pros casos quentes; só liberar Haiku nos casos onde a qualidade se mantém. Default Sonnet intocado.

**Critério de saída:** 🤖 selector de tier grava e o runtime honra (já honra); 🤖 trocar tier não invalida cache mid-conversa; 👤 Pedro escolhe quais reps/contas vão pra Haiku; 🤖 monitor de credit/rate-limit Anthropic ativo (corta o fallback na causa).

---

## Tabela ROI consolidada (ordem de execução)

| Fase | Fixes | Economia projetada | Risco | Bloqueia? |
|---|---|---|---|---|
| **0** | F0.1-F0.3 | — (instrumentação) | zero | — |
| **1** | F1, F2, F3, F4 | **30-60% input (conversas) + 80-90% (proativos)** | ~zero | pré-req da Fase 4 |
| **2** | F17, F7, F13, F8, F9, F12 | ~10-12K tok/turno (~$25-50/mês) | baixo-médio | F8 depende de F2 |
| **3** | F5, F6, F16 | 8-15K tok/turno (conversas longas) + anti-alucinação | médio (eval) | migration 🤝 |
| **4** | F14, F15 (+F10/F11 opt) | Haiku 3× onde aplicado + corta 6% gpt-4.1 | médio-alto (eval) | pré-req Fases 1-2 |

**Estimativa agregada (conservadora):** $280 → **~$120-150/mês** no SparkBot, escalável (a 120 locations isso é a diferença entre ~$1.700 e ~$750/mês). Qualidade preservada se a sequência e a validação forem respeitadas.

---

## Riscos & mitigações

| Risco | Prob | Impacto | Mitigação | Resp |
|---|---|---|---|---|
| Compressão perde contact_id/slot → bot erra | média | alto | prompt EXIGE preservar literais + regra de re-search + eval supervisionado + flag OFF | 🤝 |
| Haiku degrada confirmation-gate (falsa confirmação volta) | média | alto | Haiku opt-in só onde gate é leve; parity por tier antes de expor; default Sonnet | 🤝 |
| Cortar seção do prompt quebra reconhecimento de fluxo (bulk/follow-up) | média | médio | gatear (não remover) + stub + tool on-demand; validar 1 caso real | 🤝 |
| Allowlist de tools por turno (em vez de por tier) fragmenta cache | baixa | alto | **regra de ouro**: subset FIXO por (template, tier); revisão de código | 🤖 |
| F10/F11 (scheduling/anti-alucinação) regridem regra cara | média | alto | **fora do MVP**; só com eval pesado | 🤝 |
| TTL 1h não ajuda (reps respondem <5min) e custa marginalmente mais | baixa | baixo | medir gap inter-turno (F0.1) ANTES de F4 | 🤖 |

---

## O que precisa do Pedro (👤)

1. **Aprovar este plano** e a sequência (Fases 1→2→3→4; F10/F11 fora do MVP).
2. **Decidir o decision-code** (H44?) pra rastrear no `DECISIONS.md`.
3. **(Fase 3) Aplicar a migration** de summary-cache em prod via MCP (Claude escreve o SQL).
4. **(Fase 4) Escolher quais reps/contas vão pra tier Haiku** (baixo volume / baixo valor) — Sonnet continua default pro resto.
5. **(opcional) Rodar o bench empírico** (`ANTHROPIC_API_KEY` no `.env.local` local + `npx tsx scripts/bench-models-cost.ts`) se quiser a tabela qualidade×custo SparkBot-específica antes de decidir os tiers.
6. **Ligar cada flag** só após a validação de 1 conversa real da fase.

---

## Fora de escopo (anotado, não agora)

- **Roteamento automático por classifier** (Edge, decide barato/médio no 1º turno) — Fase futura; por ora tier manual por agente já entrega os "3 padrões".
- **Anthropic Memory Tool nativo (`/memories`)** — pra quando a orquestração de workflows grandes (H41) escalar.
- **Programmatic tool calling / code execution** — ganho real só em tarefas com resultados enormes; reavaliar depois.
- **F10 (scheduling admin condicional) e F11 (consolidar anti-alucinação)** — alto risco, fora do MVP.
