# Ultra-Review SparkBot — 2026-05-19

> Objetivo macro: tornar o SparkBot um "funcionário super-humano" — certeiro, natural e
> carismático — para que reps de fato o adotem na operação. Review em nível enterprise,
> dirigido por evidência. Dono: Pedro Poleza.

## Decisões de execução
- **Faseado**: Fase 1 (interações) → Pedro revisa → Fase 2 (codebase).
- **Mandato READ-ONLY (só diagnóstico)**: nenhum agente altera código do bot. Único
  entregável de escrita = arquivo(s) markdown neste diretório. Correções viram backlog.

## Base de dados (recon 2026-05-19)
- Período em prod: **2026-05-01 → 2026-05-20** (~3 semanas).
- `sparkbot_messages`: **2.219** msgs (1.016 rep / 1.203 bot). Canais: 2.056 WhatsApp · 144 web · 19 system.
- **37 reps ativos** (de 112 identidades; 62 aceitaram termos).
- `admin_signals`: **50** (26 error · 16 missed_capability · 6 failure · 2 idea; 14 high; 30 open).
- `usage_records`: **1.421** · `filter_executions`: **230** · `bulk_message_jobs`: **19** · `followup_sequences`: **2**.
- Supabase project_id (DB do SparkBot): **`vyfkpdnwevtuxauacouj`** (nome "AI Agent Hub").
- Uso de tools gravado em `sparkbot_messages.metadata->'tool_calls'` + `usage_records.action_type`.

### Distribuição por rep (top + cauda)
| Rep | Phone | Interno | Msgs |
|---|---|---|---|
| Gustavo Couto | +17542650461 | não | 563 |
| John Doe (teste do Pedro) | +17867717077 | **sim** | 432 |
| Soraia Close | +15612552996 | não | 316 |
| Sabrina Caldas | +17326186381 | não | 231 |
| Marcos Alves | +17864615477 | não | 151 |
| Phil Siqueira | +15083456828 | não | 112 |
| Luciano Correia | +19543051116 | não | 81 |
| Wagner Witka | +14074577537 | não | 57 |
| Bianca Soares | +19803392445 | não | 51 |
| Michelle Melo | +15619399370 | não | 47 |
| Marcela Siqueira | +17747337182 | não | 45 |
| Victor Alves | +5524988370280 | não | 44 |
| Manuela Garcia | +17866276787 | não | 33 |
| (cauda) ~24 reps | — | não | 1–8 cada (quase só onboarding/bot-only) |

## Fase 1 — Agentes (4, paralelos, read-only)
- **A1 · Métricas** → `A1-metricas.md`. Frequência de cada tool, taxa de erro por tool,
  % de runs com 2+ tools (liberdade agêntica real), tools mortas (definidas e nunca usadas),
  frequência de over-confirmação, tamanho/latência, breakdown por canal e interno/externo.
- **A2a · Conversas (clientes pesados)** → `A2a-conversas.md`. Cohort: Gustavo, Soraia, Marcos, Phil.
- **A2b · Conversas (interno + médios + cauda)** → `A2b-conversas.md`. Cohort: John Doe (Pedro),
  Sabrina, Luciano, Wagner, Bianca Soares, Michelle, Marcela, Victor, Manuela + cauda.
- **A3 · Forense de signals** → `A3-signals.md`. 50 signals → bug real / falso-positivo /
  já-corrigido, root cause + status em código/git. Inclui explicitamente os já corrigidos.

## Fase 2 — Codebase (a disparar após review do Pedro)
- **B1** Arquitetura & fronteiras · **B2** Tool system & liberdade agêntica (loop, multi-tool/run,
  confirmation gate, qualidade das descriptions) · **B3** Organização & limpeza (arquivos gigantes,
  duplicação bulk V1/V2/management, dead code, regra "Spark Leads ≠ GHL").

## Padrão de evidência (toda a frota)
Zero afirmação sem rastro: `message_id`/timestamp + citação curta · `signal_id` · `arquivo:linha` ·
commit. Saída PT-BR. Cada relatório abre com RESUMO EXECUTIVO.

## Síntese final
`RELATORIO-EXECUTIVO.md` — achados priorizados P0/P1/P2, cada um amarrado à evidência.
