# EXECUÇÃO — Motor de Orquestração de Tarefas + Geração/Envio de Arquivos

> Pedro 2026-06-20. Plano de execução robusto pra levar o SparkBot a **orquestrar fluxos complexos
> de N etapas sem alucinar** + **gerar e enviar arquivos (PDF/apresentação)**. Caso real disparador:
> Jussara (corretora) tentou montar um fluxo de no-show de 40 dias, cíclico, com mídia, p/ 7 contatos,
> + pediu PDF — e o bot "não deu conta" + **mentiu que agendou** (7 contatos, 0 inserts).
> Base: `ESTUDO.md` (gap) + workflows `wufao7pv5`/`wbdj50gfe`/`w156z7ddo`. **Aguardando aprovação.**

---

## Visão
Transformar o SparkBot de "assistente que executa 1 ação por turno" em **orquestrador de tarefas
N-etapas que NUNCA mente sobre o que fez** e que sabe **gerar + entregar arquivos**.

**Princípio central (anti-alucinação):** *a tarefa é um OBJETO PERSISTENTE no DB, não uma lembrança
na janela de contexto.* Cada turno o bot (1) **relê** o objeto via tool read-only, (2) **muta** via
mutator determinístico que valida e devolve o **estado REAL** pós-mutação, (3) só afirma ao rep o que
veio **dentro desse retorno**. Sucesso, contagem e "agendado" saem do **count real de rows do INSERT**,
nunca da intenção do LLM. Isso fecha de uma vez os 2 buracos do caso Jussara: **L7** (perdeu o início
do fluxo porque nada foi persistido) e **L11** (narrou "agendado" pra 7 com ZERO inserts).

**Papel do LLM vs sistema:** o LLM PROPÕE conteúdo (copywriting, interpretar o pedido) e escolhe qual
mutator chamar; o SISTEMA DISPÕE estado, validação e verdade (persiste, valida, calcula scheduled_at
no fuso do rep, faz o INSERT atômico com rollback, conta as rows reais, aplica gate H8 e quiet-hours,
dispara via o runner idempotente). **Toda "memória de tarefa" é DB; toda "afirmação de sucesso" é
retorno de tool.**

---

## Viabilidade confirmada (o que já existe vs o que falta)
- **Enviar arquivo/mídia ao lead:** a infra **JÁ EXISTE** pra lead-facing — `reaction-engine.ts:200-228`
  (`send_media`) usa `media_library` → bucket Supabase `agent-media` → `createSignedUrl` → GHL
  `/conversations/messages` com `attachments:[url]`. Falta: **expor como tool on-demand** + **validar
  em prod** se chega como anexo nativo no WhatsApp (maior unknown). ⚠️ **Grupos e SparkBot-DM via Stevo
  NÃO têm mídia nativa** (só `/send/text|button|list`).
- **Gerar PDF:** viável no stack — **@react-pdf/renderer** (puro-JS, roda na Vercel sem Chromium, cabe
  no `maxDuration=60`), 1 página/seção por dia. Hospedagem: reusa bucket `agent-media`. Cuidado:
  bundlar 1 fonte TTF p/ acentos PT-BR.
- **Runtime de disparo:** **100% reuso** do Bulk V2 (`fireBulkRecipients`: claim atômico CAS,
  reclaim de órfãos, quiet-hours, `refreshJobCounters` como fonte única de "foram as 30?"). Zero runner novo.

---

## Pilares
1. **Orquestração honesta (peça-mãe):** rascunho persistente (`task_drafts` + `draft_steps` +
   `task_events`) como fonte da verdade + materializador atômico com count real. Generaliza por
   `draft.kind` (`followup_sequence` | `file_export` | `campaign`).
2. **Reuso do runtime (zero runner novo):** o draft materializa em `bulk_message_jobs`/`recipients` e
   delega o disparo ao `fireBulkRecipients`.
3. **Pause-on-reply:** reply do lead **mata** os passos restantes da sequência (hoje o runner não tem
   gate per-recipient de "respondeu desde o agendamento?" — load-bearing pro cíclico de 40 dias).
4. **Geração de arquivo (PDF):** `@react-pdf/renderer` → Buffer → `agent-media` → signed URL. Retorna
   **URL real**, nunca "gerei".
5. **Entrega de arquivo:** rota GHL `attachments` (já wired) exposta como tool on-demand — **pendente
   de probe em prod** (anexo nativo?).
6. **Confiabilidade / guard-rails:** flag própria OFF/log-first, gate H8, test-mode, parity, smoke.

---

## P0 — o que fecha os buracos vivos (vem primeiro)
1. **Honestidade de disparo (fecha L11):** `commit_draft` só reporta "agendado" a partir do nº de rows
   que o INSERT devolveu (`total_enqueued`, molde `bulk-messages-v2.ts:1117-1136`); 0 rows = bot diz 0;
   INSERT checa `error` + rollback do job pra `failed`. Regra de prompt à-prova-de-LLM: **toda afirmação
   de estado COPIA de um campo de tool_result no mesmo turno** — proibido derivar de intenção.
2. **Rascunho persistente (fecha L7):** `task_drafts` + `draft_steps` (sem clamp de 3) + `task_events`;
   `show_draft` relê o snapshot canônico no início de cada turno; status só transiciona via mutator.
3. **Pause-on-reply:** gate per-recipient no runner que checa inbound do contato desde o agendamento →
   reply marca os passos restantes como `skipped(lead_replied)`.

---

## Fases (ordenadas por dependência; tarefas 🤖 eu · 👤 você/time · 🤝 híbrido)

### F0 — Schema + flag + esqueleto (ZERO comportamento)
- 🤖 Migration aditiva (00115+): `task_drafts` (rep_id, location_id, kind, status `building|ready_for_review|materializing|materialized|failed`, meta jsonb), `draft_steps` (offset_days, send_time HH:MM, message_text, media_url/type, intra_day_delay_s, position, UNIQUE(draft_id,position)), `task_events` (append-only).
- 🤖 Flag `isTaskOrchestratorEnabled()` (espelha `isGroupCampaignsEnabled`), default OFF.
- 🤖 Registrar tools gated em `tools/index.ts`: `show_draft` (safe), `add/edit/remove/reorder/set_meta` (medium), `commit_draft` (high). Tipos em `src/types/account-assistant.ts`.
- **Saída:** tsc/build verdes; com flag OFF as tools NÃO aparecem em `getAllToolDefinitions`; zero mudança em prod.

### F1 — Mutators determinísticos + show_draft (montagem honesta)
- 🤖 `show_draft` (read-only, sempre executa): relê draft+steps, devolve snapshot numerado + "o que falta".
- 🤖 Mutators: recebem `draft_id`+1 mutação, **validam** (offset≥0, hora válida, cap ~60, dedup position), persistem, devolvem **lista recomputada + total + validações falhadas**; checam `result.error`+`affected` (molde `editSequence` core.ts:541-589). Mutação inválida = estado inalterado + erro estruturado, nunca sucesso falso.
- 🤖 Sistema converte `offset_days+send_time → scheduled_at` no **fuso do rep** (não o LLM — fecha L4).
- 🤝 Seção de prompt à-prova-de-LLM (Pedro revisa a copy). 🤖 `scripts/test-task-orchestrator.ts`.
- **Saída:** teste verde; **smoke L7**: montar 7 passos → nova sessão → "me mostra o fluxo" → bot relê do DB intacto.

### F2 — Materializador atômico (honestidade de disparo — P0 core)
- 🤖 `commit_draft` (risk:high, gate H8): instancia draft → `bulk_message_jobs`+`recipients` (mesmo INSERT do bulk v2), checa `insErr`+rollback, retorna `total_enqueued` real + `flow_decision`. **Nada de "agendei" antes do retorno.**
- 🤖 status só vira `materialized` dentro do materializador e só com count>0. 🤖 `get_task_progress` lê via `refreshJobCounters`.
- 🤝 Pedro valida 1 job real ponta-a-ponta. 🤖 Testes (0 rows→diz 0; insErr→rollback; count===DB).
- **Saída:** impossível o bot dizer "criada" sobre job que rolou back; count do retorno === rows no DB === o que o bot disse.

### F3 — Pause-on-reply (metade do P0, load-bearing pro cíclico)
- 🤖 Gate per-recipient no runner: antes do passo N, checa inbound desde `scheduled_at` (reusa o sinal que reseta `consecutive_proactive_without_reply`) → reply marca restantes `skipped(lead_replied)`.
- 🤝 Pedro decide a **fonte canônica** do "last inbound" + window + se reply também notifica o rep (handoff). 🤖 Audit + teste.
- **Saída:** inbound no meio interrompe os passos futuros; fail-soft (erro ao checar não trava o runner).

### F4 — Geração de PDF (`draft.kind='file_export'`)
- 🤖 `@react-pdf/renderer` + fonte TTF (Font.register p/ acentos). 🤖 `pdf/flow-pdf.tsx` (1 página/dia, renderToBuffer).
- 🤖 Upload em `agent-media` (espelha `api/media/route.ts`) → `createSignedUrl`. 🤖 Tool `generate_flow_pdf` retorna **URL real**.
- 🤝 Pedro decide TTL do signed URL (600s→~3600s) + confirmar que o bucket existe no painel.
- **Saída:** PDF com acentos certos, dentro do maxDuration, tool retorna URL que baixa o arquivo.

### F5 — Entrega de arquivo on-demand + validação do anexo nativo (o unknown)
- 🤖 Tool `send_media_to_contact` (reusa `reaction-engine` send_media → GHL attachments).
- 👤 **PROBE EM PROD (bloqueante):** enviar 1 PDF de teste e ver no WhatsApp se chega como **anexo nativo** ou só caption/link. Não há teste no repo.
- 🤝 Tratar janela 24h/opt-in. 🤖 Documentar limitação: grupos + DM-Stevo não têm mídia nativa.
- **Saída:** veredito do probe registrado em DECISIONS; se OK, Jussara recebe o arquivo; se não, fallback link documentado.

### F6 — Template desacoplado + recorrência (caso Jussara completo: 7 contatos, cíclico)
- 🤖 `sequence_templates` (fluxo salvo 1x, aplicável a N contatos) + `apply_template_to_contact` (risk:high).
- 🤝 Pedro decide: cíclico de 40 dias = recorrência verdadeira (cron) ou sequência finita de 40 offsets.
- 🤖 Tag-trigger **MANUAL** no MVP; gatilho automático ("tag no-show → dispara") só atrás de flag+smoke (risco spam/ban, lição H40).
- **Saída:** template aplicado a 7 contatos = 7 materializações com count real; reply de 1 pausa só a dele; caso Jussara ponta-a-ponta em smoke.

---

## Guard-rails (padrão da casa)
- **Flag própria OFF/log-first** gateando o registro das tools — só liga após 1 caso real validado.
- **Gate H8** (confirmed_by_rep) no `commit_draft`/`apply_template`/`generate_pdf`/`send_media`.
- **Test-mode:** writes mockam `{simulated:true}`; reads sempre executam. Nunca bypass.
- **Honestidade = count real** (regra de prompt + INSERT checa error/affected + materialização atômica c/ rollback).
- **Parity vs legado:** o materializador produz as MESMAS rows do bulk v2 e delega ao mesmo runner (teste de paridade).
- **Anti-pattern Pedro 2026-05-28:** cruzar campo-a-campo com o bulk v2 (cap diário, variation_mode, smart window, coexistence) — marcar cada delta como decisão/bug/follow-up.
- **Smoke supervisionado** + **probe de anexo nativo** antes de abrir pra outros reps. **Audit append-only** pra honestidade retroativa.

---

## Decisões pro Pedro
1. **🔑 Anexo nativo (maior unknown):** topa um **probe em prod** (mandar 1 PDF de teste e ver se chega como anexo nativo no WhatsApp via Stevo) — isso define se "entrega de arquivo" fecha pra lead-facing. Quem roda?
2. **Ciclicidade da Jussara (40 dias):** recorrência verdadeira (cron) ou sequência finita de 40 offsets num draft? (muda o reuso).
3. **Pause-on-reply:** reply pausa só os passos futuros, ou também **notifica você/o rep** (handoff)? Qual a fonte do "last inbound" + janela?
4. **Tag-trigger automático** ("tag no-show → dispara"): manual no MVP e automático só depois (recomendo), ou já quer o automático (atrás de flag+smoke)?
5. **TTL do signed URL** (600s→~3600s) + confirmar que o **bucket `agent-media` existe** no painel.
6. **Escopo/ordem:** começo por **F0→F1→F2→F3** (a peça-mãe + honestidade + pause-on-reply, que já resolve o pior) e mídia/PDF (F4-F6) na sequência — ok?

## Top riscos
1. Anexo nativo não funcionar via SMS/Stevo (o código já alerta "SMS puro passa como caption") → probe é bloqueante.
2. Pause-on-reply mal-calibrado (atropela quem respondeu OU para cedo demais) → precisa smoke real.
3. Regressão silenciosa por não cruzar campos com o bulk v2 (anti-pattern histórico).
4. LLM alucinar contagem mesmo com objeto persistido se a regra de prompt não for à-prova → audit pega divergência.
5. Fonte TTF não-bundlada → acentos PT-BR quebram no PDF.
6. Spam/ban no cíclico 40d×7 contatos → tag-trigger manual/OFF até smoke.
7. Bucket `agent-media` não existir em prod (só documentado) → verificar antes de F4.
8. Escopo inflar ("motor de tudo") → MVP foca `followup_sequence` + `file_export`; `campaign`/custom depois.
