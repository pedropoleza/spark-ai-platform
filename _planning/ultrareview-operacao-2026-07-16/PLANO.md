# Ultra-review de OPERAÇÃO — 2026-07-16

> Pedido do Pedro: "ver todas as últimas conversas, backlog, ideias, erros, TUDO — comportamentos, sinais".
> Não é code-review de branch: é auditoria da operação em prod (banco `vyfkpdnwevtuxauacouj`, read-only) + backlog interno.
> Execução: workflow multi-agente (padrão da ultra-review H41), 9 dimensões em paralelo + verificação adversarial dos achados P0/P1 + síntese final.

## Foto de escopo (queries de dimensionamento, 2026-07-16)

- **SparkBot**: 2.523 msgs / 33 reps ativos nos últimos 7 dias.
- **admin_signals**: 114 erros `open` (157.140 ocorrências acumuladas!), 53 `missed_capability` open, 27 `failure` open, 2 ideias open. 58 erros done, 68 wontfix.
- **execution_log 7d (lead-facing)**: 656 send_message, 671 lead_history_loaded, 399 followup_skipped, 255 targeting_skip, 234 ai_paused_skip, 80 should_respond_skip, 67 ai_paused, 21 handoff_notification, 3 critical_error, 2 send_error_message.
- **usage_records**: colunas reais = `prompt_tokens/completion_tokens/cached_tokens/cache_creation_tokens/cost_usd/ai_model` (sem `input_tokens`).

## Linha do tempo de deploys (contexto pros agentes)

- 2026-07-10→14: 3 deploys de prod **falharam em silêncio** (nada novo entrou em prod no período). Destravado 07-14 (`55490e3`).
- 2026-07-15: **H50** guarda weekday↔data (`4cd48a5`).
- 2026-07-16: fix auto-pause Jussara (`2bfd419`) + config targeting Jussara (tags `metaads`/`patrocinados`).

## Casos conhecidos (validar estado, não redescobrir)

- **Luciano** (rep `34930c4d-1df9-4d4b-a617-04723c37ca02`): timeout silencioso em turno pesado (>60s Vercel) — fix PENDENTE de decisão.
- **Caua** (rep `2dbd9d0a-03b7-44b3-bbe8-a2b3be5a6d24`): agendava no dia errado — fix H50 no ar, validar.
- **Jussara** (location `pGl5pqLLG0QDixANpFnP`, agente `a297dadc-873a-4803-885d-472c65414168`): 6 pontos, 2 corrigidos hoje — validar.
- **Job bulk `8d622ac4`** (H49): pausado há ~8 dias com 5 pendentes — Pedro precisa decidir cancelar.

## As 9 dimensões

| # | Dimensão | O que caça |
|---|----------|------------|
| 1 | conversas-qualidade | Reclamações de rep, falsas confirmações, repetição, churn de reps (7d) |
| 2 | silencios-timeouts | Inbound sem resposta (padrão Luciano) — quantificar pro fix do timeout |
| 3 | agendamento-h50 | Validação do weekday guard + saúde geral de agendamento |
| 4 | resolver-h45 | Taxa de "não achei" pós contact-resolver (baseline: 45/sem) |
| 5 | signals-backlog | Triagem dos 114 erros open + funil de ideias (53 missed caps) |
| 6 | lead-facing | Skips/pausas por agente, validação fix Jussara, agentes novos (Raquel/Alves Cury/Marina) |
| 7 | proatividade-crons | Scheduled tasks, sequências, bulk jobs travados, recurring, proativos |
| 8 | custo-cache | Validação H44 Fase 1 (cache_write despencou?), custo por agente, outliers |
| 9 | backlog-planejamento | Pendências 👤, flags OFF, estudos parados, ondas não iniciadas (arquivos locais) |

## Regras

- Banco de PROD: **somente SELECT**. Nunca usar `mcp__supabase__*` (outro projeto).
- Todo achado com evidência real (números/ids/trechos de query) e severidade P0-P3.
- P0/P1 passam por verificação adversarial (agente independente tenta refutar re-rodando as queries).
- Síntese final: relatório priorizado em `RELATORIO.md` + plano de correção pro Pedro.

## Status

- [x] Escopo dimensionado
- [x] Workflow rodado (33 agentes, ~22 min, 9/9 dimensões)
- [x] Verificação dos P0/P1 (24 verificados: 21 CONFIRMED, 1 PLAUSIBLE, 2 REFUTED)
- [x] `RELATORIO.md` + plano de correção (4 P0, 12 P1, 4 frentes)
