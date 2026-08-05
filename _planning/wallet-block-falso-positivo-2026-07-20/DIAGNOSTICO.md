# DIAGNÓSTICO — "Sem crédito" com crédito na conta (wallet-block H52) · 2026-07-20

> Pedro 2026-07-20: "muitas pessoas com crédito na conta recebendo 'sem crédito' no SparkBot — falha grave; analisar todos os casos". Método: 29 agentes (14 dossiês por location + 3 mecanismos + verificação adversarial + arquiteto de fix). Resultado bruto: workflow `wf_56bfffdc-dd6` (sessão ea9a4b09). Fix plan completo no fim.

## Resposta direta: "estava faltando crédito mesmo?"

**No INSTANTE de cada bloqueio: SIM — todos os 12 erros são 400 autênticos do GHL** ("Location wallet has insufficient funds", traceIds distintos). Não há bug de detecção do erro. **MAS em 5 casos o "sem saldo" era um dip de CENTAVOS minutos após cobrança OK** (jA6u bloqueada por **$0,011** 6min após OK; FyBa $0,14 4min40s após OK de $0,29; ZtvC $0,35 4,5min; YuR0/Alves Cury $0,18 22h após OK; 7SWf/Raquel $0,065 44min após OK) — wallets que vivem oscilando entre $0 e $10 (recarga típica $10; o GHL chega a ACEITAR cobrança com `balanceAtExecution=0` e rejeitar outra minutos depois).

**HOJE (o que importa pro cliente): o sistema não tem como saber — e é essa a falha grave.** Estado real por grupo:

| Grupo | Locations | Estado da wallet AGORA | Bloqueio |
|---|---|---|---|
| Insolventes reais (re-tentadas AGORA e falhando) | **b1tt** (Gustavo, $29,54, hasFunds:false) · **UxgO** (cobranças de 1,4 CENTAVO recusadas 23:20 UTC) · **yQ9O** (Natalia, $0,35 recusado) · **5XQL** ($0,39 recusado) | SEM saldo utilizável, provado ao vivo | **CORRETO** (essas 4 desbloqueiam sozinhas em ≤20min se recarregarem — estão na frente da fila) |
| **Famintas** (NUNCA re-tentadas desde o bloqueio) | **7SWf** (Raquel, 3,2 dias!) · **sDFb** (Danielle) · **ZtvC** (Bianca) · **CKkG** (Sidney) · **jA6u** (Priscila, 108 leads engolidos!) · **YuR0** (Alves Cury, Bruna+Bruno mudos desde 12:00) · **FyBa** (Daniel) | **INDETERMINADO** — zero cobranças re-testaram a wallet; recarga seria INVISÍVEL | **Possivelmente falso; sem caminho automático de saída hoje** |
| Escaparam | 7pXJ (3 ciclos flip-flop) · 8DLM (retry alcançou por SORTE record de 11/07) · pGl5 (Jussara — clear MANUAL 18/07, sem 💚 e SEM reenqueue dos 30 leads engolidos) | tinham saldo (recarregaram) | — |

⚠️ **hasFunds:true NÃO é prova de crédito** (achado refutado adversarialmente): o GET `/marketplace/billing/charges/has-funds` devolveu `true` pra UxgO/yQ9O/5XQL MINUTOS antes/depois de o próprio GHL recusar cobranças de centavos delas (logs de prod `vercel logs` ticks 23:20/23:25 UTC). Só serve como sinal fraco de triagem — **a única prova de solvência é uma cobrança real passando**.

## As 4 causas-raiz (todas confirmadas adversarialmente)

1. **FOME DE FILA no retry (P0)** — `claimUnbilledBatch` pega os 40 pendentes MAIS ANTIGOS da plataforma inteira (`usage-records.repo.ts:243`, created_at ASC global, claim falho preso 15-20min) → janela fixa de 160 slots dominada por ~148 registros perma-insolventes (b1tt 117 + yQ9O 18 + La46 6 + UxgO 5 + t60i 1 + 5XQL 1). Vazamento de só ~12 records/20min quando a frente está parcialmente cobrável — e **ZERO** quando 100% fundless (**07-19 passou o dia inteiro sem UMA cobrança de retry**). Fronteira nunca passou de created_at 07-12 21:11. As 7 famintas têm seus registros nas posições ~400-1039 da fila → dias a NUNCA. Projeção: os +143 fundless da b1tt re-saturam a janela em horas → deadlock total de novo.
2. **HAIR-TRIGGER (P0)** — `markWalletBlocked` dispara na 1ª falha, sem threshold de valor, sem N-falhas, sem checar cobrança OK recente, sem consultar saldo (`checkWalletBalance` é stub `return true` E dead code). FyBa: OK→block em 4min40s, rep avisado 9,5s depois. Combinado com o trap do auto-recharge GHL ("< $0" nunca dispara porque o GHL rejeita ANTES do saldo cruzar zero), dip transitório vira outage.
3. **DESBLOQUEIO SÓ POR COBRANÇA + gates matam as cobranças (P0)** — bloqueada ⇒ nenhum turno ⇒ nenhuma cobrança inline ⇒ só resta o retry faminto. Confirmado: ZERO usage_records nas 11 bloqueadas pós-bloqueio. (O desbloqueio automático EXISTE e funcionou 5× em 24h — mas só pra quem tem registro na frente da fila; latência real é bimodal: ≤20min ou dias-sem-teto.)
4. **NOTIFICAÇÕES QUEBRADAS (P0)** — `notifyWalletBlockOwnerOnce` só é chamada no gate lead-facing (`queue-processor.ts:369`) → 9/11 donas NUNCA souberam (b1tt $29,54 no escuro há 3 dias). Owner resolution = "não-internal que falou por último" sem filtrar terms_rejected/loop_guard → aviso de dona da 7pXJ foi **4× pra FABIANA CAMPOS, a rep-fantasma (bot!)** + 1× pro Gian. Rep-message sem cooldown (Melissa 2× em 48s; Jussara 6×; 33 msgs/17 reps). `clearWalletBlock` reseta `wallet_block_notified_at` → re-spam no flip-flop. Clear manual (pGl5 18/07) não emite 💚 nem roda `reenqueueWalletSwallowed` → 30 leads da Jussara mudos pra sempre.

## Dano concreto (replay manual necessário — nada disso se recria sozinho)

- **FyBa/Daniel**: reunião com **Ana Gusmão HOJE 17h EDT foi perdida** (o "Confirmar ✅" caiu no gate; appointment nunca criado).
- **8DLM/Caua**: reunião **Emesto (IUL Jairo Vantage, 973 704 5855) 23/07 20h EDT** — confirm nunca chegou ao LLM; criar antes de quarta.
- **YuR0/Marcos (Alves Cury)**: tarefa "ligar pra Sueli hoje 6pm" nunca criada + 1 lead de recrutamento (áudio pro Bruno) sem resposta.
- **jA6u**: **108 leads engolidos** (maior dano de leads). **pGl5/Jussara**: 30 skips 17-18/07 — o clear foi MANUAL (recovery de 18/07, memória do projeto) e o reenqueue foi feito à mão na época (11 conversas com último inbound pendente); auditar o delta 30−11 (as demais tinham atendimento humano). **7pXJ**: 20 skips a auditar. 
- **yQ9O/Natalia**: 3 lembretes (IRS/mentoria 20-22/07) nunca criados; re-mandou o mesmo áudio 2 dias seguidos.
- **b1tt/Gustavo**: 3 perguntas engolidas (E&O, recusa de cobertura, prova remarcada).
- **7SWf/Melissa (Raquel)**: operação de CRM morta no meio (lead Michele ficou sem stage no pipeline Vendas).

## Plano de correção (aprovado? — fases 0-3)

O plano completo do arquiteto (com arquivo:linha, riscos e rollback) está no output do workflow; resumo executivo:

- **Fase 0 — EMERGÊNCIA (hoje, ~1h)**: A0 snapshot de rollback → **A1 desbloquear as 7 famintas via `scripts/unblock-wallet.ts` chamando `clearWalletBlock()`** (NUNCA UPDATE cru — o clear oficial emite 💚 e re-enfileira leads engolidos ≤24h; risco auto-corretivo: se seca, re-bloqueia sozinha na 1ª cobrança) → **A2 `cap_blocked=true` nos ~148-302 fundless da frente** (destrava a fila; write-off reversível — decisão 👤) → A3 avisar donas b1tt/yQ9O/7pXJ à mão → A4 replays acima. **NÃO desbloquear** b1tt/UxgO/yQ9O/5XQL (insolvência provada ao vivo).
- **Fase 1 — Deploy 1 (mata o bloqueio eterno, sem migration)**: **B1 probe-charge on-demand no gate** (inbound em location bloqueada → tenta cobrar 1 pendente ANTES de responder "sem crédito"; passou → clear + processa o turno; eventId idempotente; cooldown 60s) + B3 backoff por-location no loop do retry (1ª falha da location no run → pula o resto dela; derruba ~10,6k GHL 400/dia em ~40×) + B5 sinais 💳/💚 com await + D3 cooldown 4h do rep-message.
- **Fase 2 — Deploy 2**: B2 RPC fairness no claim (`ROW_NUMBER() PARTITION BY location_id ≤3`, migration; recarga detectada ≤5-20min pra TODOS) + C trigger com grace (não bloquear se cobrança OK <60min; 2ª falha em ≥30min; has-funds só como acelerador de bloqueio — `false` é confiável pra bloquear, `true` NÃO é pra desbloquear) + D1/D2/D4 notificações (notify no momento do bloqueio; owner por role com filtro de fantasma; não resetar notified_at).
- **Fase 3 — Higiene**: gate de wallet antes do Whisper (hoje transcreve e cobra áudio de location bloqueada), monitor "bloqueada >24h sem cobrança tentada", runbook do desbloqueio manual, logar `maxDailyUnits` (meter tem `executionLimitPerCycle=2000`; A62s fez 2.635/30d — risco separado), copy orientando auto-recharge com threshold >$5.

**Decisões 👤**: autorizar A1 (recomendo SIM) · A2 write-off (inclui $29,54 da b1tt) · política de dívida b1tt · micro-charge $0,01 como probe quando não há pendente · comunicação aos afetados (Alves Cury, Raquel, Gustavo, Natalia, Gian) · calibrar grace do trigger.
