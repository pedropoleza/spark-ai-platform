# Horizon (Five Star Ricos) — Setup IA-first pós-reunião 2026-08-03

> Reunião Pedro + Roberta/Marcia/Pri/Lauany (transcript em ~/Downloads/transcript Marcia.txt). Decisão central: **a IA assume o atendimento DO INÍCIO** (o workflow de welcome sai de cena) e manda o **áudio da Marcia** na abertura. Agente `7c0a72b7…` segue INATIVO até o flip.

## Aplicado (2026-08-03, tudo config — visível no /hub)

| # | Item | Como ficou |
|---|------|------------|
| 1 | **Áudio de abertura** | `.wav` da Marcia (70s, benefício em vida) convertido pra ogg/opus (284KB) → bucket `agent-media/7c0a72b7…/abertura-marcia.ogg` + `media_library` `bf9fb113-e6a0…` (1ª mídia da frota). Automation `ai_activated` → `send_media` = o áudio sai logo após a 1ª resposta da IA (1×/conversa, dedup nativo). Rota GHL→SparkZap manda áudio com **ptt=true** = voice note de verdade. |
| 2 | **Prompt v4 (IA-first)** | Override reescrito (9,5K): seção ABERTURA (apresentação + resumo escrito 1-2 frases + "tô te mandando um audiozinho 🎧" + já pede o 1º dado), **um dado por vez** (nascimento → estado → fumante; NUNCA bloco), **data por extenso "mês, dia e ano"** (pedido da Lauany), compliance/preço/handoff/estilo mantidos do v3. Regras da era "equipe manda welcome" removidas. |
| 3 | **Follow-up religado (cadência da reunião)** | `min_delay=60` + `intensity=2` + `max_attempts=3` → toques em **1h → ~27h → 7d**. `custom_prompt`: curto (≤20 palavras), cobra só o dado pendente ("Tô esperando sua data de nascimento pra já adiantar sua cotação 😊"), qualificado→cobra horário, nada mudou→[[NAO_ENVIAR]]. |
| 4 | **Buffer de 1h no agendamento** | Calendário "1.1 - Primeiro Encontro" (`14aj8DKX…`): `allowBookingAfter 0→1 hora` via API — free-slots (e o guard H58) já respeitam. + regra no prompt. |
| 5 | **Funil automático** | Automations no agente: 1º dado coletado (`contact.dateOfBirth`) → opp pra **In Contact** (`144fb041…`); `qualified` → **Qualified** (`ba0e215d…`); `booked` → **First Meeting Booked** (`310f75bc…`) — pipeline 1- Prospects `wTZmNZDlhSBeYBAtokVk`. (`create_opportunity` move se existe, cria se não.) |
| 6 | **Targeting sem depender do workflow** | v2 match-any: as 7 frases OFICIAIS dos anúncios/publis (mandadas pelo Pedro 03/08 — "Vim pelo Matheus", "Video do Matheus", "Quero entender como funciona o seguro…", "Quero organizar meu futuro financeiro…", "proteger minha família…", "Tenho interesse e queria mais…", "Seguro de Vida com benefícios em vida") via substrings robustos a acento/espaço-duplo + o wrapper "Veio de anúncio" (pega QUALQUER clique CTWA) OU tag `ai qualification active` (ativação manual da equipe segue valendo). Provado contra o matcher real: 13/13 (7 frases + wrapper ✅, "Oi tudo bem?/Paguei/Obrigada" não ativam). `trigger_once` mantido. |
| 7 | **Gate de anúncio desligado** | `suppress_ad_context_turn=false` — no modo IA-first a mensagem do clique é a DEIXA da abertura, não duplicação. (O gate H61 segue disponível pra contas workflow-first.) |

Script de setup/probe: `scripts/setup-horizon-ia-first.ts` (idempotente; `--set-buffer` aplica a janela do calendário).

## FLIP FEITO — 2026-08-04 00:52 UTC ✅

1. Pedro desligou o workflow de boas-vindas no Spark Leads (03/08 ~20h).
2. **Bateria pré-ativação (pedido do Pedro "make sure"):**
   - **Mecânica 48/48** (`scripts/battery-horizon-flip.ts`, roda contra origin/main + config real): prompt v4 montado pela `buildSystemPrompt` de prod com todas as seções (e zero resquício da era workflow); automations disparando nas funções reais; áudio baixável do bucket byte-a-byte; `allowBookingAfter=1h` confirmado na API; targeting 12/12 no gate real (7 frases oficiais + wrapper + 4 negativos); follow-up 1h → 26,7h → 7d pela fórmula de prod.
   - **Achado CRÍTICO da bateria**: o H62 (af00320, sessão paralela 03/08) substituiu o evento `ai_activated` pelo kind `agent_activated` — a automation do áudio como configurada NUNCA dispararia. Trigger migrado pro kind novo ANTES da ativação. (É por isso que se testa.)
   - **51 follow-ups pendentes da era antiga cancelados** (3º toques de leads 28/07–01/08 que a equipe já atendeu na mão).
   - **Simulação LLM (workflow 10 agentes, prompt real): 5/5 personas aprovadas** (click-prefill, pergunta própria no wrapper, dados de uma vez + "meia hora" fora do buffer, cético de preço, quer humano). 2 notas menores do cético (re-pedido quase verbatim; preço em 2 frases no 2º push) → polimento aplicado no prompt ("reformule, nunca repita a mesma frase/exemplo").
3. **Agente ATIVADO por mim (autorização do Pedro) — `status='active'` 2026-08-04 00:52:57 UTC.**

## Dia 1 (2026-08-04) — incidente de fuso + H66

Queixas da Roberta 12:06 ET: (1) "IA falando com quem já estava em conversação — já resolveram?" → **medido: ZERO sobreposição** desde a reativação (nenhum contato atendido pela equipe na janela off recebeu msg da IA; guards pausando — a queixa era da era pré-fix). (2) **Agendamento divergente (+1 267 746-0787)**: IA falou "1:00 PM ET" e emitiu ISO `13:00:00-03:00` (Brasília) → agenda 12 PM ET. 1 de 4 bookings do dia. **H66 NO AR (commit `5eb82f1`, Ready)**: `coerceStartTimeToTimezone` no slot-guard — o wall-clock do ISO (o que o LLM FALOU) é mantido e o offset recalculado pro fuso da location (DST-aware), antes do guard H58, em book+reschedule; rastro `offset_coerced_from` no execution_log. + regra explícita de offset no prompt da conta. Dia 1 saudável no resto: 43 turnos, voice note disparando (13×), 4 bookings, funil movendo, 0 falhas de envio.

**Validação com leads reais (👤/🤝, primeiras horas):** `execution_log` deve mostrar `agent_activated_automation` success + reaction send_media sem erro (voice note chegando), `ad_context_softened` NÃO aparece (flag off), stages movendo (In Contact/Qualified/First Meeting Booked), zero "não consegui agendar" falso. Queixa-chave a vigiar: duplicação de abertura (não deve existir — workflow off).

## Pendentes (fora deste setup)

- **Recuperação dos ~2.4k New Leads antigos** (combinado na reunião): IA lê ~50 conversas/dia (na assinatura do Pedro se der) → classifica (fora dos EUA/não quer/fechou → Not Interested; parado recuperável → tag recuperação) → drip de retomada ~36-50/dia com mensagens variadas, IA continua quem responder. Precisa desenho próprio + go do Pedro (envio em massa).
- Template de aniversário (birthday) está vazio — Roberta/Marcia vão mandar texto/áudio.
- Guia fino de follow-up prometido pelas meninas (quando vier, refinar o custom_prompt).
- Instagram segue desconectado (decisão delas). Sync Five Rings via extensão OK (Pri).
