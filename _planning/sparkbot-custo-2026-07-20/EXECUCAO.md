# Execução — Onda A do estudo de custo (2026-07-20/21)

> Autorização do Pedro 2026-07-21: "Pode começar" (sobre a Onda A do ESTUDO.md).
> Código feito em worktree limpa de origin/main (`9338070`) — WIP do Alves Cury/H51 no working tree principal intocado.

## Código (worktree → commit → deploy)

| Item | O quê | Arquivos |
|------|-------|----------|
| A1 | Reverte F4/H44: processor não passa mais `cacheTtl:"1h"` (net-negativo + sub-cobrado 1,25× vs 2× real) | processor.ts, llm-client.ts (comments), run-sparkbot-turn.ts |
| A2 | `present_options` tool TERMINAL: resposta com SÓ esse tool_use + payload válido + exec ok → retorna `text:""`/`stopped_reason:"terminal_tool"` sem a chamada LLM seguinte (683×/mês descartadas). Decisão pura exportada `shouldEndOnTerminalTool` | llm-client.ts, run-sparkbot-turn.ts, processor.ts |
| A3 | pricing.ts: +claude-sonnet-5 ($3/$0.30/$3.75/$15 tabela), opus-4-6 corrigido $15/$75→$5/$25, +opus-4-7/4-8, `isKnownModel` exportado; trackAndCharge emite admin_signal high quando modelo cai no DEFAULT | pricing.ts, charge.ts |
| A4 | dispatcher passa `disableCache` quando `rule_type==="scheduled"` (cadência 24h > TTL máx 1h → cache 0% estrutural; write premium era custo puro) | dispatcher.ts, llm-client.ts |
| A6 | prompt: linha "TTL 30 min" (contradição com H49) → "rascunho de import por 24h"; header "~43 tools" sem número | prompt-builder.ts |
| A7 | `usage_records.charge_fail_reason` + `markChargeFailReason` nos catches + limpeza no `markWalletCharged` | usage-records.repo.ts, charge.ts, migration 00126 |

Testes: `scripts/test-cost-wave-a.ts` **43/43** · regressões ur1 25/25 · ur2 33/33 · takeover 36/36 · weekday 28/28 · override 25/25 · batch 11/11 · tsc 0 · build OK. Review adversarial (4 lentes × verificação) ANTES do push — resultado abaixo.

## Prod (DB, sem deploy) — executado 2026-07-21 ~05:40 UTC

| Ação | Resultado | Rollback |
|------|-----------|----------|
| Migration 00126 (`charge_fail_reason`) aplicada + registrada em schema_migrations | ✅ (ANTES do deploy — markWalletCharged passa a escrever a coluna) | `ALTER TABLE usage_records DROP COLUMN charge_fail_reason` |
| A4: 4 regras `scheduled` sonnet→haiku (Resumo matinal enabled + Resumo fim do dia/Reflexão semanal/Pipeline review disabled — nascem baratas se ligarem) | ✅ 4 rows | `UPDATE assistant_proactive_rules SET ai_model='claude-sonnet-4-6' WHERE rule_type='scheduled'` |
| A5: `disabled_tools` do hub (config `747cbdb1-3431-4983-9ef1-062ef946b184`) ← 10 tools zero-uso-30d: count_filtered, bulk_request_cap_override, bulk_edit_pending_job, bulk_cancel_all, bulk_reschedule_job, get_bulk_job_progress, set_verbosity_preference, delete_opportunity, forget_rep_alias, list_rep_aliases | ✅ | `UPDATE agent_configs SET disabled_tools='[]'::jsonb WHERE id='747cbdb1-...'` |

Pares de segurança PRESERVADOS no A5 (decisão consciente): `bulk_pause_all`↔`bulk_resume_all`, `cancel_bulk_job`, `get_note`/`get_task` (pares dos update_*), `switch_active_location`/`list_my_locations` (multi-location), biblioteca de fluxos F7 (find_flow/apply_saved_flow/get_task_progress/generate_flow_pdf/send_media — usuária-alvo Jussara), `set_rep_preferred_name` (caso Manuela H42), `describe_filter_capabilities` (2 usos).

## A7 — achado corrigido em campo

O finding "claims órfãos $15,49 que o retry nunca recupera" foi **REFUTADO na prática**: os 120 records claimed do momento tinham <10min (cron de retry ciclando nas wallets bloqueadas) e `reapStaleClaims` (15min) está funcionando. Nenhum fix de reaper necessário — só a observabilidade (`charge_fail_reason`).

Notificação da dona da b1tt ($29,54 desde 30/06, nunca avisada): script `scripts/notify-wallet-b1tt.ts` pronto (copy H52 aprovada). **NÃO disparado de madrugada** (~2h no fuso dela) — agendado pra ~13:00 UTC.

## Review adversarial (4 lentes + verificação, 6 agentes) — resultado

**A2 CONFIRMADO LIMPO fim-a-fim** (as 2 lentes rastrearam independentemente): persistência nunca grava content vazio (fallbacks `|| "(sem resposta)"` em 3 pontos), coherence-gate pula (analisava texto DESCARTADO — skip é ganho puro), anti-repeat/billing/histórico idênticos, proativo não recebe terminalTools, paridade provada em prod (676 turnos com present_options/30d, ZERO com tools depois dela). A1/A3/A6 limpos (nenhum modelo em uso cai no DEFAULT; opus-4-6 tinha ZERO records = correção preventiva, ninguém foi sobre-cobrado).

Achados aplicados ANTES do push:
1. **CONFIRMADO P1**: o furo TTL 1h×1,25× segue ABERTO no lead-facing (`queue-processor.ts:1132/1162` → `openai-client.ts`, plumbing próprio; ~$15-19/mês re-derivado). Lá o 1h é net-POSITIVO (hit ~70%) → fix certo é billing por bucket, BLOQUEADO pelo WIP do H51 no queue-processor. Feito agora: comentários corrigidos (não afirmam mais "nenhum caller passa 1h") + task CU-4.
2. **P2 (3 lentes)**: `markWalletCharged` embutia o clear da coluna nova no UPDATE crítico do dinheiro (PGRST204 silencioso mataria o mark → re-charge em loop). → Ordering-proof: UPDATE crítico sem a coluna + clear best-effort separado + check de error.
3. **P2 (2 lentes)**: premissa do A4 é run de 1 iteração (126/126 medidos); scheduled multi-iteração sem cache fica ~48% MAIS caro. → Guard: signal dedupado quando `disableCache && iterations>1` + comment da premissa (revisar antes de ligar rules da Onda 3-5).
4. REFUTADO (verificador): "deploy antes da migration" — coluna já existia em prod + PostgREST auto-reload confirmados. Nota residual: registrar 00126 em schema_migrations (✅ feito na aplicação).

## Deploy
- Commit `0124563` → push origin/main 2026-07-21 ~06:05 UTC. Suítes finais: wave-a 43/43 · ur1 25/25 · ur2 33/33 · takeover 36/36 · weekday 28/28 · override 25/25 · batch 11/11 · tsc 0 · build OK.
- Vercel: **● Ready** em ~3min (deploy `9o1096vmw`, alias git-main; verificado via `vercel ls --prod` + `vercel inspect` 2026-07-21 ~06:15 UTC).

## Pendências da onda
- [x] Review adversarial → 3 fixes aplicados (acima)
- [ ] `vercel ls --prod` até Ready (poll rodando)
- [x] notify-wallet-b1tt DISPARADO 2026-07-21 15:42 UTC (11:42 EDT) — foi pro **Gustavo Couto** (dono da b1tt), copy H52. Lição registrada: mensagem externa a cliente → nomear a PESSOA nos planos, não o location_id (Pedro não tinha conectado b1tt=Gustavo). **DESFECHO: Gustavo recarregou ~1h depois** → desbloqueio automático (H52) + retry drenou os $29,54 ao longo de ~2h ($25,08 confirmados às 17:55 UTC, restante em fila sem nenhuma falha nova; `charge_fail_reason` validado ao vivo: preenchia "insufficient funds" e limpava na cobrança). 1º ciclo E2E completo do wallet-block com cliente real ✅
- [x] Worktree wt-custo-a removida pós-disparo
- [ ] Validação pós-deploy (48h): Resumo matinal em haiku ~$0.04/run e sem cache-write; turnos `terminal_tool` com envio ok; signal "modelo sem pricing" silencioso; sonnet-5 cobrando ~8× mais/record; guard A4 sem disparos
- [ ] CU-4 (furo lead-facing): billing por bucket ephemeral_{5m,1h} — quando o H51 landar

## Onda B deploy 1 (H54) — 2026-07-21, commit 7157050
B3 prefixo global por-config (~$50/mes) + B2 dieta descriptions (tools 103K->92K) + B0 call_usage por chamada (webhook+Stevo). Review: ZERO P0/P1, 1 confirmado (B0 cego na rota Stevo, corrigido) + 6 P2. Sem migration/flag — rollback = revert. Validacao 48h: cache-write/turno cai, call_usage populando, conversa da Jussara honra manual_context (👤). Pendente: B1 tool-search defer, B4 secoes condicionais, B5 proativos F8.
