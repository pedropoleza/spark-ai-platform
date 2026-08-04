# Ultra-review de plataforma — 2026-08-03/04

**Método:** 34 agentes / 10 dimensões sobre dados reais de prod (janela 28/07→04/08, 766 queries SELECT-only) + verificação adversarial dos P0/P1 (23 verificados: 18 confirmados, 5 refutados no núcleo ou na severidade). Dimensões: conversas SparkBot · atendimentos lead-facing · admin_signals · erros de execução · entrega SparkZap · billing/custo · filas/crons · configs de agentes · regressão dos deploys (H60-H63) · segurança · ideias.

---

## O que está SAUDÁVEL (com números)

- **Billing barateando:** $98.85 de custo / $108.73 cobrado em 3.027 calls (semana anterior: $119.34/$131.27 em 2.611) — custo/call **−28%**. Cobrança 7d saudável pós-H60.
- **Filas/crons:** 10/10 pg_cron vivos, 0 falhas em 24h; fila lead-facing limpa (0 mensagens travadas); claims de billing sem órfãos.
- **Qualidade LLM:** 0,98% de erro em 8.410 execuções; **zero mudez inbound por LLM** (o 1 caso real foi entrega). H45 funcionando (resolução fuzzy acertando por telefone), H50 salvando datas narradas erradas, H58 segurando bookings falsos, trigger_once (H51) aplicado nos 7 agentes por frase.
- **H60 VALIDADO em prod:** 18 insufficient-funds na pGl5 SEM bloqueio (carência agindo); auto-drain + retry recuperando.
- **Entrega global** (leads, via fila do OS): 92,6% sent (8.929/9.644), p50 1,3s.
- **Higiene de dados:** zero telefones duplicados (196 E.164 válidos), zero conversation_state órfão.

---

## FRENTE 1 (P0) — Entrega SparkZap: a causa dominante da semana

Um problema, muitas caras. Desde o cutover (29/07) e a remoção do Stevo (03/08), o degrau de resgate sumiu e as falhas do engine ficaram expostas:

1. **Canal proativo ~70% morto** desde 29/07: 122/510 envios SparkZap com `delivery_failed` (100% WuzAPI **erro 479**), sendo **121/172 proativas (70,3%)**. Série diária: 28/07 1/34 → 29/07 23/30 → 30/07 30/32... Perdidos: 57 pós-reunião, 18 resumos matinais, 18 lembretes pedidos pelo rep, 21 avisos de wallet. Caso citável: Natalia Freguglia perdeu o resumo matinal **6 dias seguidos** + lembretes pessoais ("Café com a Marina"). O hub perde **23,6%** de tudo que envia (122 dead / 395 sent).
2. **Handoffs "lead pediu humano" perdidos** — os 3 da janela (todos da Jussara Ferreira) falharam com 479; caso **Mila**: "acabei fechando com outra pessoa" nunca chegou à rep = **negócio comprovadamente perdido**. Agravante: o cooldown de 4h é gravado ANTES da entrega confirmar → sem reenvio.
3. **Silence-gate pausando reps por silêncio FANTASMA:** 11 pausas em 7d (vs ~1 na semana anterior) — Daniely Jones e Jussara (top-5 de uso, falam com o bot todo dia) pausadas porque as proativas que "ignoraram" nunca chegaram. O próprio warning "tô te vendo sumido 👀" falhou entrega.
4. **Classes de falha SEM retry no OS:** `number_paused` — location H09Ht (venda+recrut ativos) queimou **152 mensagens para 152 leads** em 03/08, attempts=0; `number_logged_out` — 259 msgs/189 destinos em 7d, 5+ locations, ainda ocorrendo (madrugada de 04/08, location da Daniely). E classe nova `send_budget_exceeded` além do 479.
5. **Ninguém foi avisado:** o sinal high "resposta não chegou ao corretor" acumulou 119 ocorrências por 6 dias — `last_alerted_at` NULL (ver Frente 6).

**Fix (spark-os, chip já criado + ampliar):** (a) 479 → resolver `wa_lid_map` phone→LID no envio; (b) 479/number_paused/logged_out → retryable com backoff + realimentar a plataforma (não marcar completed); (c) espaçar disparos de cron (rajada no mesmo segundo derruba o WuzAPI); (d) `silence-gate`: NÃO contar proativa `delivery_failed` como ignorada + reset das 11 pausas fantasmas após o fix; (e) `handoff-notify`: gravar cooldown só após entrega confirmada + reenviar os handoffs perdidos ainda acionáveis; (f) sessão H09Ht: despausar o número no SparkZap (👤) e reprocessar.

## FRENTE 2 (P0) — Motor de follow-up rep-side MORTO desde 29/07

`followup-runner` com **head-of-line blocking**: o SELECT (ORDER BY scheduled_at ASC LIMIT 60) fica entupido por 62 mensagens-lixo de sequências mortas que nunca saem da frente — nada atrás delas roda. Falha 100% silenciosa (cron "roda com sucesso"). Fix: filtro server-side de status da sequência no SELECT + marcar as 62 como terminais + sinal quando o tick processa 0 com backlog > 0.

## FRENTE 3 (P1) — Agendamento lead-facing: guard segura, mas a experiência flui mal

- **Legacy Agency (KtMB): 2 dias sem conseguir marcar NENHUMA reunião** — 10× GHL 422 "user id not part of calendar team". O fix H42 resolve o assignee pra admin; esse rep tem `role='user'` e fica fora do fix. Estender H42 a role=user (resolver o dono do calendário sempre que o assignee não pertence ao time).
- **Oferta de horário desalinhada da agenda real:** 52 bloqueios do guard H58 em 7d (4 agentes) — o lead vive "Tá marcado ✅"→"Desculpa, não consegui" (caso Sildimar, pGl5, PÓS-H61 v2). O guard evita o booking falso, mas o bot oferece slot que não existe → flip-flop. Fix: oferta SEMPRE a partir de free-slots do turno (fonte única), e a troca de mensagem do guard virar UMA mensagem coerente (não contradição em 2 bolhas).
- **`reschedule_appointment` com calendarId vazio** → 422 (3×, 2 agentes). **`move_pipeline` recebendo NOME de pipeline como id** → falha silenciosa, funil nunca anda (7 falhas, 2 agentes + automações Maria/Marina/Gian com nome inexistente). **Marina: 3 turnos mortos por "Contact not found"** (contato deletado/merged minutos após o inbound) — sem retry nem fallback.

## FRENTE 4 (P1) — Operação em lote via chat morre em timeout

Caso Claudia Fehribach: pediu **4× em 5 dias** pra tirar ~95 clientes de 2 automações; turnos morrem em timeout ("Tive um problema técnico"), 3/190 tags removidas — e a carteira dela segue nas automações que mandou desligar. Caso Bernardo: reenvio pra 20 contatos prometido e turno morre sem disparar. Fix: tools batch server-side (`add/remove_tags_batch`, padrão `create_appointments_batch`/H42, budget 40s + retorno parcial + retomada) — o orquestrador H41 já tem draft persistente pra ancorar. **Recovery manual da Claudia: rodar a limpeza dos 95 e avisar (👤 confirmar lista).**

## FRENTE 5 (P1) — Wallet: os próximos incidentes já têm nome

- **pGl5 (Jussara, a location mais ativa) entrou em carência HOJE** (18 falhas, $0.34 de débito) — no ritmo dela estoura o teto de $2 em ~1-2 dias → bloqueio. E a **dona não sabe**: a carência é silenciosa por design. Fix: aviso "saldo acabou, tô segurando na cortesia" à dona NA PRIMEIRA falha (sem bloquear). 👤 recarga/aviso à Jussara HOJE.
- **Gustavo Couto (top-2) preso em wallet-block há 4 dias** com estado inconsistente da location — notas de reunião e 5 lembretes engolidos. 👤 decidir: recarga do cliente ou desbloqueio em carência (`scripts/wallet-unblock.ts`).
- **jA6u (Five Star) flapping:** 5 ciclos bloqueio→recarga em 12 dias — recargas pequenas. 👤 sugerir auto-recharge maior. **5XQ:** 17 dias bloqueada — decidir churn × cobrança.

## FRENTE 6 (P1) — Observabilidade: o sistema grita e ninguém ouve

- **454 sinais, 0 pushes na história** (`last_alerted_at` NULL em 100%) — **190 high/critical nunca alertaram**, incluindo o critical ativo. 👤 setar `ALERT_DISCORD_WEBHOOK` (5 min) — é o multiplicador de TODAS as outras frentes.
- **Dead-man "inbound MUDO" virou alarme de lobo:** 4.808 disparos desde 18/06 (threshold errado pra madrugada) — recalibrar antes de ligar o push, senão vira spam.
- **Bug de 17 dias:** TypeError em `handoff-notify.ts:76` (`leadCtx.opportunities` undefined) — 480 ocorrências em 3 fingerprints, notificações de handoff se perdendo. Fix de 1 linha (guard).
- **Anti-eco H56 não cobre `send_error_message`:** o próprio "posso sugerir outro horário?" do bot não grava message_id → F52 lê como humano → **bot ignora a resposta do lead** à pergunta que ele mesmo fez. Fix: capturar message_id nos 2 branches restantes do action-executor.

## Refutados pela verificação (não agir)

- "19 falsas confirmações entregues ao lead" → eram confirmações **BLOQUEADAS** pelo H58 (guard funcionando; o problema real é a oferta desalinhada, Frente 3).
- "Skips de wallet na jA6u = perda permanente" → o reenqueue pós-desbloqueio existe e rodou.
- "F52 pausou 2 leads da Marcia na 1ª hora" → interpretação errada dos eventos.
- "Lembretes de task duplicados entregam em dobro" → race de INSERT existe, dano não (dedup do runner segura); higiene P2.
- Raquel working_hours 09-17 → fato real, severidade exagerada (4/24 inbounds adiados; decisão de configuração, não bug).

## IDEIAS (top, sustentadas por dados)

1. **Ligar proativos que os dados já pagam**: "inbound não respondida", "lead esfriando", briefing — só 2 de ~14 regras rodam; o motor está ocioso e maduro.
2. **Resumo de reunião → nota no contato** (ingest Fathom/Zoom): 3 pedidos em 48h no missed_capability.
3. **Dedup/merge assistido de contatos:** 51% dos create_contact batem em duplicata.
4. **Digest semanal de leads mortos sem follow-up** + knob de agressividade por agente (22% booking rate; a maior perda está no silêncio pós-1ª conversa).
5. **Grupos de WhatsApp** (H46 replanejado) — maior demanda única do missed_capability.
6. **Fechar o loop de entrega OS↔plataforma:** o wa_outbox sabe o destino final de cada mensagem; a plataforma deveria consumir isso como status de 1ª classe (elimina a classe inteira "achou que entregou").
7. **Guard-hit ≠ falha na telemetria** (hoje os acertos dos guards poluem a taxa de erro).
8. **Matar/estacionar uso-zero:** web UI, guided outreach, recorrência standalone — concentrar no que roda.

## Ordem de execução recomendada

| # | Frente | Dono | Esforço |
|---|--------|------|---------|
| 0 | `ALERT_DISCORD_WEBHOOK` + recarga/aviso pGl5 + despausar número H09Ht | 👤 Pedro | minutos |
| 1 | Entrega SparkZap (479/LID + retry classes + silence-gate/handoff à prova de falha) | spark-os + plataforma | 1-2 sessões |
| 2 | Follow-up runner destravado (head-of-line) | plataforma | pequeno |
| 3 | Quick-fixes: handoff-notify TypeError, anti-eco send_error_message, H42 role=user, reschedule calendarId, move_pipeline por nome | plataforma | 1 sessão |
| 4 | Batch tools de CRM (caso Claudia) + recovery manual | plataforma | médio |
| 5 | Oferta de slot fonte-única (flip-flop do agendamento) | plataforma | médio |
