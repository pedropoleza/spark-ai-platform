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

## Pendências da onda
- [ ] Review adversarial → aplicar achados confirmados
- [ ] Commit + push + `vercel ls --prod` até Ready
- [ ] Disparar notify-wallet-b1tt em horário comercial
- [ ] Validação pós-deploy (48h): Resumo matinal em haiku/custo ~$0.04/run; nenhum `terminal_tool` com envio vazio; signal "modelo sem pricing" silencioso; sonnet-5 cobrando ~8× mais por record
