# SparkBot — Relatório Final da Refatoração V2 (sessão autônoma 2026-05-20)

> One-shot executado com o Pedro away. Tudo commitado em `main` **LOCAL** (NÃO deployado).
> Deploy + smoke em prod = combinados pra amanhã, juntos. Tag de rollback: `sparkbot-v2-baseline`.

## Veredito (scores antes → depois)

| Dimensão | Baseline (review 19/05) | Pós-V2 | Δ | Fonte |
|---|---|---|---|---|
| **Comportamento** ("funcionário humano") | 6,0/10 | **7,3/10** (projetado) | +1,3 | RV1 |
| **Arquitetura** | 6,5/10 | **7,0/10** | +0,5 | RV2 |
| **Organização / limpeza** | 5,5/10 | **6,5/10** | +1,0 | RV2 |
| **Prontidão pra deploy** | — | **8,5/10 → GO** | — | RV3 |

> O score de **comportamento é PROJETADO**: o código resolve os P0/P1, mas a calibração de
> persona/confirmação é prompt-only — só o **smoke de amanhã + dados pós-deploy** confirmam a
> aderência real do modelo. O coherence-gate (a peça determinística) é a de maior confiança.

## O que foi implementado (6 commits)

| Onda | Commit | Entrega |
|---|---|---|
| 1 | `876dcb6` | **Coherence gate** — "verdade de execução": detector virou gate blocking; re-run seguro (só sem escrita prévia) ou reescrita honesta; nunca duplica ação de cliente. Verifica RESULTADO da tool + separa criar/mover opp. |
| 1 | `834f827` | **Silence-gate** — lembrete que o rep agendou não leva mais aviso ameaçador nem conta como silêncio. |
| 2 | `ae174bc` | **Scope-manager** — IAM-unsupported (delete_appointment) não é mais retentado 3×; 403/IAM viram signal acionável + tabela `location_scope_coverage` (migration aplicada via MCP). |
| 3 | `b87dd59` | **Prompts & tools** — `move_opportunity` + guards (create_opportunity/create_contact); prompt: roteamento de opp, anti-over-confirmação, anti-jargão, segurança de superfície, persona; **16 strings GHL→Spark Leads**. |
| 4 | `10560df` | **Bulk consolidation** — remove as 2 tools V1 deprecated do schema do LLM (−437 LOC); helpers compartilhados preservados. |
| docs | `c0b393f` | Os 10 relatórios do review + plano FORGE-3. |

**Validação:** golden suite **49 casos** (coherence 14 + silence 10 + scope 19 + routing 6) · `next build` ✅ · `tsc` 0 erros · lint limpo.

## Sintoma (review original) → resolução na V2

| Achado | Status pós-V2 |
|---|---|
| **P0-1 FALSE CALL** (afirma escrita sem tool) | ✅ **Resolvido** — coherence gate determinístico (golden 14/14, incl. Gustavo msg114). |
| **P0-2 dupla-resposta** | 🟡 **Mitigado** — origem some com a WhatsApp API desligada (só Stevo) + silence-gate + prompt "1 resposta/turno". Dedup-guard por conteúdo no `webhook-handler` (defesa se a WhatsApp API voltar) → **V2.1**. |
| **P0-3 mover→create** (duplicatas) | ✅ **Resolvido** — `move_opportunity` + regra de roteamento no prompt + gate separa "movido" de "criado". |
| **P1 over-confirmação (33%)** | ✅ **Calibrado** (prompt) — confirma 1×, natural, não cita mecânica interna; a confirmar no smoke. |
| **delete_appointment IAM** | ✅ Não-retryable + mensagem clara + signal. |
| **get_contact_notes 403** | ✅ Scope do token confirmado (D8) cobre contacts; era cobertura de location (reautorizada). Scope-manager = rede. |
| **Persona/jargão/segurança** ("sou seu criador", IDs crus) | ✅ Resolvido no prompt (a confirmar no smoke). |
| **Spark Leads ≠ GHL** | ✅ **0 violações** LLM-facing (16 strings trocadas). |

## Conscientemente adiado → Fase Estrutural V2.1 (iteração dedicada COM smoke)

Decisão de julgamento: estes tocam **ingestão/roteamento de prod**; refatorá-los numa sessão noturna sem smoke contraria a regra de ouro ("não afetar operação de cliente em andamento").
- **Camada de repositório** (≈158 `createAdminClient()` crus — maior dívida do B1).
- **Migração das 43 `ctx.ghlClient.*` → `operations.ts`** (fronteira GHL; subiu p/ 43 com o `move_opportunity`).
- **Decomposição do `webhook-handler.ts`** (1.052 LOC, idempotência das 7 camadas) + **dedup-guard por conteúdo**.
- **Multi-tenant real** (`resolveHubForLocation`; remover `ASSISTANT_HUB_LOCATION_ID` load-bearing, 21 refs).
- **Renomear colisões** (2× `processor.ts`, 2× `prompt-builder.ts`); unificar loop `processor`×`dispatcher`; URL do `pg_cron` parametrizada.

## Riscos residuais (pro smoke de amanhã cobrir)
1. **Re-run do coherence gate nunca rodou E2E** com LLM+tools reais (o caminho que de fato executa a escrita nova). 
2. **`move_opportunity` sem teste de integração GHL** (PUT `pipelineStageId`).
3. **Dupla-resposta conversacional**: resolvida só enquanto for Stevo-only.
4. **Calibração de persona/confirmação é prompt-only** → o modelo pode não aderir 100%; medir no smoke.

## Plano de deploy + smoke (amanhã, juntos)
1. Revisar `git log --oneline sparkbot-v2-baseline..HEAD` (6 commits).
2. `git push` → Vercel deploya prod.
3. **Smoke (sua conta):** nota em 3 contatos · mover opp (conferir no app que **moveu, não duplicou** — caso Henry) · fechar/criar opp · lembrete solicitado vindo **limpo** (sem ameaça) · envio a cliente com **1 confirmação** sem re-perguntar (caso Phil) · provocar um erro e ver mensagem **sem jargão** · `get_contact_notes` na location `dF2FDDZzSv715e1av4gr`.
4. Monitorar `admin_signals` (coherence/scope) por alguns dias (hypercare).

## Índice
`RV1-confiabilidade.md` · `RV2-arquitetura.md` · `RV3-prontidao.md` · + os 10 relatórios do review original + `RELATORIO-EXECUTIVO.md`.
