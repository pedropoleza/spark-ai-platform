# B2 — Tool System, Loop Agêntico & Causa-Raiz dos P0

> Fase 2 do review enterprise do SparkBot. **READ-ONLY** — nenhum código foi alterado.
> Base de código: `src/lib/account-assistant/*`. Evidência comportamental cruzada com o DB de prod
> (Supabase `AI Agent Hub` / `vyfkpdnwevtuxauacouj`, tabela `sparkbot_messages`, 1.203 msgs de agente).
> Agente ativo em prod: `483ca4eb…` na location `RBFxlEQZobaDjlF2i5px`, modelo `claude-sonnet-4-6`,
> **`confirmation_mode = 'high_only'`** (importante — ver §4).

---

## 1. RESUMO EXECUTIVO

**P0 #1 — FALSE CALL (afirma escrita sem rodar a tool).** Causa-raiz: o loop em `llm-client.ts:429-444`
devolve o `text` final do modelo **sem qualquer cross-check contra `tool_calls`**, e `processor.ts:787-819`
só usa esse texto pra gerar um *signal* de auditoria (`detectHallucination`) — **não bloqueia nem corrige a
resposta** (comentário explícito "Não bloqueia a resposta — UX preservada", `processor.ts:786`). O webhook
então persiste e envia esse texto como-está (`webhook-handler.ts:752-753`). Ou seja: o modelo é livre pra
escrever "Nota salva" como texto puro num turno só-texto (`stop_reason='end_turn'`, zero tool_use) e o sistema
confia. Confirmado em prod: **9 msgs "nota salva/criada" com `tools=[]`**, 3 reminders "agendado" sem tool, 1
opp. O detector é *post-hoc* e best-effort (regex frágil), não um gate.

**P0 #2 — DUPLA-RESPOSTA (37 pares ≤8s).** Causa-raiz: **race de dois webhooks inbound concorrentes** (GHL
multi-provider Stevo + WhatsApp API), cada um com `ghl_message_id` DIFERENTE, chegando com ~2ms de diferença.
Prova de prod: rep `1eeb02cc…` mandou "Oi" uma vez; chegaram 2 webhooks (`Y81qw…` e `EOndB…`) em
`04:14:01.528` e `04:14:01.531` → ambos rodaram `processIncoming` → 2× "Oi! O que precisa?" enviados (0.45s
de diferença). As 7 camadas de idempotência falham nesse TOCTOU porque (a) `inFlightMessages`
(`webhook-handler.ts:29-40`) deduz por `ghl_message_id` — que é distinto — e é um `Map` **por-lambda** (cada
webhook concorrente pode cair em lambda diferente); (b) os SELECTs de CONTENT-MATCH/TIMING-MATCH
(`webhook-handler.ts:412-472`) rodam **antes** do INSERT dos dois → ambos veem "nada"; (c) o único lock
multi-lambda real, `sparkbot_dedup_locks` (`webhook-handler.ts:254-279`), tem janela em que o segundo webhook
ainda não escreveu. **Não é retry, nem mensagem intermediária do loop** — o loop nunca emite parcial. Dos 37
pares: **18 são proativos** (🔔 reminders/📤 bulk do cron, em geral legítimos mas o silence-gate gruda o aviso
"Tô percebendo que você não tá respondendo" em cada disparo) e **19 conversacionais** (3 byte-idênticos = race
puro; 16 divergentes = mesmo conteúdo físico — tipicamente áudio multi-provider — processado 2× gerando 2
respostas LLM diferentes, às vezes contraditórias).

**P0 #3 — MOVER→CREATE.** Causa-raiz: **não existe tool `move_*`** e o roteamento semântico é ambíguo +
não-instruído. Pra "mover opp pra M3", o caminho correto é `update_opportunity(opportunity_id, stage_id)`
(`tools/opportunities.ts:326-366`), mas o modelo tende a `create_opportunity` (`tools/opportunities.ts:279`)
porque a description dela é a mais direta ("Cria uma nova opportunity") e o prompt **não tem nenhuma regra
"mover X pra stage Y → update_opportunity"** (`prompt-builder.ts` só menciona "movida" na lista de frases
*proibidas* do anti-hallucination, linha 680 — ensina o que não falar, não qual tool usar). Prova de prod:
**`create_opportunity` = 19 chamadas vs `update_opportunity_status` = 2 e `update_opportunity` = 5**. Pior caso
real: Henry Giuseppe — bot disse "✅ Movido pra Policy Delivery" tendo chamado `create_opportunity` **duas
vezes** (2 duplicatas) e zero update. É P0 #3 e P0 #1 no mesmo turno.

**Veredito — liberdade agêntica:** SAUDÁVEL e bem implementada. O loop permite tool use paralelo nativo
(executa todos os `tool_use` blocks do mesmo turno em sequência, devolve todos os resultados juntos) e roda até
**10 iterações** (`MAX_ITERATIONS`, `llm-client.ts:16`). Os 58% de runs com 2+ tools confirmam: **não há teto
artificial que restrinja multi-tool**. O gargalo não é liberdade — é confiabilidade de execução vs narração.

**Veredito — gate de confirmação (H8):** Em prod o modo é `high_only`, então notes/tasks/tags/opportunities
(todas `medium`) **executam direto** — o gate de código NÃO é a fonte da over-confirmação. A over-confirmação
de 33% vem do **próprio modelo** (prompt pesado + viés conservador), não do gate. O gate em si é sólido e
necessário. O problema secundário é o LLM se vender como "regra que não consigo pular" — isso é tom, resolvível
no prompt, não no gate.

---

## 2. COMO O LOOP FUNCIONA (passo a passo)

Entrada: `processIncoming` (`processor.ts:389`) monta system prompt + histórico + user message e chama
`runWithTools` (`processor.ts:702-716`), passando `executor: (name,args) => executeTool(name,args,toolCtx)`.

`runWithTools` (`llm-client.ts:149`) decide provider pelo prefixo do modelo e entra em `runWithClaude`
(`llm-client.ts:338`). O loop:

1. **Iteração `i` (0…9)** — `client.messages.create` (`llm-client.ts:373-384`) com `max_tokens: 2500`,
   `temperature: 0.3`, system prompt + tools (último tool recebe `cache_control: ephemeral`,
   `llm-client.ts:366-372`), e as `messages` acumuladas.
2. **Contabiliza tokens** (fresh + cache_read + cache_creation, `llm-client.ts:407-423`).
3. **Push da resposta** como `assistant` message (`llm-client.ts:426`).
4. **Se `stop_reason === 'end_turn'`** (ou `stop_sequence`): extrai os text blocks, junta, retorna
   (`llm-client.ts:429-444`). **← É AQUI que o texto final sai, sem checar tool_calls. Ponto-chave do P0 #1.**
5. **Se `stop_reason === 'tool_use'`**: filtra os `tool_use` blocks (`llm-client.ts:447-449`) e **executa
   TODOS em sequência** (`for (const tu of toolUses)`, `llm-client.ts:470-492`) — é o tool use paralelo: o
   modelo pode emitir N tool_use no mesmo turno, todos rodam, todos os `tool_result` voltam num único `user`
   message (`llm-client.ts:494`). Erros viram `{status:'error', message}` sem derrubar o loop
   (`llm-client.ts:479-491`).
6. Volta pra (1). Se estourar 10 iterações → texto fixo "Executei várias ações mas preciso parar aqui"
   (`llm-client.ts:498-507`).

**Fallback chain** (`llm-client.ts:153-272`): Claude Sonnet → Haiku → GPT-4.1, guardado por `LLMFailureMidLoop`
(`llm-client.ts:74-83`) que **impede fallback se tools com side-effect já rodaram** (anti double-send, fix
2026-05-03). `STRICT_CLAUDE_ONLY=1` corta o OpenAI.

Saída: `RunWithToolsOutput` com `text` + `tool_calls[]` (cada um `{name, input, result}`) +
`stopped_reason`. `processIncoming` faz billing, roda o detector de hallucination (signal-only) e devolve.
`webhook-handler.ts:724-754` envia (`sendResponseToRep`) e persiste.

> **Observação de design relevante pro P0 #1:** o `text` e os `tool_calls` são campos paralelos e
> independentes no output. Nada no pipeline valida coerência entre "o que o texto afirma" e "o que
> `tool_calls` contém" antes de enviar. O detector existe (`processor.ts:273-330`) mas só **observa**.

---

## 3. CAUSA-RAIZ DOS P0 (trecho culpado + porquê)

### P0 #1 — FALSE CALL

**Trecho culpado:** `llm-client.ts:429-444` (retorna `finalText` cru) + `processor.ts:786-819` (detector
não-bloqueante) + `webhook-handler.ts:752-753` (envia o texto como-está).

```
// llm-client.ts:429
if (response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence") {
  const finalText = textBlocks.map((b) => b.text).join("\n").trim();
  return { text: finalText, tool_calls, ... };   // ← zero verificação de coerência
}
```

```
// processor.ts:786-789  (comentário literal: "Não bloqueia a resposta — UX preservada")
const hallucinations = detectHallucination(result.text, toolsCalled);
for (const h of hallucinations) { recordSignalAsync({...}); }   // só signal
```

**Por que falha:** o modelo, num turno final só-texto, é livre pra escrever "Nota salva", "Movido pra X",
"Lembrete agendado ✅" — e isso é tratado como resposta válida. O sistema **confia na narração do LLM**. Toda a
defesa contra isso é (a) prompt (`prompt-builder.ts:670-731`, regras anti-hallucination extensas) e (b) um
detector regex *post-hoc* (`detectHallucination`, `processor.ts:273`) que apenas gera signal pro Pedro. O
detector é frágil por construção: depende de listas fixas de frases (`HALLUCINATION_PATTERNS`,
`processor.ts:107-182`) e de heurísticas de contexto negativo (`isNegatedOrPreviewContext`,
`processor.ts:211-271`) que produzem falsos-positivos e falsos-negativos. **Confirmação empírica:** 9 "nota
salva" + 3 reminders + 1 opp com `tools=[]` em prod. O caso Henry ("Movido pra Policy Delivery" com 2×
`create_opportunity`) mostra a variante mais traiçoeira: a tool RODOU (não é `tools=[]`), mas a **errada** — o
detector específico de opportunity (`processor.ts:172-181`) considera `create_opportunity` como satisfatória
pra claim "movida", então **nem dispara**. Narração ≠ realidade e nada barra.

### P0 #2 — DUPLA-RESPOSTA

**Trecho culpado:** as 7 camadas de idempotência em `webhook-handler.ts` têm um furo TOCTOU pra webhooks
concorrentes com `ghl_message_id` distintos. Pontos:
- `inFlightMessages` (`webhook-handler.ts:29-40, 113`) — chaveado por `ghl_message_id` (distinto entre os 2
  webhooks → não casa) e é `Map` em memória (por-lambda → inútil cross-lambda).
- CONTENT-MATCH 15s (`webhook-handler.ts:412-436`) e TIMING-MATCH 5s (`webhook-handler.ts:449-472`) — fazem
  **SELECT antes do INSERT**; com 2ms de diferença ambos os webhooks selecionam "vazio".
- `sparkbot_dedup_locks` UNIQUE (`webhook-handler.ts:254-279`) é o único cross-lambda confiável, mas exige que
  ambos cheguem ao INSERT do lock; a chave é `rep_id|minuteBucket|content[:200]` — se o `identifyRep`
  (`webhook-handler.ts:237`) de um dos webhooks demora ou se ambos rodam o INSERT do lock de fato
  simultaneamente, escapa.

**Por que falha:** prova de prod definitiva — 2 webhooks "Oi" (`Y81qwPQgDExS3kohutAP`, `EOndBYF163DatxqfgTH8`)
em `04:14:01.528871` e `04:14:01.531153` (Δ=2.28ms), ambos persistidos como `user`, ambos geraram resposta
agent idêntica 0.45s de diferença. A defesa de DB não é atômica o suficiente pra Δ sub-3ms multi-lambda. Para
áudio, o efeito é pior: os 2 webhooks trazem **conteúdos diferentes** (um transcreve, outro vem placeholder),
escapam do CONTENT-MATCH, e geram 2 respostas LLM divergentes (ex.: "contexto atualizado" vs "Não consigo
processar áudio", Δ=1.1s) — a "contradição" reportada no A2b. **O loop NÃO contribui** (nunca emite parcial; o
único texto vem do `end_turn`). É puramente concorrência de ingestão.

> Subcaso proativo (18/37): não é bug de race — são reminders/bulk distintos do cron caindo na mesma janela.
> Mas o silence-gate gruda "⚠️ Tô percebendo que você não tá respondendo" em **cada** disparo, o que parece
> spam/dupla-resposta pro rep e foi lido como tal nas conversas.

### P0 #3 — MOVER→CREATE

**Trecho culpado:** `tools/opportunities.ts` (catálogo) + `prompt-builder.ts` (ausência de regra de
roteamento).
- Não há `move_opportunity`. As opções são `create_opportunity` (`:279`, "Cria uma nova opportunity"),
  `update_opportunity` (`:326`, description termina com "…mover stage. Pra mudar só status use
  update_opportunity_status") e `update_opportunity_status` (`:368`, "Muda só o status
  open/won/lost/abandoned").
- O prompt lista as 3 (`prompt-builder.ts:130`) mas **não dá exemplo nem regra** do tipo "rep diz 'mover Fulano
  pra M3' → list_opportunities pra achar opportunity_id → update_opportunity(opportunity_id, stage_id)". A
  única ocorrência de "movida" no prompt está na blocklist anti-hallucination (`:680`).

**Por que falha:** semântica ambígua. "Mover pra M3" = trocar **stage** (update_opportunity com stage_id);
"marcar como lost/won" = trocar **status** (update_opportunity_status). Sem alias `move_` e sem instrução, o
modelo gravita pra `create_opportunity` (verbo "criar" é o mais saliente e a description é a mais convidativa).
**Prova:** 19× create vs 7× update/update_status; caso Henry com 2 creates narrados como "movido". Resultado:
duplicatas no pipeline + narração falsa.

---

## 4. GATE DE CONFIRMAÇÃO (H8) — avaliação

**Mecânica.** `withConfirmationParam` (`tools/index.ts:85-119`) injeta `confirmed_by_rep` (boolean, **required**)
no schema das tools que o modo exige; `executeTool` (`tools/index.ts:169-263`) enforça em código: bloqueia se
`args.confirmed_by_rep !== true` (`:210-221`) devolvendo erro com a frase pronta. `toolRequiresConfirmation`
(`:72-79`): `always`=tudo; `medium_and_high`=medium+high; `high_only`=só high.

**Estado real em prod (decisivo):** o agente ativo tem **`confirmation_mode='high_only'`** (consulta a
`agent_configs`). Logo, em prod, `create_note/create_task/add_tag/create_opportunity/update_opportunity`
(todas `risk:'medium'`) **executam DIRETO sem gate**. `schedule_reminder` é `risk:'safe'`
(`tools/reminders.ts:28`) → também direto. **Conclusão:** o gate de código **não** é a causa dos 33% de
over-confirmação. A over-confirmação é **comportamento do modelo** (prompt extenso + temperatura baixa + viés
conservador), pedindo "Confirma?" mesmo onde o código não exige.

> Nota de drift: o **DB default** da coluna é `'medium_and_high'` (`migration 00029:94`), mas o código usa
> `|| 'high_only'` como fallback quando o config vem null (`processor.ts:584/646/693/710`,
> `webhook-handler.ts:733`). Como o registro de prod tem `'high_only'` explícito, o efetivo é high_only. Se
> algum agente novo herdar o default do DB, passaria a confirmar todo write medium — risco latente de
> inconsistência entre ambientes.

**Onde está rígido / problemático:**
1. **Contradição prompt × código.** `prompt-builder.ts:90` (texto de `high_only`) e `:396` afirmam
   "notes/tasks/tags/opportunities executam DIRETO, sem pedir Confirma?" — porém o modelo continua pedindo
   confirmação (33%). Ou o modelo ignora a instrução, ou outras seções do prompt o empurram pro contrário. O
   prompt tem **muitas** instruções "confirma antes" pra bulk/override/send (`:303,308,314,324,538,609,615`)
   que provavelmente sangram pro comportamento geral.
2. **Tom "regra que não posso pular".** Não há string literal "não consigo pular" no prompt, mas o framing
   "enforçado em código — H8" (`:435`) + as frases de erro do gate (`tools/index.ts:213-219`, "Esta tool exige
   confirmação no modo X… RECHAME com confirmed_by_rep:true") levam o modelo a verbalizar a mecânica interna
   pro rep. Reps reagiram mal ("vc eh burro?", "para de me perguntar a mesma coisa").
3. **Loop de re-confirmação** (Phil disse "Sim" e bot reconfirmou): o gate depende do modelo re-chamar a tool
   com a flag após o "sim"; quando o modelo não associa o "sim" à tool pendente, re-pergunta. O prompt tem
   lista de variantes de "sim" (`:398`) mas o problema é de *binding* de estado conversacional, não de
   vocabulário.

**Veredito:** o gate é **necessário e sólido**; não está rígido demais no nível de código (high_only é
permissivo). O atrito é de **prompt e tom**, não de enforcement. Recomendação em §7.

---

## 5. TOOLS "MORTAS" (0 chamadas no período)

Todas estão **expostas ao LLM** (entram em `getAllToolDefinitions`, `tools/index.ts:131-139`, e não estão em
`disabled_tools` — prod tem `[]`). Logo o motivo nunca é "escondida". É falta de trigger / sobreposição /
gatilho fraco no prompt.

| Tool | Exposta? | Provável motivo de 0 uso |
|---|---|---|
| `recap_session` | Sim | Tem gatilho no prompt (`:797-798`), mas concorre com o histórico que o modelo já tem em contexto — o LLM responde "o que fizemos" de cabeça em vez de chamar a tool. Trigger existe, mas é dominado. |
| `set_verbosity_preference` | Sim | Gatilho existe (`:800-801`), mas raro o rep usar as frases exatas ("fala mais curto"); e mesmo quando usa, o modelo tende a só obedecer no turno em vez de **persistir** via tool. Baixa frequência natural + ação "invisível". |
| `set_daily_briefing` | Sim | **Sem nenhum gatilho no prompt** (grep não acha `set_daily_briefing`/`briefing diário`). O modelo não sabe que existe nem quando usar. Feature órfã de prompt. |
| `update_task` | Sim | Gatilho mínimo (`:128` lista, `:365` "reatribui essa task pra Maria"). Reps quase não editam task por chat (criam, no máximo completam). Demanda real baixa. |
| `complete_task` | Sim | Listada (`:128`) mas **sem instrução de quando** ("marca task como feita"). Reps gerenciam task no app Spark, não pelo bot. Demanda baixa + trigger fraco. |
| `forget_rep_alias` / `list_rep_aliases` | Sim | Nicho (gestão de apelidos). Gatilho existe (`:1088`) mas caso de uso raríssimo. |
| `list_my_locations` | Sim | Só útil pra reps multi-location; a maioria é single-location (auto-resolvida em `processor.ts:449`). Demanda estrutural baixa. |

**Padrão geral:** 2 famílias — (a) **trigger ausente/fraco no prompt** (`set_daily_briefing` é o caso puro;
`complete_task`, `update_task` fracos) e (b) **demanda natural baixa / ação invisível** (verbosity, aliases,
locations, recap dominado pelo contexto). Nenhuma morre por description tecnicamente ruim — morrem por
roteamento/uso.

---

## 6. QUALIDADE DAS TOOL DESCRIPTIONS — achados

**Boas práticas presentes:** várias descriptions têm gatilho embutido ("Use quando rep falar 'me lembra…'",
`reminders.ts:24`), contraste explícito ("NÃO confunda com create_task", idem), e desambiguação
(`update_opportunity` aponta pra `update_opportunity_status`, `opportunities.ts:329`). `list_opportunities`
(`opportunities.ts:12-13`) ensina a preferir a Filter Engine pra critérios múltiplos. Isso é acima da média.

**Problemas que confundem o modelo:**
1. **create vs update vs (in)existente move de opportunity** — o trio é a maior fonte de erro (P0 #3). Falta
   uma description que diga, em `create_opportunity`, "**NÃO use pra mover/atualizar uma opp existente** — pra
   isso use update_opportunity (stage) ou update_opportunity_status (won/lost). Só crie se o contato ainda não
   tem opp nesse pipeline." Hoje `create_opportunity` (`:282`) é silenciosa sobre o anti-uso.
2. **`update_opportunity` faz dois trabalhos** (editar campos + mover stage), e divide "mover status" com
   `update_opportunity_status`. Pro LLM, "mover" e "status" são quase sinônimos → escolha não-determinística.
3. **`schedule_reminder` (`risk:'safe'`)** é descrita corretamente, mas o **prompt** insiste tanto em
   "anti-hallucination de reminder" (`:377-393`, `:676`) que o modelo às vezes narra "agendado ✅" como reflexo
   condicionado mesmo sem chamar (3 casos em prod). A description está OK; o ruído vem do prompt.
4. **Descriptions longas demais** em algumas tools de bulk (centenas de chars com workflow inteiro) competem
   com o system prompt que **também** descreve o mesmo workflow — duplicação que pode gerar instrução
   conflitante.

**Amostra (verbatim) que o LLM lê e onde a ambiguidade mora:**
- `create_opportunity`: "Cria uma nova opportunity associada a um contato." — convidativa, sem guard-rail.
- `update_opportunity`: "Edita campos de uma opportunity (nome, valor, atribuir, **mover stage**). Pra mudar só
  status use update_opportunity_status." — a palavra "mover" está aqui, mas enterrada e sem exemplo.
- `update_opportunity_status`: "Muda só o status (open/won/lost/abandoned)…" — clara, mas "marcar como lost"
  soa como "mover pra etapa perdido" pro modelo.

---

## 7. RECOMENDAÇÕES PRIORIZADAS (diagnóstico — não implementado)

> Esforço: **S** ≤ 1-2h · **M** meio dia · **L** ≥ 1 dia.

### P0 #1 — FALSE CALL
1. **(S) Gate de coerência texto×tools antes de enviar.** No `processIncoming` (ou em `runWithClaude` ao
   montar `text`), se `detectHallucination` achar claim de write SEM a tool satisfatória no `tool_calls` deste
   turno, **não enviar a afirmação** — em vez de só gerar signal: forçar uma iteração extra ("você afirmou X
   mas não chamou a tool; chame agora ou corrija o texto") OU reescrever pra futuro ("vou fazer X"). Reusa o
   detector existente, vira *blocking* em vez de *observing*. (`processor.ts:786-819`)
2. **(M) Verificação determinística por família.** Para as famílias de alto risco (note, opp, reminder,
   appointment, message), checar coerência por **tool exata** e não por regex de frase — se o texto diz
   "movido pra stage X" e `tool_calls` só tem `create_opportunity`, sinalizar/corrigir (cobre o caso Henry, que
   o detector atual deixa passar). (`processor.ts:107-182`)

### P0 #2 — DUPLA-RESPOSTA
3. **(M) Lock atômico antes de QUALQUER processamento, chaveado por conteúdo+rep (não por ghl_message_id).**
   Mover o `sparkbot_dedup_locks` INSERT pra logo após `identifyRep`, antes do extract/transcribe, com a chave
   `rep_id|content_hash` e janela curta — garante que o segundo webhook (qualquer ghl_message_id) bata no
   UNIQUE e aborte. Para áudio (conteúdos diferentes), usar lock por `rep_id|timing_bucket(2s)|kind` antes de
   transcrever. (`webhook-handler.ts:254-279, 449-472`)
4. **(S) Dedup do silence-gate em proativos.** Não anexar o aviso "não tá respondendo" a cada disparo
   proativo do mesmo tick — anexar no máximo 1×/janela. Remove 18/37 dos pares percebidos como spam. (silence-
   gate + cron de proativos)

### P0 #3 — MOVER→CREATE
5. **(S) Guard-rail na description de `create_opportunity`** + **alias semântico**: adicionar à description
   "NÃO use pra mover/fechar opp existente — use update_opportunity (stage) ou update_opportunity_status
   (won/lost/abandoned)." Opcional: registrar uma tool `move_opportunity` (wrapper de update_opportunity com
   stage_id) com nome que casa a intenção do rep. (`tools/opportunities.ts:282`)
6. **(S) Regra de roteamento no prompt**: "rep diz 'mover/coloca Fulano em M3' → search/list pra achar
   opportunity_id → `update_opportunity(opportunity_id, stage_id)`; 'marcar como ganho/perdido' →
   `update_opportunity_status`; só `create_opportunity` se o contato AINDA não tem opp." Com 1 exemplo cada.
   (`prompt-builder.ts:130` / nova seção)

### Gate / tom
7. **(S) Suavizar o framing do gate no prompt** — instruir o bot a NÃO citar mecânica interna ("regra que não
   posso pular", "modo high_only", "confirmed_by_rep"); pedir confirmação de forma natural e **uma vez**.
   Reduzir as instruções redundantes de "confirma antes" espalhadas. (`prompt-builder.ts:435-437` + revisão das
   ~10 ocorrências)
8. **(S) Padronizar `confirmation_mode`** entre DB default (`medium_and_high`) e fallback de código
   (`high_only`) pra eliminar drift entre ambientes. (decisão de produto + `migration` / `processor.ts`)

### Tools mortas / higiene
9. **(S) Adicionar gatilho de `set_daily_briefing` no prompt** (hoje órfã) ou removê-la se não há feature de
   briefing ativa. Idem revisar `complete_task`/`update_task` (trigger fraco). (`prompt-builder.ts`)
10. **(S) Decidir sobre `recap_session`**: ou reforçar "SEMPRE use a tool pra recap (não responda de cabeça)"
    ou aceitar que o contexto a torna redundante e removê-la do catálogo pra enxugar o schema (economia de
    tokens no cache). (`prompt-builder.ts:797` / `tools/index.ts`)

---

### Apêndice — evidência de prod (queries em `sparkbot_messages`, agente `483ca4eb…`)
- FALSE CALL: 9 "nota salva/criada" + 3 "reminder agendado" + 1 opp, todos com `tools=[]` (de 584 msgs agente
  sem tools, em 1.203 totais).
- Dupla-resposta: 37 pares agent-agent ≤8s (20 ≤2s). Decomposição: 18 proativos, 19 conversacionais (3
  byte-idênticos). Caso testemunha: 2 webhooks "Oi" com ghl_message_id distintos, Δ=2.28ms.
- Mover→create: `create_opportunity`=19, `update_opportunity`=5, `update_opportunity_status`=2. Caso Henry:
  "Movido pra Policy Delivery" com `create_opportunity, create_opportunity` (2 duplicatas), zero update.
- `confirmation_mode` efetivo em prod: `high_only` (medium executa direto).
