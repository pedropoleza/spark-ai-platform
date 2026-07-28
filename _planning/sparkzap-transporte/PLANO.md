# H57 — SparkBot no SparkZap (transporte próprio de WhatsApp)

> **Data:** 2026-07-28 · **Status:** código NO AR atrás de flags, tudo OFF.
> **Pedido do Pedro:** "colocar o SparkBot dentro do nosso Engine de WhatsApp,
> que é o Spark Zap, porque o Stevo está com muito problema. Não precisa
> desconectar do Stevo. Deixa pronto pra depois eu implementar as mensagens com
> botão no SparkZap."
> **Doc canônico da arquitetura (lado Spark OS):**
> `spark-os/_planning/SPARKBOT_SPARKZAP_BRIDGE.md` · payloads ricos:
> `spark-os/_planning/WA_RICH_MESSAGES_GUIDE.md`.
>
> **CONSOLIDAÇÃO (fim do dia 28/07):** outra sessão construiu em paralelo as
> mensagens RICAS no motor do gateway do OS (commit `07bfea7` de lá: `rich.ts` +
> botões/lista/enquete no `engine.ts` + pacer com `payload` + leitura do clique)
> e a porta `POST /api/ingest/wa/send` — pela FILA, com `fireDrain()` (sai em
> segundos). Ficou **UMA porta**: o `sparkzap-send.ts` daqui fala com
> `/api/ingest/wa/send`; a rota direta `agent-send` que existia foi removida do
> OS. **Botão e lista já são SUPORTADOS** pela porta (não existe mais o gate
> `SPARKZAP_INTERACTIVE`) — falta só o teste de rendering em aparelho real
> (Android + iPhone) antes de ligar interativo pra valer.

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
| `webhook/sparkzap-send.ts` | envio (texto/botão/lista) pela porta `/api/ingest/wa/send` do OS — mesmo `StevoSendResult` do `stevo-send.ts`; TRUNCA labels client-side (o `rich.ts` do OS rejeita >20/24/72 em vez de truncar); `priority` 1 (resposta) / 3 (proativo); `{ok,outboxId}` = aceito na fila, `duplicate` = sucesso |
| `webhook/sparkzap-parser.ts` | traduz o envelope do engine e **reusa o `parseStevoWebhook`** (um parser só) |
| `api/webhooks/spark-zap/route.ts` | rota de entrada, bearer `SPARKZAP_INBOUND_TOKEN`, fail-closed |
| `webhook/stevo-handler.ts` | despacho por transporte no bloco de envio (+ `sent_via` no audit) |
| `proactive/whatsapp-delivery.ts` | SparkZap-first → Stevo → Spark Leads (a escada existente vira rede de segurança) |
| `marina-daily.ts` | digest diário idem |
| `scripts/test-sparkzap-transport.ts` | 59/59 |

**O miolo não mudou**: idempotência de 7 camadas, gates H8/test-mode, billing,
silence tracking, termos — tudo no mesmo caminho (`handleStevoInbound`). O que
mudou foi a porta de entrada e a de saída.

## 4. Botão e lista

**Já suportados pela porta** (a outra sessão fechou o motor: NativeFlow + nó
`<biz>` pros botões, `DocumentWithCaption` pra lista, e a leitura do CLIQUE).
O que resta antes de usar interativo com rep de verdade: o teste de RENDERING
num Android e num iPhone (checklist do guia de mensagens ricas). Enquanto isso:
- um 422 da validação do OS vira `unsupported: true` no resultado;
- o handler cai no **fallback de texto** (opções numeradas) — o rep nunca fica
  sem resposta;
- o gate de interativo continua sendo o já existente `STEVO_INTERACTIVE_ENABLED`
  (vale pros dois transportes).

## 5. Envs (todas OFF por padrão)

| Env | Onde | Default | O que faz |
|---|---|---|---|
| `SPARKBOT_WA_TRANSPORT` | AI platform | `stevo` | `sparkzap` liga o transporte novo |
| `SPARKZAP_REPS` | AI platform | vazio | allowlist E.164 (vírgula) do rollout; vazia = todos |
| `SPARK_OS_WA_URL` | AI platform | — | `https://spark-os-green.vercel.app/api/ingest/wa/send` |
| `SPARK_OS_WA_TOKEN` | AI platform | — | bearer da fonte `sparkbot` (valor cru; o OS guarda o hash) |
| `SPARKZAP_INBOUND_TOKEN` | AI platform | — | bearer que a rota `/api/webhooks/spark-zap` exige |

Do lado do OS: `SPARKBOT_ENGINE_SESSION`, `SPARKBOT_INBOUND_{MODE,URL,TOKEN}`
(o envio não tem env própria — é a fonte `sparkbot` em `integration_sources`,
fail-closed sem secret).

## 6. Ordem de ligação — resumida

Secrets e envs **JÁ registrados pelo agente** (acesso completo aos dois lados):
o hash da fonte `sparkbot` está em `integration_sources`, e as envs
`SPARK_OS_WA_URL`/`SPARK_OS_WA_TOKEN`/`SPARKZAP_INBOUND_TOKEN` (aqui) +
`SPARKBOT_INBOUND_URL`/`SPARKBOT_INBOUND_TOKEN` (OS) estão na Vercel. Resta:

1. 👤 Parear o número do SparkBot (**+1 813 407-9657**) no SparkZap
   (`/whatsapp` → Números → Conectar → QR). Número SEPARADO do suporte.
   Manter **antiban OFF** no número (paridade Stevo).
2. Webhook DA SESSÃO no engine → `<spark-os>/api/webhooks/wa-sparkbot?s=<secret>`.
3. OS: `SPARKBOT_ENGINE_SESSION=<engine_name>` + `SPARKBOT_INBOUND_MODE=shadow`
   → conferir `webhook_events source='sparkbot_shadow'` chegando.
4. Teste de envio `kind:"text"` pro telefone do Pedro; depois `kind:"buttons"`
   num Android E num iPhone (prova o rendering).
5. Aqui: `SPARKZAP_REPS=<telefone do Pedro>` + `SPARKBOT_WA_TRANSPORT=sparkzap`
   → 1 conversa real ponta a ponta.
6. OS em `SPARKBOT_INBOUND_MODE=1`. Stevo segue pareado (dual-run).

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
