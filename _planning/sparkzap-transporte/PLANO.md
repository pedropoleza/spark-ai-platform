# H57 — SparkBot no SparkZap (transporte próprio de WhatsApp)

> **Data:** 2026-07-28 · **Status:** código NO AR atrás de flags, tudo OFF.
> **Pedido do Pedro:** "colocar o SparkBot dentro do nosso Engine de WhatsApp,
> que é o Spark Zap, porque o Stevo está com muito problema. Não precisa
> desconectar do Stevo. Deixa pronto pra depois eu implementar as mensagens com
> botão no SparkZap."
> **Doc canônico da arquitetura (lado Spark OS):**
> `spark-os/_planning/SPARKBOT_SPARKZAP_BRIDGE.md`.

## 1. O problema

O SparkBot fala com os corretores por um **white-label de painel (Stevo)** que:
não tem API de webhook (a URL de entrega é setting de painel — por isso o
apagão de 19h em 2026-06-17 só foi resolvido re-apontando à mão), muda formato
sem aviso (o tap de botão em 2 shapes, fix de 2026-06-18) e é SPOF de terceiro.

A Spark passou a ter engine própria — o **SparkZap** (fork WuzAPI/whatsmeow num
droplet, control plane no Spark OS). Ela já roda o inbox de suporte e os números
dos clientes. Falta o SparkBot.

## 2. Decisão: federação, não fusão

O banco do AI platform **continua separado** (`vyfkpdnwevtuxauacouj`). O Spark OS
vira o TRANSPORTE. Contrato = HTTP + bearer nos dois sentidos. Justificativa
completa no doc do OS (§1) — resumo: 117 migrations + pg_cron + billing acoplado
tornam a fusão de schema cara e arriscada, e o ganho que o Pedro quer HOJE
(sair do Stevo) a federação entrega inteiro.

**O token do WhatsApp nunca vem pra cá.** Mandamos "pra quem" e "o quê"; o OS
resolve sessão e credencial.

## 3. O que foi construído aqui

| Arquivo | Papel |
|---|---|
| `webhook/wa-transport.ts` | a CHAVE: `pickWaTransport(phone)` → `stevo` \| `sparkzap`, com allowlist de rollout por rep |
| `webhook/sparkzap-send.ts` | envio (texto/botão/lista) pela ponte do OS — mesmo `StevoSendResult` do `stevo-send.ts` |
| `webhook/sparkzap-parser.ts` | traduz o envelope do engine e **reusa o `parseStevoWebhook`** (um parser só) |
| `api/webhooks/spark-zap/route.ts` | rota de entrada, bearer `SPARKZAP_INBOUND_TOKEN`, fail-closed |
| `webhook/stevo-handler.ts` | despacho por transporte no bloco de envio (+ `sent_via` no audit) |
| `proactive/whatsapp-delivery.ts` | SparkZap-first → Stevo → Spark Leads (a escada existente vira rede de segurança) |
| `marina-daily.ts` | digest diário idem |
| `scripts/test-sparkzap-transport.ts` | 51/51 |

**O miolo não mudou**: idempotência de 7 camadas, gates H8/test-mode, billing,
silence tracking, termos — tudo no mesmo caminho (`handleStevoInbound`). O que
mudou foi a porta de entrada e a de saída.

## 4. Botão e lista

O SparkZap ainda não tem interativo homologado. Por isso:
- a ponte devolve **422 `unsupported`** quando `SPARKZAP_INTERACTIVE=0`;
- `sendSparkZapButton/List` marcam `unsupported: true`;
- o handler cai no **fallback de texto** que já existe (opções numeradas) — o
  rep nunca fica sem resposta.

Quando o Pedro ligar botões no SparkZap: `SPARKZAP_INTERACTIVE=1` no Spark OS.
Só isso — o payload já está escrito e testado dos dois lados.

## 5. Envs (todas OFF por padrão)

| Env | Onde | Default | O que faz |
|---|---|---|---|
| `SPARKBOT_WA_TRANSPORT` | AI platform | `stevo` | `sparkzap` liga o transporte novo |
| `SPARKZAP_REPS` | AI platform | vazio | allowlist E.164 (vírgula) do rollout; vazia = todos |
| `SPARK_OS_WA_URL` | AI platform | — | `https://spark-os-green.vercel.app/api/integrations/wa/agent-send` |
| `SPARK_OS_WA_TOKEN` | AI platform | — | bearer da fonte `sparkbot` (valor cru; o OS guarda o hash) |
| `SPARKZAP_INBOUND_TOKEN` | AI platform | — | bearer que a rota `/api/webhooks/spark-zap` exige |

Do lado do OS: `SPARKZAP_AGENT_SEND_ENABLED`, `SPARKBOT_ENGINE_SESSION`,
`SPARKZAP_INTERACTIVE`, `SPARKBOT_INBOUND_{MODE,URL,TOKEN}`.

## 6. Ordem de ligação (👤 Pedro) — resumida

1. Parear o número do SparkBot (**+1 813 407-9657**) no SparkZap (`/whatsapp` →
   Números → Conectar → QR). Número SEPARADO do suporte.
2. Webhook DA SESSÃO no engine → `<spark-os>/api/webhooks/wa-sparkbot?s=<secret>`.
3. OS em `SPARKBOT_INBOUND_MODE=shadow` → conferir eventos chegando.
4. Registrar o secret da fonte `sparkbot` e pôr o valor cru em `SPARK_OS_WA_TOKEN`.
5. `SPARKZAP_AGENT_SEND_ENABLED=1` → 1 envio de teste.
6. Aqui: `SPARKZAP_REPS=<telefone do Pedro>` + `SPARKBOT_WA_TRANSPORT=sparkzap`
   → 1 conversa real ponta a ponta.
7. OS em `SPARKBOT_INBOUND_MODE=1`. Stevo segue pareado (dual-run).

**Rollback**: `SPARKBOT_WA_TRANSPORT=stevo` + redeploy. Nada mais.

## 7. Riscos conhecidos

- **LID**: o engine endereça DM por `@lid`. A tradução mora na ponte do OS
  (`wa_lid_map`). Se a sessão apontar DIRETO pra cá, mensagem sem `SenderAlt`
  vira signal `unresolved_lid` em vez de sumir. Preferir sempre o hop pelo OS.
- **Detecção de apagão**: a rota nova grava em `stevo_webhook_samples` com
  `_source: "sparkzap"` — os monitores de silêncio (`checkInboundSilence`,
  `/api/health`) continuam medindo inbound de verdade no transporte novo.
- **Dupla entrega no dual-run**: se Stevo E SparkZap estiverem entregando o
  mesmo número, a camada 6 (UNIQUE em `ghl_message_id` = `Info.ID` do WhatsApp,
  o MESMO id nos dois) mata a duplicata. Foi por isso que o transporte novo
  reusa o `handleStevoInbound` em vez de um caminho próprio.

## 8. Fora do escopo (de propósito)

- Grupos (H40) — seguem no Stevo, têm gate de instância dedicada próprio.
- Agentes lead-facing — falam com LEADS pelos números dos clientes, já no
  gateway do OS por outro caminho.
- Consolidação de banco — §2.
- Cockpit do SparkBot dentro do OS — a tabela `agent_wa_sends` já é a fonte; a
  UI vem depois.
