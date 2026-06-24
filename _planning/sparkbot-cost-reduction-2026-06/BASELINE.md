# Baseline de custo/tokens — SparkBot & agentes (medido em prod)

> Fonte: `usage_records` (billing real) + `sparkbot_messages.metadata` (Supabase prod), 14–30 dias até 2026-06-24. Pricing autoritativo via skill claude-api.

## Pricing de referência (por 1M tokens)
| Modelo | Input | Output | Cache-read (~0.1×) | Cache-write 5min (1.25×) | Contexto | Mín. cacheável |
|---|---|---|---|---|---|---|
| Opus 4.8 | $5.00 | $25.00 | $0.50 | $6.25 | 1M | 4096 tok |
| **Sonnet 4.6** (atual) | $3.00 | $15.00 | $0.30 | $3.75 | 1M | 2048 tok |
| Haiku 4.5 | $1.00 | $5.00 | $0.10 | $1.25 | 200K | 4096 tok |
| GPT-4.1 (fallback) | $2.00 | $8.00 | cache auto | — | 1M | — |
- Cache TTL: **5min default**, **1h dobra o write** (2×). Trocar de modelo OU mudar tools/system invalida o cache. Render order: `tools → system → messages`. Lookback 20 blocos.

## Custo TOTAL por mês (30d, `usage_records`)
| Origem | Modelo | Registros | Custo | Charged (10% markup) | avg tokens/turno | cache |
|---|---|---|---|---|---|---|
| **SparkBot** `account_assistant_turn` | Sonnet 4.6 | 1892 | **$280.04** | $308 | **172.393** | 272M/325M = **84%** |
| Lead-facing `ai_processing` | Sonnet 4.6 | 771 | $33.22 | $36 | 11.999 | baixo (~8%) |
| Proativo `Pós-reunião` | Haiku 4.5 | 217 | $9.62 | $10.6 | 36.746 | ~2% |
| Proativo `Resumo matinal` | Sonnet 4.6 | 67 | $9.10 | $10 | 36.293 | **0% (cache quebrado)** |
| Fallback `account_assistant_turn` | **gpt-4.1** | 115 | $8.70 | $9.6 | 103.578 | — |
| `follow_up` | Sonnet 4.6 | 321 | $1.75 | $1.9 | 1.526 | — |
| Proativo Pós-reunião (fallback) | gpt-4.1 | 18 | $0.81 | — | 27.527 | — |
| Áudio | whisper-1 | 81 | $0.38 | — | 3.846s | — |
| `summary_note` / resto | gpt-4.1-mini | — | ~$0.2 | — | 360 | — |
| **TOTAL** | | | **~$345** | **~$380** | | |

## Economia por turno do SparkBot (o alvo)
Por turno (Sonnet 4.6): **~177K input** (148K cache-read + 29K input cheio) + **336 output** = **~$0.148/turno**.
- Decomposição: `29.413 × $3/M = $0.088` (input cheio) + `148.049 × $0.30/M = $0.044` (cache-read) + `336 × $15/M = $0.005` (output).
- **O custo é 96% INPUT.** Output é irrelevante. → Otimizar é encolher o INPUT que entra por turno.

## De onde vêm os 177K tokens de input/turno
1. **System prompt do SparkBot: ~87K chars ≈ ~22K tokens** (decision-codes, regras acumuladas H1–H43, seções de agendamento/canais/etc). Cacheado, mas é o piso do prefixo.
2. **Definições de 50+ tools** (~15–25K tokens) — sempre carregadas, mesmo as raras.
3. **Histórico de até 30 turnos** com tool_results crus: transcrições de áudio, dumps de `search_contacts`/tabular, listas de slots. Pode passar de 100K tokens.
4. = ~177K. Cache pega 84% (o prefixo estável), mas o volume + o delta não-cacheado (29K/turno) + os reps idle que re-pagam cache-write (TTL 5min) somam.

## Achados que viram alavanca (confirmar com a pesquisa)
1. **SparkBot = 81% da conta.** Toda otimização foca nele. Lead-facing (12K/turno) já é enxuto — baixa prioridade.
2. **Resumo matinal: cache=0** (`daily-briefing` paga 36K tokens cheios × 67/mês). Provável invalidador silencioso (timestamp/data no prefixo, ou prompt montado a cada vez sem `cache_control`). **Quick win.**
3. **Pós-reunião (Haiku): ~2% cache** — idem, prefixo não cacheado.
4. **~6% dos turnos caem no gpt-4.1** ($8.70/mo) — input mais caro ($2 vs $3? não, mas) + cache pior; investigar por que Sonnet+Haiku falham (parse? overload? STRICT_CLAUDE_ONLY?).
5. **3 tiers por agente (objetivo do Pedro):** barato (Haiku, prompt enxuto, menos tools, menos histórico) / médio (Sonnet, atual) / avançado (Opus/Sonnet + memória + tools completas). Roteamento por-conversa pra não quebrar cache.
6. **Escala:** ~20 reps ativos hoje = $345/mo. 120 locations → ~$1.700/mo. Controle de custo é condição pra escalar.

## Levers candidatos (pré-pesquisa — a validar)
- **Encolher o system prompt** (87K→?) sem perder regras (decompor/condicionar seções por contexto).
- **Tool subsetting / tool-search** (carregar só as tools relevantes ao turno).
- **Podar histórico** (context editing: limpar tool_results antigos; sumarizar áudio/tabular antes de entrar no contexto).
- **Cache 1h pra reps idle** + pre-warming; consertar o cache do briefing.
- **Roteamento Haiku pra turnos simples** (confirmações, 336 tokens output) — via subagente ou por-conversa.
- **Memória persistente** (perfil do rep/contato) pra não reenviar histórico nem alucinar.

> ✅ **CONCLUÍDO:** pesquisa web (4 frentes) + ultra code-review (4 superfícies, 17 fixes com file:line) + custo determinístico → `ESTUDO.md`. Plano priorizado (5 fases, F1-F17) → `PLANO.md`. Benchmark empírico de modelos (`scripts/bench-models-cost.ts`) BLOQUEADO local (ANTHROPIC_API_KEY é Sensitive na Vercel, puxa vazio) — 👤-runnable; custo é matemática exata e qualidade vem de benchmarks publicados, então não bloqueia. Aguarda aprovação do Pedro pra implementar.
