# Healthcheck — mensagens da IA de vendas · five star ricos (2026-07-23)

**Location:** `jA6uzx6tONyTeocxw4Cj` · **Agente ativo:** Agente de Vendas
(`7c0a72b7-e37c-463d-be56-73b7822a3037`, `sales_agent`, `claude-sonnet-4-6`,
follow-up `ai_auto` habilitado).

## Sintoma reportado
Pedro observou disparos/envios com "número massivo de caracteres" — mensagens
lead-facing saindo como paredão de texto.

## Diagnóstico (dados de prod, `execution_log.send_message`)

30 dias, canal principal:

| métrica | valor |
|---|---|
| mensagens | 361 |
| média chars | 226 |
| p50 | 158 |
| p90 | 523 |
| p99 | 714 |
| **max** | **787** |
| > 600 chars | 21 |
| bolhas por msg (max) | **1 (sempre)** |

Follow-ups: 37 msgs, max 339 chars (limpos).

**Causa-raiz:** o caminho lead-facing (`action-executor.ts` no fluxo principal e
`follow-up-scheduler.ts` no follow-up) enviava `response.message` **cru, sem
nenhuma guarda determinística de tamanho** — diferente do SparkBot, que já tem
cap de bolhas. O prompt de vendas só *sugeria* brevidade ("Mensagens curtas",
"1-2 frases"), mas o Sonnet ignorava e mandava um **parágrafo único de 700-800
chars numa só bolha** (`max_bubbles=1` em 100% dos casos — o modelo nunca usava
o array de bolhas que o schema oferece). No WhatsApp/SMS isso é um wall of text
que espanta o lead (e, se rotear pra SMS, vira ~5 segmentos).

## Correção aplicada

Mesma filosofia do `outbound-sanitizer` (caso Marina): **garantia
determinística no último passo antes de enviar, sem confiar no LLM.**

1. **`src/lib/ai/message-splitter.ts` (novo)** — `splitLeadOutbound()` quebra
   bolha acima de **550 chars** (deixa o p90=523 e a conversa normal intactos)
   em bolhas curtas (~300 chars), cortando SEMPRE em fim de frase, **sem perda
   de conteúdo** (lição H52/Andrea: excedente do teto de 5 bolhas é FUNDIDO na
   última, nunca `slice`-descartado). Fallback hard-split por espaço pra
   parágrafo sem pontuação. No-op pra mensagem já curta (paridade).
2. **`action-executor.ts`** — aplica o splitter depois do sanitizer; o loop de
   envio já entrega cada bolha como mensagem separada com delay. Audita
   `outbound_split`.
3. **`follow-up-scheduler.ts`** — helper `sendFollowUpMessage()` quebra e envia
   as bolhas (custom_message e IA); loga o array real de bolhas no
   `execution_log` (mantém anti-eco/thumbs/histórico funcionando).
4. **Prompt (`sales-prompt-builder.ts`)** — reforço secundário: REGRA 5
   (mensagens curtas, quebrar explicação longa em bolhas via array), FORMATO
   regra #1 mais diretiva e "SE FOR MANDAR" do follow-up.

**Additive/reversível:** sem bolha longa = comportamento idêntico ao de antes.

## Teste
`scripts/test-message-splitter.ts` (20/20) — reproduz o caso real de 787 chars,
prova zero perda de conteúdo, sem corte no meio de palavra, teto de bolhas,
bordas (vazio/whitespace/newlines). `tsc --noEmit` + `next build` verdes;
`test-outbound-sanitizer.ts` 16/16 (sem regressão).

---

# Parte 2 — Reclamações da cliente sobre FOLLOW-UP (2026-07-23)

A cliente relatou 3 pontos, todos confirmados nos dados de prod:

### (2a) Follow-up disparando cedo demais ("5 min depois que a pessoa chamou")
`scheduled_followups` mostrou attempt-1 sendo enviado **10-11 min** depois do
último inbound do lead (`min_after_lead_msg` = 10/11 em várias linhas). Causa: a
curva usa `minDelay` no attempt 1 (t=0) e o config antigo tinha `min_delay`
baixo. **Fix:** `FIRST_TOUCH_FLOOR_MIN = 60` em `scheduleFollowUps` (ai_auto) —
o 1º toque NUNCA sai antes de 1h, mesmo com config baixo. Modo manual (passos
explícitos do admin) fica isento.

### (2b) Mensagem de follow-up longa demais ("mais curto e certeiro")
Follow-ups reais tinham 96-339 chars com hedging empilhado ("...se não for o
momento, tudo bem também, sem pressão..."). A cliente quer 1 linha direta, ex:
"Olá, pode mandar os dados pra gente preparar uma cotação?". **Fix:** duplo —
(i) `condenseFollowUp()` determinístico (cap `FOLLOWUP_MAX_CHARS=260`, mantém
frases inteiras, follow-up é SEMPRE 1 bolha, nunca multi-bolha); (ii) prompt
base de follow-up reescrito pra "UMA frase curta e direta, sem hedging longo".
custom_message do admin é respeitado como está (não condensa o texto explícito
dele).

### (2c) IA mandando "textão" explicando o seguro depois de coletar os dados
Screenshot: depois de "vou deixar sua cotação pronta e a equipe te chama", a IA
mandou um parágrafo explicando o seguro (os leads de anúncio chegam pedindo
"quero entender como funciona" e a IA dava aula de 340-787 chars). **Fix:**
REGRA 6 no prompt de vendas — explicar produto em NO MÁXIMO 1-2 frases sempre
deferindo pro especialista, e DEPOIS de coletar/encerrar NÃO reabrir o pitch
nem mandar explicação. O splitter da Parte 1 continua como backstop de entrega.

### Config data (location afetado)
`min_delay_minutes` do Agente de Vendas mudado de **1440 (24h) → 60 (1h)** pra
bater com o que a cliente pediu ("1h depois está ótimo"). Restante do
`follow_up_config` preservado (max_attempts=3, max_delay=7d, custom_prompt).
Os 9 follow-ups já `pending` mantêm o schedule antigo (24h — seguro); os novos
usam 1h. Reversível: `jsonb_set(..., '{min_delay_minutes}', '1440')`.

## Follow-up sugerido (👤)
- Re-rodar em ~7 dias: `max_chars` do fluxo principal deve cair pra ≤550;
  follow-ups devem ficar ≤260 chars e disparar ≥60 min após o inbound.
- Cap configurável por agente no futuro: expor `agent_configs.max_bubble_chars`
  e `followup_max_chars` (hoje constantes em `message-splitter.ts`).
- O `FIRST_TOUCH_FLOOR_MIN=60` é global (ai_auto): se algum outro location
  quiser 1º toque < 1h, vira config per-agente.
