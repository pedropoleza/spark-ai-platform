# Baseline — custo lead-facing (pré-otimização)

> Snapshot de 30 dias antes de ligar `LEAD_CACHE_OPTIMIZED`. Re-rodar as mesmas medições ~1 dia após ligar a flag pra confirmar que o cache virou net-positivo.

## Estado medido (2026-07-01, 30 dias, 9 agentes ativos / 6 contas, todos `claude-sonnet-4-6`)

| Métrica | Valor |
|---|---|
| Turnos (`execution_log` action_type=`ai_processing`) | 1.301 |
| Input total | 17,25M tok |
| Input médio/turno | 12.484 tok |
| Output médio/turno | 220 tok |
| Cache WRITE (`usage_records.cache_creation_tokens`) | 13,82M (**80% do input**) |
| Cache READ (`cached_tokens`) | 0,78M (**4,8%**) |
| READ/WRITE ratio | **0,06** |
| cache_hit_ratio médio | **5,4%** (94% dos turnos ~0) |
| Gaps entre turnos <5min | 85% |
| **Custo 30d (`usage_records.cost_usd`)** | **$65,04** |
| Custo estimado SEM cache | $56,78 → **o cache custava +$8,26/mês** |

## Metas pós-flag (esperado)
- `cache_creation_tokens` **despenca** (system para de ser reescrito todo turno).
- `cached_tokens` (read) **sobe muito** (85% dos turnos <5min passam a acertar).
- READ/WRITE **>> 1**.
- Custo/mês cai de ~$65 para ~$38 (Fase 1) e vira **net-positivo** vs sem-cache.

## Queries de re-medição (script local, `createAdminClient`)
1. `execution_log` (action_type=`ai_processing`, lead agent_ids, 30d): médias de input/output + `action_payload.cache_hit_ratio`.
2. `usage_records` (lead agent_ids, 30d): `sum(cache_creation_tokens)` (write), `sum(cached_tokens)` (read), `sum(cost_usd)`.
3. Gaps: agrupar `execution_log` por `conversation_id`, ordenar por `created_at`, bucketizar gaps.

(Scripts descartáveis usados na medição inicial — reconstituíveis a partir destas descrições. A tabela `execution_log` NÃO tem `cache_creation_tokens`; só `usage_records` tem.)

## Como ativar (👤 Pedro, pós-merge+deploy)
1. Vercel → env `LEAD_CACHE_OPTIMIZED=1` (aplica a **todos** os agentes de todas as contas — é código, não dado).
2. Validar **1 conversa real** (o bot responde certo; carrier/lead-history agora no runtime).
3. ~1 dia depois: re-rodar as 3 queries → `cache_creation` deve despencar, custo cair.
4. Rollback instantâneo: `LEAD_CACHE_OPTIMIZED=0` (ou remover) → volta ao comportamento de hoje.

> Follow-ups (`follow-up-scheduler.ts`) ficam de fora de propósito: são one-shot proativos raramente relidos → 5m default é o certo (mesma lógica do H44 F4 no SparkBot).
