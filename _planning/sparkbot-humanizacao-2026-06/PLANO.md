# Plano de correções — Humanização & Orquestração do SparkBot

> Derivado do [ESTUDO.md](ESTUDO.md). 39 fixes brutos dos 4 sintetizadores, consolidados (dedup) em **5 ondas** por esforço × impacto. IDs originais entre parênteses.
> Princípio: **menos cerimônia + mais proatividade de valor + ligar o que já está construído.** Quase tudo é prompt/copy/flag ou build pequeno; poucos são features grandes.

---

## ONDA 1 — Naturalidade conversacional (quick wins; prompt/copy; dias) 🔥 começar aqui
O maior ganho de "humanização" por menos esforço. Tudo é prompt/copy.

| # | Fix | Esf. | Imp. | Onde |
|---|-----|------|------|------|
| 1.1 | **Nunca prefixar saudação/pergunta com o silence-warning.** Reescrever a copy ("⚠️ Último aviso, vou pausar" → "Sumiu hoje! Quando puder me dá um oi 😊") e suprimir o prefixo quando a base é bom-dia/post_meeting. *Pior tom, 7/7 segmentos.* (O-5, N-1) | small | high | `proactive/silence-gate.ts:24-31` + `reminder-runner.ts:208`/dispatcher |
| 1.2 | **Variar + throttlar o "Como foi a call?".** 4-5 variações curtas, tirar o menu colado, e consolidar em 1 proativo quando o rep tem ≥3 reuniões juntas. *Gerador #1 de ruído e do loop do silence-warning.* (O-4, N-4) | small | high | `proactive/system-rules.ts:56` + `dispatcher.ts:325` |
| 1.3 | **Matar o "quer criar um follow-up?" automático.** O "SEMPRE feche com próximo passo" vence o "varie" e gruda em toda resposta. Vira *exceção*, não regra. (N-2) | small | high | `conversational/templates.ts:32,44` + `next-steps.ts` + `modules/behavior.ts:31` |
| 1.4 | **Confirmar o DELTA, não o estado.** Proibir re-imprimir o fluxo/lista inteira a cada turno; confirma só o que mudou, re-imprime tudo só a pedido. (N-5) | small | high | `modules/behavior.ts:32` + `conversational/templates.ts:65-82` |
| 1.5 | **Detectar modo-rajada/lote.** 3+ ações do mesmo tipo no mesmo contato/sessão (ou msg repetida) → confirm curto sem upsell + oferecer lote ("me passa a lista que mando todos com 1 confirma"). (N-3, U-2) | medium | high | `conversational/turn-context.ts:172-185` + expor Bulk V2 |
| 1.6 | **Parar o ritual "slot bloqueado, confirmar mesmo assim?".** Aprender por-rep: após N forçados seguidos, agendar direto e avisar passivo ("marquei; tava em cima de outro compromisso, ok?"). *Atrito #1 do agendamento.* (B-1, U-4) | small | high | `tools/calendar.ts:86-148` + pref em `getSchedulingPref` |
| 1.7 | **Herdar o contato do contexto pós-call.** Rep responde só o stage ("waiting application") → vincular ao contato da pergunta, sem re-buscar. (U-3) | small | high | `prompt-builder.ts` + `reaction-engine.ts` |
| 1.8 | **Ack de processamento** em operações multi-passo ("deixa eu puxar isso, 1 minutinho"). *Silêncio é o que mais irrita.* (B-5, U-6) | small | high | `core/run-sparkbot-turn.ts` (loop de tool) |
| 1.9 | **Onboarding/termos não atropela o pedido real.** Reconhecer a intenção pendente ("vi que quer marcar o Zoom — só aceita rapidinho") e executar após aceite; compactar o muro. (U-5b) | small | high | `processor.ts` (gate de termos) + `terms.ts` |

## ONDA 2 — Confiança (fechar os furos; código pequeno; dias)
Falsas confirmações + estrago em cliente. Tudo já tem a estrutura, só falta fechar buraco.

| # | Fix | Esf. | Imp. | Onde |
|---|-----|------|------|------|
| 2.1 | **`commit_draft`/`apply_flow` no coherence-gate.** A família "message" não conhece as tools do orquestrador → o "8 mensagens agendadas ✅" da Jussara escapou da rede anti-alucinação. (C-1) | trivial | high | `core/coherence-gate.ts:95-98` |
| 2.2 | **Repeat-guard: lookback maior + confirmação-já-respondida.** Daniely clicou "Confirmar" 4× e o bot re-perguntava (eco fora da janela A-B-A). Se a última msg do rep foi confirmação, não re-emitir o mesmo `present_options`. (C-2) | small | high | `core/repeat-guard.ts:40-74` + `processor.ts` |
| 2.3 | **Guard de duplicata no `apply_flow`.** Jussara: "vc mandou 3 vezes a mesma mensagem". Checar fluxo-ativo existente antes de materializar + garantir a idempotência do ultra-review H41 ativa. (C-5) | small | high | `task-orchestrator/materializer.ts` |
| 2.4 | **`location not active` honesto + signal.** "Tua conta ainda não tá ativada — já avisei o Pedro" (não "problema de conexão") + signal por-location. *1ª impressão.* (B-2) | medium | high | `identity.ts:188-261` + recorder |
| 2.5 | **Dedup de contato assumido em 1 opção** ("achei um contato com esse telefone no nome de X — atualizo pra Y ou crio separado?"), nunca expor "duplicata". (B-3) | medium | med | `tools/contacts.ts` + error-map `prompt-builder.ts:662` |
| 2.6 | **Ambos os fusos no confirm quando rep≠contato** (validação code-side: "10:15 AM Florida / 11:15 AM SP"), linguagem de colega. (C-3, U-5) | medium | med | `modules/scheduling.ts` + `tools/calendar.ts` |

## ONDA 3 — Ligar o que JÁ existe (flags + rules seedadas) ⚡ altíssimo ROI
Construído e testado, só desligado. **O achado mais importante: só 2 de ~14 gatilhos proativos rodam.**

| # | Fix | Esf. | Imp. | Onde |
|---|-----|------|------|------|
| 3.1 | **Ligar `TASK_ORCHESTRATOR_ENABLED`** (resolve a Jussara — perda de fluxo + falsas confirmações). Validar 1 conversa real + avisar a Jussara. (O-7, U-9) | trivial | high | Vercel env (👤) |
| 3.2 | **Ligar as scheduled rules já seedadas** (Pipeline review, Resumo fim do dia) — `route.ts:156` hard-coda só "Resumo matinal"; as outras aparecem ativas no painel mas nunca disparam. Precisa da 4.1 antes. (O-2) | medium | high | `cron/sparkbot-proactive/route.ts:156-221` |
| 3.3 | **Completar o daily-briefing** — `tasks_pending=[]` e `deals_closed='(detalhar V2)'` são stubs hardcoded. Popular com dados reais + 1 linha de contexto por reunião. (O-6) | medium | med | `proactive/daily-briefing.ts:309-352` |
| 3.4 | **Rollout de campanhas em grupo (H40):** provisionar 1 instância Stevo dedicada + `GROUP_CAMPAIGNS_ENABLED=1`, validar 1 caso (Daniely/Matheus). (A-5) | small | med | operacional (👤) |

## ONDA 4 — Proatividade de valor (builds médios; 1-2 semanas)
O que transforma o bot de "operador de comando" em "assistente que ajuda no dia a dia".

| # | Fix | Esf. | Imp. | Onde |
|---|-----|------|------|------|
| 4.1 | **`get_account_pulse` — números da conta numa chamada** (opps por stage, paradas >N dias, no-shows da semana, close rate, novos). *Pedido #1 de orquestração, hoje inexistente.* Vira matéria-prima das rules da 3.2. (O-1) | medium | high | novo `tools/account-pulse.ts` |
| 4.2 | **Templates de mensagem nomeados** (`save`/`list`/`use_message_template` + tabela). Mata o pedido ×4 E a falsa-confirmação "já sei que é esse modelo". Reusa o interpolador do Bulk V2. (A-1, U-8, O-8) | medium | high | nova migration + `tools/templates.ts` |
| 4.3 | **Fuzzy/phonetic match no `search_contacts`** (top-2 "você quer dizer X?" em vez de "não achei"). *Trata transcrição de áudio ruim como condição normal.* (U-1) | medium | high | handler `search_contacts` |
| 4.4 | **Auto-oferecer lembrete/msg quando detecta data** numa nota (prova/deadline/aniversário). Só orquestração no prompt, tools já existem. (O-9) | small | med | `prompt-builder.ts` (seção notas) |
| 4.5 | **Resumo de funil/números no proativo** (estende o bom-dia/semanal com os dados da 4.1). (U-10) | medium | med | `reaction-engine.ts` / proactive |

## ONDA 5 — Capacidades grandes (planejar; precisam de design)
Alto valor, mais esforço. Avaliar 1 a 1 depois das ondas 1-4.

| # | Fix | Esf. | Imp. | Onde |
|---|-----|------|------|------|
| 5.1 | **Reactive `no_show` + `opportunity_stale`** (polling, reusa o padrão do post_meeting). Hoje processados 100% na mão. (O-3) | large | high | `route.ts:518-535` |
| 5.2 | **Inbox triage — varrer conversas sem resposta** na location ("quais conversas estão sem resposta hoje"). Feature "matadora" pedida e negada. (O-10, A-6, U-7) | large | high | nova tool + endpoint GHL conversations |
| 5.3 | **Extração de apólice (imagem→custom fields, depois PDF).** A visão já extrai; falta o write. Começar pela imagem. (A-2) | large | high | `file-processor.ts` + `tools/contacts.ts` |

---

## Resumo de prioridade
- **Maior impacto / menor esforço (fazer já):** 1.1, 1.2, 1.3, 1.6 (naturalidade) · 2.1, 2.2 (confiança) · 3.1 (flag orquestrador).
- **Desbloqueia o resto:** 4.1 (`get_account_pulse`) → habilita 3.2 + 4.5.
- **Mata capacidade-faltante + falsa-confirmação de uma vez:** 4.2 (templates).
- **Não construir:** suporte de UI navegável (email-opcional no form) — virar regra de escopo (A-4); web UI (morta).

## Itens que dependem de você (👤)
- Ligar `TASK_ORCHESTRATOR_ENABLED` (3.1) + provisionar instância Stevo dedicada p/ grupos (3.4).
- Decidir profundidade da Onda 5 (são os builds caros).
