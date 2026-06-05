# Fixes aplicados pós-review — 2026-06-05

Sequência Pedro: **P0 → teste → P1 → teste**, "máximo com qualidade".

## ✅ P0 (5/5) — deployado + testado
1. **Gate 1 SparkBot** — `check-admin` exige `account_assistant` ativo na location (`isLocationSparkbotHub`). **Verificado ao vivo:** widget some do Five Star (não-hub), robô do agente continua. `2c38980`
2. **Follow-up erros silenciosos + F47** — cancel checa `{error}` e aborta p/ não duplicar; insert em lote; `reportError` no scheduler e no runner. `2c38980`
3. **Handoff sem lead_history** — carrega histórico se memória-do-lead OU handoff precisam; só injeta no prompt se memória ON. `2c38980`
4. **DELETE global cross-tenant** — prune do inbound-webhook-capture agora por-location. `2c38980`

## ✅ P1 (6 itens) — deployado
**Lote 1** (`9dc7fcd`): cache lead-history (include_tags na chave + invalidação a cada turno) · filtro de msg vazia no processor (Claude 400) · custom agent não crasha com `AGENT_MOTOR_UNIFIED=1` (fail-safe pro builder legado) · **migration 00099 TTL crons** (sparkbot_messages + filter_executions >30d, ativos no DB).

**Lote 2** (`47c3149`): loop-breaker do coherence usa `HONEST_FALLBACK_FINGERPRINT` (fonte única, sem string mágica) · handoff resolve rep por `opportunities[].assignedTo` (não notifica rep errado em location multi-rep).

## ⏭️ Verificado falso-positivo / deferido (com motivo)
- **Weekly cap (bulk)** — ❌ falso-positivo: `schedule_bulk_message_v2` JÁ bloqueia hard (bulk-messages-v2.ts:806-820). Sem ação.
- **Image/Vision billing** — telemetria-only: o custo da imagem já entra via `prompt_tokens` (Claude conta token de imagem). Só o `image_count` fica em 0. Baixo valor; deferido.
- **Timing-match signal** — pulado: dispara em TODA mídia (2º webhook do multi-provider), viraria ruído. Fazer certo exige distinguir falso-positivo (humano 2 msgs <5s) de dedup real.
- **Cap mensal em UTC** — pulado: offset de horas no boundary do mês, cap soft, baixo-ROI.

## 🔜 Restante P1 (não-bloqueante — hardening de hypercare)
- **Sweep de ~95 falhas silenciosas** (`console.error` sem `reportError`): os **keystones já têm `reportError` (F49)** — webhooks, processor, crons. O que sobra é o tail (settings, contact-status, etc.), menor risco. **Recomendo um pass dedicado** (95 pontos, cada um com julgamento de severidade) em vez de wrap mecânico.
- **Auth hardening**: (a) signal de brute-force (médio, dá pra fazer); (b) **rotação de JWT_SECRET** (rolling-key) — **👤 task do Pedro** (precisa setar 2 secrets no env).

## Estado pra produção
**Todos os P0 (bloqueadores de launch) resolvidos + verificados.** Os P1 de alta-confiança e bem-localizados resolvidos. O restante é hardening não-bloqueante. **11 fixes em prod, tsc+build limpos em cada deploy.**
