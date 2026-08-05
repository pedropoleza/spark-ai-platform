# Ultra-review de consolidação das Ondas A+B + Onda C (2026-07-22)

> Pedro 2026-07-22: "roda um ultra review de tudo que foi feito, ver se tem alguma coisa que pode quebrar ou se a gente tá perdendo qualidade em algum lugar, pra já deixar redondo e funcionar."
> Ultra-review: 17 agentes, 5 lentes (dados/qualidade-conversas/código/sinais/billing) + verificação adversarial → 11 achados confirmados.

## Veredito do ultra-review

**As Ondas A+B em si estão SAUDÁVEIS — nada quebrou, nada perdeu qualidade.** Provado em prod com números:
- B3 prefixo byte-estável de 71.951 tok compartilhado entre conversas/reps; write quente −70/85%.
- A2 present_options terminal: input dos turnos de menu 251K→155K (−38%), 30/30 entregues sem erro.
- A4 Resumo matinal em haiku: $0,1586→$0,0422/run (−73%), tom preservado.
- B0 call_usage 100% no inbound; resolveu a divergência 40K-vs-76K (prefixo real ~74-75K, ~2,4 calls/turno).
- A7 billing 99,4-100% cobrado, zero double-charge; charge_fail_reason populando.
- H50 salvou um booking real (Daniely); H52 wallet-block E2E validado (Gustavo/b1tt zerado).

Os problemas são **vizinhos do deploy**, não as ondas.

## Onda 0 — ações imediatas em prod (executadas 2026-07-22 ~05:30 UTC)

| Ação | Resultado | Rollback |
|------|-----------|----------|
| **Melissa destravada** (P0 loop-guard falso positivo) | rep e9526616 proactive_pause_source=NULL | `UPDATE rep_identities SET proactive_paused_at='2026-07-22 01:03:52.822+00', proactive_pause_source='loop_guard' WHERE id='e9526616-9d9d-4992-8dc0-bbb1f0365a9b'` |
| **Gustavo redondo** (P0): Caroline recebia 3 msgs sáb 25/07 → 1 | 55ebcaf9 + be3fe40f → cancelled | `UPDATE assistant_scheduled_tasks SET status='pending' WHERE id IN ('55ebcaf9-...','be3fe40f-...')` |
| Mauricio no dia errado (sáb 25) → sexta 24/07 12:30 | d08d2e40 movido | `SET next_run_at='2026-07-25 12:30:00+00' WHERE id='d08d2e40-...'` |
| **Config do hub corrigido** (C4 pré-req): enable_audio/image/pdf false→true | 747cbdb1 | `SET enable_audio_transcription=false, enable_image_analysis=false, enable_pdf_reading=false WHERE id='747cbdb1-...'` |

⚠️ Melissa: o pedido dela por áudio (marcar Rina terça 19h + mover esteira) foi ENGOLIDO e nunca executado → 👤 avisar/reexecutar.

## Onda C — código (worktree wt-redondo, base origin/main 58c8967)

| Fix | O quê | Arquivos |
|-----|-------|----------|
| C1 (P0) | loop-guard: tap de menu/áudio = prova de humano → quebra a contagem (caso Melissa; o fluxo interativo do Agendamento V2 é o caminho feliz que o guard silenciava). `isHumanProofMsg` puro; processor busca metadata. | loop-guard.ts, processor.ts |
| C2 (P1) | stevo-handler persiste tool_calls (rota ~97% do tráfego não persistia → falhas de tool indiagnosticáveis, caso Bianca) | webhook/stevo-handler.ts |
| C3 (P1) | schedule_message_to_contact: dedup determinístico (rep+location+horário+contato+texto) → idempotente (caso Gustavo dup) | tools/messages.ts |
| C4 (P1) | `buildProcessorConfig` helper único nas 3 rotas; a rota Stevo passa a ler agent_configs (antes hardcoded → A5 inerte + edições não chegavam ao WhatsApp). enable_* default true (áudio load-bearing; config corrigido em prod) | core/processor-config.ts (novo), webhook-handler.ts, stevo-handler.ts |
| C6 (P2) | call_usage + cache_creation_tokens nos error paths do llm-client + call_usage no dispatcher proativo (fecha os gaps do B0) | llm-client.ts, dispatcher.ts |

Testes: `scripts/test-ultra-review-fixes.ts` **25/25** · ur1 25/25 · ur2 33/33 · wave-a 43/43 · takeover 36/36 · weekday 28/28 · tsc 0 · build OK.

**Deferido (P2 documentado):** limpeza das 8 linhas de prompt que instruem tools desligadas — o Anthropic constrange tool_use ao catálogo (o modelo não emite tool não-declarada), então é texto morto, não crash. Follow-up de dieta de prompt, não urgente.

## 👤 Decisões do Pedro (do ultra-review)

1. **Melissa**: avisar/reexecutar o pedido da Rina (marcar terça 28/07 19h + mover esteira) — engolido pelo falso positivo.
2. **Resumo matinal 8→1**: verificar HOJE ~11-12Z se dispara (não é o A4/haiku — é starvation pré-existente no cron scheduled: `shouldFireCron` só passa no minuto exato 8:00 local e o loop não cobre todos os reps a tempo). Se repetir, instrumentar skip por-rep.
3. **Jussara working_hours quebrado** (128 signals/10h): decidir enabled=false (não quer expediente) ou preencher schedule. Config foi re-quebrada pelo update de 20/07 18:43Z — investigar origem.
4. **Alves Cury/Raquel (sonnet-5) zero tráfego desde 07-17**: confirmar se os targeting_skip de áudio/mídia são intencionais (regra é message-contains texto; lead que abre com áudio é dropado 100%) ou bug. A3 (pricing sonnet-5) segue não-validado E2E — rodar 1 conversa de teste.
5. **Fabiana 7pXJ**: recarga precisa ser maior (ciclo recarga-pequena→drena 6×) + rota de colisão com o cap $100 (MTD $60,59). Alerta em 80% do cap (TODO em isMonthlyCapReached).
6. **Cap NULL** em qz19/8DLM/b1tt (top gasto sem teto) — backfill $100 caso a caso (qz19 pode ser o hub).

## Follow-ups de código (P2, não-urgentes)
- Limpeza do prompt (8 linhas de tools desligadas) condicional a disabled_tools.
- weekday-guard (H50) estender a schedule_message_to_contact/schedule_reminder (o dedup C3 pega a duplicata; o dia-errado ainda depende do LLM computar a data).
- H50 no CONFIRM (label do present_options de agendamento com weekday validado — casos Daniely/Leonela).
- notifyWalletBlockOwnerOnce a partir de um cron (6 de 8 locations bloqueadas nunca notificaram a dona).
- write-off de $2,47 presos em retry eterno (2 locations inativas, "Location is not active").
