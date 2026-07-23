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

## Follow-up sugerido (👤)
- Depois do deploy, re-rodar a query de distribuição em ~7 dias: `max_chars`
  deve cair de 787 pra ≤550 e `max_bubbles` subir >1 nos casos longos.
- Se quiser cap configurável por agente no futuro: expor
  `agent_configs.max_bubble_chars` (hoje é constante em `message-splitter.ts`).
