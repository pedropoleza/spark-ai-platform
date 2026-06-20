# PLANO — Sequências de Follow-up Grandes (caso Jussara)

> Pedro 2026-06-20. Plano de implementação (itens 3 e 5 do estudo). Base: `ESTUDO.md` +
> workflows `wufao7pv5` (pedidos/gap) e `wbdj50gfe` (arquitetura). **Status: aguardando
> decisões do Pedro antes de implementar.**

## Recomendação: MOTOR UNIFICADO (híbrido)

Nenhum dos dois motores cobre o fluxo da Jussara como está, por razões **opostas e complementares**:

- **Follow-up (H33)** tem a *alma certa* — criação 100% por chat, resolução de 1 contato,
  approval/spam gate — mas é **raso**: clamp duro de 3 msgs (4 lugares), timing por `offset_hours`
  de 1 base, texto puro, **zero rascunho persistente** (grava tudo no fim → impossível montar 40
  dias entre turnos; daí o "não salvei nada, só mentalmente").
- **Bulk-sequences (H28)** tem o *runtime pago em prod* — claim atômico CAS, state-machine multi-step
  (até 10), recorrência real por cron, pause-on-reply em massa, reclaim/heartbeat/cap — mas a
  **criação é só via UI HTTP** (nenhuma tool de chat insere sequência), o alvo é por **segmento/tag**
  (não per-contato), e o delay é `delay_days` inteiro (sem intra-dia, sem mídia).

**Caminho:** construir a **camada de criação/modelo nova** (rascunho persistente per-contato, montado
por chat, schema de passo rico) e **reusar o runtime de execução do bulk** (não escrever runner novo).
Não recauchutar o followup in-place (beco sem saída), nem montar tudo sobre o bulk cru.

---

## P0 — shippar ANTES da feature grande (não dependem do motor novo)

1. **🔴 Honestidade de disparo (L11).** Hoje o bot diz "agendado" sem agendar (admissão verbatim,
   `conversa-raw.txt:1599`). A Jussara acha que disparou 7 fluxos; **saiu zero**. Fix: (a) regra de
   prompt — só afirma "agendado/marquei" a partir do **retorno de sucesso** da tool, nunca da intenção;
   (b) gate determinístico que reflete o **count real** de inserts; (c) 👤 **decisão operacional:
   avisar a Jussara que os 7 não saíram.**
2. **🟠 Ingestão de reply/citação (L10) — mínimo.** Quando ela responde citando bloco + "aqui"/"ta bom",
   o parser Stevo perde o trecho citado → instruções dela somem no meio da montagem. O mínimo (não
   descartar o quoted context) precisa entrar junto, senão montar fluxo por chat é impraticável mesmo
   com rascunho persistente.
3. **Sanidade do clamp atual:** enquanto a v1 não sobe, o followup NÃO deve afirmar suportar 20+ passos
   (evitar nova falsa-promessa). Mensagem honesta de capacidade.

---

## MVP — a peça-mãe + confiança (texto, sem mídia/intra-dia/ciclo)

**Objetivo:** o SparkBot monta por chat, ao longo de vários turnos **sem perder o início**, uma
sequência de **N passos (texto)** per-contato, com **agendamento dia-relativo por passo**; salva como
**template reusável** aplicável a vários contatos; e dispara com **honestidade**. Resolve o essencial
do caso Jussara (montar + reaplicar + confiar).

**Mudanças:**
- **Rascunho persistente (L7 — peça-mãe):** tabela `sequence_drafts` (1 row/sequência em construção,
  dona=rep_id) + `draft_steps` (`offset_days` INT, `hora` HH:MM, `message_text`, `position`). Tools de
  chat `add_step`/`edit_step`/`remove_step`/`show_draft` que **leem e editam o store entre turnos** (o
  bot opera sobre o objeto, não "lembra"). N passos, cap defensivo alto (~60), sem clamp de 3.
- **Scheduler dia-relativo por passo (L4):** cada passo agenda em `base + offset_days` na `hora` do
  passo (timezone do rep). Substitui o "offset_hours de 1 base" do followup.
- **Template reusável + (opcional) tag-trigger (L8):** ao aprovar, o draft vira `sequence_template`
  salvo 1x, aplicável a N contatos (`apply_template_to_contact` / a uma tag). Gatilho "tag no-show →
  dispara" reusa o seam do `reactive-trigger.ts` (F27.D), **atrás de flag + smoke supervisionado**.
- **Runtime reusado:** a execução instancia o template em rows físicas e roda pelo **claim atômico CAS
  + pause-on-reply + pacing/quiet-hours** que já existem (bulk-message-runner / bulk_message_sequence_state).
  **Não escrever runner novo.** Reclaim de órfãos/heartbeat/cap de graça.
- **Honestidade de disparo** embutida (do P0).
- **Feature flag própria** (default OFF / log-first) gateando o registro das tools; tool de disparo e
  de aplicar-a-tag = `risk:high` (gate H8).

---

## Fases seguintes (escalonadas, isoladas por dor)

| Fase | Entrega | Resolve |
|------|---------|---------|
| **F2 — Mídia nativa** | coluna `media_url`/tipo no passo+recipient + envio que POSTa anexo (não só URL no texto) | L2 — vídeo/imagem/Vimeo/IG por dia |
| **F3 — Multi-msg/dia + intra-dia** | vários passos no mesmo `offset_days` com delay em min/seg | L3 — "Dia 0 = 3 msgs +30s", "Dia 10 +2min" |
| **F4 — Cíclico/evergreen** | loop real passo-40→passo-1 na mesma sequência (hoje `completed` é terminal) | L5 — "volta ao dia 1" + bloco semanal |
| **F5 — Branching condicional** | "se não respondeu no dia X faz Y" além do pause-on-reply binário | L6 |
| **F6 — Export PDF + copy assistido** | "me manda em PDF" (skill pdf) + gerar/melhorar texto por vídeo | L9 |
| **F7 — Reply/citação completo** | fix completo do parser Stevo de quoted message | L10 (resto) |

---

## Decisões pro Pedro (bloqueiam o início)

1. **Qual versão do fluxo é a OFICIAL?** Ela ditou **duas sobrepostas**: a **LIMPA** de 8 toques
   (Dia 0/1/2/4/7/10/15/30, com link de agenda — foi a que mandou disparar) **cabe no MVP** (texto +
   dia-relativo); a **DETALHADA** (com bloco semanal + 3-msgs/dia + 40 dias de vídeos) exige F2/F3/F4.
   Qual amarro como canônica?
2. **Escopo do MVP:** confirmar "**persistência + templates + honestidade primeiro; mídia/cíclico/
   PDF/intra-dia depois**". Pra Jussara isso significa que **na v1 não saem os vídeos nem o "Dia 0 = 3
   msgs"**. OK lançar parcial e iterar, ou ela precisa de **mídia já na v1**?
3. **Tag-trigger automático** ("tag no-show → dispara"): reusa F27.D (hoje `PROACTIVE_EVENTS_ENABLED`
   OFF, sem smoke). Disparo automático em massa = risco de spam/ban. Ligar no MVP atrás de flag+smoke,
   ou deixar **aplicação MANUAL** ("aplica esse fluxo na Eliz") no MVP e o gatilho por tag só na fase seguinte?
4. **Tabela nova vs migrar o followup:** o motor novo cria tabela de passo rico (não estoura os
   clamps). Conviver os dois por um tempo (followup simples 1-3 + sequência grande), ou migrar o
   followup pro motor novo de uma vez?
5. **Canal:** é DM 1:1 via Stevo (não grupo) — confirmar que roda na rota Stevo existente do SparkBot,
   sem instância dedicada (diferente do H40).

---

## Top riscos
1. **Falsa-promessa reincidente** (L11): se o gate de honestidade não for determinístico/à-prova-de-prompt,
   o bot volta a "agendar" sem agendar. É P0, vem ANTES.
2. **Três modelos de "sequência" convivendo** (tabela nova + followup_messages + bulk_message_sequences)
   → drift + LLM escolhe a tool errada. Mitigar com roteamento claro + deprecação planejada do followup raso.
3. **Disparo automático por tag = vetor de spam/ban** (lição do H40). Flag + cap por execução + pacing;
   não abrir sem smoke supervisionado.
4. **Intra-dia/evergreen adiados quebram expectativa:** ela pediu explicitamente. Comunicar escopo
   ("isso é F3/F4") é parte do entregável, senão ela acha de novo que "não deu conta".
5. **Rascunho × janela de contexto:** o bot tem que reler o **objeto persistido**, não o transcript,
   senão volta a perder o início.
6. **Reply/citação quebrada sabota a montagem:** o rascunho não salva o que nunca chegou → o mínimo do
   L10 é P0.
