# SparkBot — Mensagens Interativas do Stevo (Botões + Listas + vCard)
### Plano de Implementação — FORGE-3 · 2026-05-20

> **Convenção de responsabilidade** (cada tarefa carrega um marcador):
> - 🤖 **Claude** — executo direto (código, schema, migration, testes, docs técnicas).
> - 👤 **Time/Pedro** — ação humana fora do meu alcance (decisão de negócio, painel externo, tocar no WhatsApp pra testar).
> - 🤝 **Híbrido** — eu preparo, você executa/aprova (ex: smoke test onde você toca e eu valido o log).

---

## 1. Visão geral

Adicionar os tipos **interativos** do Stevo ao SparkBot pra reduzir digitação do rep e deixar o fluxo mais dinâmico: **botões** (≤3 opções tocáveis), **listas** (menu de 4–10 itens) e, na v2, **cartão de contato (vCard)**. Em vez de o rep digitar "sim" / o nome do contato / o horário, ele **toca** e segue.

**Escopo (decidido com o Pedro 2026-05-20):** v1 cobre **todo o inventário** de pontos de confirmação/opção; **vCard fica pra v2**. A **viabilidade já foi PROVADA** (Etapa 0 ✅): botão e lista renderizam no WhatsApp do rep via Stevo, e o tap volta num formato parseável com ID estável.

**Princípio arquitetural central (a "sacada"):** o tap do rep é **normalizado de volta pra texto** na borda de recebimento. Com isso, **nada do miolo muda** — o gate de confirmação H8 (enforced em código), o loop do LLM, o coherence gate e a idempotência continuam idênticos. A camada interativa vive só em 2 bordas: **envio** (novos endpoints Stevo) e **tradução do recebimento**.

---

## 2. Contexto (estado do código hoje)

- **Canal do rep 100% Stevo** (recém-migrado): inbound (`/api/webhooks/stevo` → `stevo-parser` → `stevo-handler`), reply (`stevo-send.ts` `/send/text`) e proativos (`whatsapp-delivery.ts`, Stevo-first → GHL fallback). Gates: `STEVO_SEND_ENABLED=1`, `SPARKBOT_INBOUND_PRIMARY=stevo`.
- **Saída do bot é uma `string`** (`ProcessOutput.text`) — **não existe canal estruturado** de "payload interativo" saindo do LLM hoje. É o que esta feature introduz.
- **Gate de confirmação H8** é **enforced em código** (`tools/index.ts:170-281`): tool `risk:"high"` (default `high_only`) exige `confirmed_by_rep:true`; senão o gate devolve erro instruindo o LLM a perguntar "Confirma?" e re-chamar. O **modelo dirige o re-call** — não o código.
- **88 tools** (`tools/index.ts`). Dois canais: `whatsapp` (Stevo) e `web_ui` (painel, renderiza markdown via polling).
- **Parser atual** (`stevo-parser.ts`) reconhece: texto, documento, imagem, áudio. **NÃO** reconhece `buttons_response` / `list_response` (hoje retorna `null` → tap é ignorado).
- **Splitter `---`** (`sparkbot-send.ts` / `stevo-send.ts`) já separa "opções" da "pergunta" em bolhas distintas — é o ponto natural onde o interativo substitui a 2ª bolha.

---

## 3. Regras de negócio + decisões

### 3.1 Decisões já fechadas
- ✅ **Viabilidade**: botão (`type:"reply"` → NativeFlow `quick_reply`) e lista renderizam e voltam parseáveis (probe 2026-05-20).
- ✅ **Escopo v1**: todo o inventário (§5.4). **vCard → v2.**
- ✅ **Formato do retorno** (capturado em prod):
  - Botão: `data.Info.MediaType="buttons_response"`; `Message.buttonsResponseMessage.selectedButtonID` (ID estável) + `.Response.SelectedDisplayText` (texto) + `.contextInfo.stanzaID` (msg original).
  - Lista: `data.Info.MediaType="list_response"`; `Message.listResponseMessage.singleSelectReply.selectedRowID` + `.title` + `.contextInfo.stanzaID`.

### 3.2 Decisões a confirmar (👤 Pedro — bloqueiam Etapa 3/4)
| ID | Pergunta | Por que importa | Recomendação |
|---|---|---|---|
| **D1** | Como o LLM sinaliza "manda botão/lista"? Tool dedicada (`present_options`) vs. markup no texto. | Define a robustez. Tool é mais confiável que parsear texto livre. | **Tool `present_options`** (terminal): o runner detecta a chamada e converte em payload interativo. |
| **D2** | Fallback no painel **web**? | Botão é WhatsApp-only. | **Texto numerado** no web/GHL (o bot já faz lista numerada). v1 não constrói botão clicável no painel. |
| **D3** | Rep digita em vez de tocar — aceitar sempre? | Não pode travar quem prefere digitar. | **Sempre aceitar texto livre.** Botão/lista são atalho, nunca obrigatório. |
| **D4** | Mapear `selectedButtonID`/`rowID` → valor de ação, ou usar o texto visível? | Desambiguação de contato precisa do contact_id. | **Normalizar pro texto visível**; o LLM **re-busca** antes de agir (regra anti-alucinação de ID já existe). ID estável fica no metadata pra audit. |

### 3.3 Limites do WhatsApp (regras duras pro código)
- **Botão**: máximo **3** opções, label curto (≤ ~20 chars). >3 opções → vira **lista**.
- **Lista**: até **10 rows** no total, agrupados em seções; row title ≤ ~24, descrição ≤ ~72. >10 → **paginar** ("ver mais"/próximo dia).
- **Sempre** popular o **texto-fallback** (corpo + opções numeradas) pra web/GHL e pra quando o interativo falhar.

---

## 4. Arquitetura

### 4.1 Envio (🤖)
`stevo-send.ts` ganha:
- `sendStevoButton({ serverUrl, apiKey, number, title?, body, footer?, buttons:[{id,label}] })` → `POST {serverUrl}/send/button` com `buttons:[{displayText,id,type:"reply"}]`.
- `sendStevoList({ serverUrl, apiKey, number, title?, body, footer?, buttonText, sections:[{title,rows:[{rowId,title,description?}]}] })` → `POST {serverUrl}/send/list`.
- (v2) `sendStevoContact(...)` → `/send/contact` com `vcard:{fullName,organization,phone}`.
- Reusa timeout/normalização de número/`ok` do `sendStevoText`. Nunca lança.

### 4.2 Recebimento (🤖) — a tradução
`stevo-parser.ts` passa a reconhecer `MediaType` `buttons_response` e `list_response`:
- Extrai `selectedButtonID`/`selectedRowID`, o texto visível e `stanzaID`.
- **Normaliza pra um turno de texto** do rep: o `text` vira o texto visível (ex: "Confirmar ✅", "Opção 2", "João Silva"); o ID estável + `stanzaID` vão no metadata.
- Novo `ParsedStevoContent` kind `interactive_reply` (ou reaproveita `text` com metadata) — decisão de implementação na Etapa 2.
- `stevo-handler` persiste como `role:"user"` normal → `processIncoming` roda igual. **Recência**: como em REACTION, ignorar tap a uma mensagem muito antiga (usar `stanzaID` + janela), pra não reabrir contexto morto.

### 4.3 Sinal do LLM → payload interativo (🤖, depende de D1)
- Nova tool **`present_options`** (`risk:"safe"`): `{ body, options:[{id,label,description?}], footer?, style?:"auto"|"buttons"|"list" }`. `style:"auto"` = botões se ≤3, lista se 4–10.
- O **runner** (`run-sparkbot-turn.ts`/`processor.ts`) detecta `present_options` nas tool calls e monta `ProcessOutput.interactive = { kind, body, options, footer }`, encerrando o turno (a apresentação **é** a resposta). `ProcessOutput.text` recebe o **fallback** (corpo + opções numeradas).
- Confirmações (gate H8): o prompt ensina o LLM, ao precisar confirmar, a chamar `present_options({body:"Vou X. Confirma?", options:[{id:"confirm",label:"Confirmar ✅"},{id:"cancel",label:"Cancelar ❌"}]})`. Tap "Confirmar ✅" → normaliza → LLM re-chama a tool real com `confirmed_by_rep:true`. **Gate intacto.**

### 4.4 Envio canal-aware (🤖)
- `ProcessOutput` ganha `interactive?: InteractivePayload`.
- `stevo-handler`: se `interactive` presente **e** `channel="whatsapp"` → `sendStevoButton/List`; senão → `sendStevoText(text)` (fallback já tem opções numeradas).
- `web_ui` (`/api/sparkbot/send`) e GHL fallback (`sparkbot-send`): ignoram `interactive`, renderizam `text`. **Zero regressão** nesses canais.

### 4.5 Gate de flag (🤖) — rollback trivial
- Env `STEVO_INTERACTIVE_ENABLED` (default **off**). Off → `present_options` degrada pra texto numerado em todo lugar (bot funciona igual a hoje). On → interativo no WhatsApp. Rollback = desligar a env.

---

## 5. Etapas de execução

### Etapa 0 — Viabilidade & formato (✅ CONCLUÍDA)
- 🤖 Extrair payloads `/send/button|list|contact` do swagger. ✅
- 🤝 **Probe real**: enviar botão+lista pro WhatsApp do Pedro; ele tocou; capturei o formato do retorno. ✅
- 🤖 Confirmar `type:"reply"` → renderiza (NativeFlow quick_reply). ✅
- **Critério de saída:** ✅ render confirmado (👤 Pedro viu) + formato do retorno capturado (🤖).

### Etapa 1 — Primitivas de envio
- 🤖 `sendStevoButton` + `sendStevoList` em `stevo-send.ts` (+ validação de limites: ≤3 botões, ≤10 rows, truncagem de labels).
- 🤖 Golden test com `fetch` mockado: shape do payload, limites, número normalizado, erro/timeout.
- 🤝 **Teste real opt-in**: 1 botão + 1 lista "de verdade" gerados pelas funções novas (não pelo probe raw) pro WhatsApp do Pedro.
- **Critério de saída:** payloads aceitos (HTTP 2xx) 🤖 + render confirmado 👤 + testes verdes 🤖.

### Etapa 2 — Recebimento (parser + normalização)
- 🤖 `stevo-parser.ts`: reconhecer `buttons_response`/`list_response` → turno de texto normalizado + metadata (id estável, stanzaID, kind).
- 🤖 Recência por `stanzaID` (ignora tap a msg antiga, padrão REACTION).
- 🤖 `stevo-handler`: persistir o tap como inbound normal; metadata `interactive_reply`.
- 🤖 Golden test do parser pros 2 formatos reais capturados + null-cases.
- 🤝 **Teste real**: tocar num botão/lista e ver o bot **responder** ao tap (agora que o parser entende).
- **Critério de saída:** parser 100% nos fixtures reais 🤖 + bot responde ao tap 👤+🤖.

### Etapa 3 — Sinal do LLM + payload + fallback (depende de D1/D2/D3)
- 🤖 Tool `present_options` + `ProcessOutput.interactive` + detecção no runner (turno terminal).
- 🤖 Envio canal-aware no `stevo-handler`; fallback texto numerado no web/GHL.
- 🤖 Env `STEVO_INTERACTIVE_ENABLED` (gate).
- 🤖 Testes: `present_options` → payload correto; fallback texto quando off/web.
- **Critério de saída:** com flag on, `present_options` vira botão/lista no WhatsApp e texto no web 🤖; com flag off, texto em todo lugar 🤖.

### Etapa 4 — Encaixe nos casos de uso + treino do bot (v1 = inventário todo)
- 🤖 **Prompt training** (`prompt-builder.ts`): quando usar botão (sim/não, ≤3) vs lista (4–10) vs texto (livre); naturalidade ("não vira robô de menu"); sempre aceitar texto digitado; nunca expor mecânica.
- 🤖 Ligar nos casos (ordem de alavancagem):
  1. **Confirmações** do gate H8 → botão Confirmar/Cancelar.
  2. **Desambiguação de contato** (`disambiguation.ts`) → lista (ou 3 botões).
  3. **Estratégia de disparo bulk** (`bulk-messages-v2`, sempre 3) → lista.
  4. **Slots de horário** (`calendar.ts`) → lista (paginada, ≤10).
  5. **Quente/fria**, **aprovação de follow-up**, **switch de location**, **mapeamento de import CSV**, **next-step "criar opp também?"** → botão/lista conforme nº de opções.
- 🤖 Golden tests de roteamento (qual caso → qual tipo) + casos "NÃO interativo" (nota, nome, valor, data — §8).
- **Critério de saída:** suite de roteamento verde 🤖 + revisão de naturalidade no smoke 👤.

### Etapa 5 — Smoke, Go-Live, Hypercare
- 🤝 **Smoke supervisionado** (você toca, eu valido o banco): confirmação por botão → ação executa 1×; desambiguação por lista → contato certo; bulk strategy por lista; digitar em vez de tocar ainda funciona; web cai pra texto.
- 🤖 Ligar `STEVO_INTERACTIVE_ENABLED=1` (👤 seta na Vercel ou 🤖 via CLI com seu ok) + push.
- 🤖 Monitorar `sparkbot_messages.metadata` (interactive_reply, sent_via) + `admin_signals` por alguns dias.
- **Critério de saída:** smoke 100% 👤+🤖 + sem regressão no fluxo de texto 🤖.

---

## 6. Checklist consolidado
- [ ] 🤖 `sendStevoButton`/`sendStevoList` + limites + testes (Etapa 1)
- [ ] 🤝 Render confirmado pelas funções novas (Etapa 1)
- [ ] 🤖 Parser `buttons_response`/`list_response` + recência + testes (Etapa 2)
- [ ] 🤝 Bot responde ao tap (Etapa 2)
- [ ] 👤 Decisões D1–D4 (Etapa 3)
- [ ] 🤖 `present_options` + `ProcessOutput.interactive` + runner + fallback + gate env (Etapa 3)
- [ ] 🤖 Prompt training + encaixe nos casos + testes de roteamento (Etapa 4)
- [ ] 🤝 Smoke supervisionado (Etapa 5)
- [ ] 🤖 Go-live (flag on) + hypercare (Etapa 5)

## 7. Plano de rollback
- **Imediato:** `STEVO_INTERACTIVE_ENABLED` off → `present_options` degrada pra texto numerado; bot volta ao comportamento atual. Sem deploy.
- **Total:** reverter os commits da feature (envio/parse são aditivos; nenhuma mudança destrutiva no miolo).
- O **parser** de `buttons_response`/`list_response` pode ficar ligado mesmo no rollback (só normaliza tap pra texto — inócuo).

## 8. Riscos & mitigações
| Risco | Prob | Impacto | Mitigação | Resp |
|---|---|---|---|---|
| Rep digita em vez de tocar | Alta | Baixo | Texto livre **sempre** aceito; interativo é atalho | 🤖 |
| Deliverability do interativo (Baileys) varia por device | Média | Médio | Probe confirmou; **fallback texto** sempre presente; monitorar signals | 🤖 |
| Tap em botão **antigo** reabre contexto morto | Média | Médio | Recência por `stanzaID` (padrão REACTION) | 🤖 |
| >3 opções em botão / >10 em lista | Média | Médio | `style:"auto"` (botão≤3, lista≤10) + paginação | 🤖 |
| Web não renderiza botão | Certa | Baixo | Fallback texto numerado (D2) | 🤖 |
| LLM "vira robô de menu" (interativo demais) | Média | Médio | Prompt training + casos "NÃO interativo" (notas, nomes, valores, datas) | 🤖 |
| Quebrar o gate H8 / coherence | Baixa | Alto | Tap **normalizado pra texto** → miolo intacto; golden suite cobre | 🤖 |

**NÃO tornar interativo:** corpo de nota, texto de mensagem pro cliente, nomes/e-mails/telefones, valores monetários, datas/horas ISO, janela custom de bulk, queries de KB, recap — tudo texto livre.

## 9. Documentação pós-projeto + backlog V2
- 🤖 Atualizar `CLAUDE.md` (seção "Stevo interativo"), `docs/DECISIONS.md` (novo código H), `MEMORY`.
- **V2 backlog:** vCard (`/send/contact`) — enviar cartão ("manda o contato do João") + parsear vCard recebido pra prefill de `create_contact`; botões de URL/call/PIX; multi-select em lista; botão clicável no painel web.

---

### Anexo — formato real do retorno (capturado 2026-05-20)
```
buttons_response → Message.buttonsResponseMessage.selectedButtonID + .Response.SelectedDisplayText + .contextInfo.stanzaID
list_response    → Message.listResponseMessage.singleSelectReply.selectedRowID + .title + .contextInfo.stanzaID
```
Scripts de referência: `scripts/probe-stevo-interactive.ts` (envio raw), samples em `stevo_webhook_samples`.
