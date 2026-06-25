# F0.1 — Snapshot de baseline (medido em prod 2026-06-24, antes da Fase 1)

> Fonte: `usage_records` (Supabase prod), últimos 30 dias. Tirar de novo DEPOIS da Fase 1 pra provar o ganho.

## Cache por origem (input tokens, 30d)
`prompt_tokens` (=total input, inclui cache) = cache_read + cache_write + uncached.

| Origem | Modelo | turnos | total in | cache_read | cache_WRITE | uncached | read% | $ aprox |
|---|---|---|---|---|---|---|---|---|
| **account_assistant_turn** | Sonnet 4.6 | 1898 | 326.8M | 273.1M (83.6%) | **37.9M (11.6%)** | 15.9M (4.9%) | 83.6% | **~$272** |
| account_assistant_turn (fallback) | gpt-4.1 | 115 | 11.9M | 10.2M | 0 | 1.7M | 85.5% | ~$9 |
| ai_processing (lead-facing) | Sonnet 4.6 | 778 | 9.2M | 0.73M | 7.55M | 0.9M | **4.2%** | ~$33 |
| proactive:Pós-reunião | Haiku 4.5 | 216 | 7.93M | 0.18M | 7.07M | 0.68M | **1.2%** | ~$9.6 |
| **proactive:Resumo matinal** | Sonnet 4.6 | 67 | 2.42M | **0** | 2.30M | 0.12M | **0.0%** | ~$9.1 |
| follow_up | Sonnet 4.6 | 322 | 0.47M | 0 | 0 | 0.47M | 0% | ~$1.8 |

## Leituras-chave (corrigem a moldura do BASELINE)
1. **O maior custo único é o cache-WRITE do turno principal: 37.9M tok/30d ≈ $142/mês (metade da conta do SparkBot).** 37.9M / 1898 ≈ **20K/turno** = exatamente o bloco de system (~22K) sendo **re-escrito quase todo turno**. → **F1 é o megaprêmio** (não um fix menor): mover o `conversationalLayer` pra fora do system corta esses ~20K/turno de write→read.
   - Saving estimado F1: ~20K/turno × ($3.75−$0.30)/M (write→read) ≈ **$0.069/turno** → se cortar ~70% dos writes (cold-starts ainda escrevem), **~$90-130/mês**.
2. **Resumo matinal: read 0%, tudo write (2.30M)** → confirma F2 ao osso. Pós-reunião (Haiku) 1.2% → mesmo problema (prefixo proativo não compartilha cache).
3. **Lead-facing (ai_processing): só 4.2% read** — barata no agregado ($33), baixa prioridade (mas o mesmo padrão de fix valeria depois).

## Gap inter-turno do rep (decide F4 — TTL 1h)
2074 gaps entre turnos `user` consecutivos (30d):
- **< 5min: 1564 (75.4%)** — já quente no TTL 5min.
- **5-60min: 209 (10.1%)** — **rescued pelo TTL 1h** (hoje expira e re-escreve).
- **> 60min: 301 (14.5%)** — frio de qualquer jeito (mesmo 1h expira).

**Decisão F4 = SIM.** Custo esperado de write por turno ∝ freq × multiplicador:
- TTL 5min: re-escreve em 24.6% dos turnos (5-60 + >60) × 1.25 = **0.308**.
- TTL 1h: re-escreve em 14.5% (só >60) × 2.0 = **0.290**.
→ 1h é marginalmente **mais barato no write E** dá cache-read pra +10.1% dos turnos. Net-positivo. (É o menor dos 4 fixes; medir depois.)

## Como remedir (pós-Fase 1)
Rodar de novo as 2 queries (cache por origem + gap). Esperado: `account_assistant_turn` cache_write despenca (37.9M → ~cold-starts), read% sobe pra ~95%; `Resumo matinal` read% sai de 0.
