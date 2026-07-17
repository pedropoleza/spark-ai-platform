# Revisão geral — problemas reportados pela Jussara (2026-07-16)

Location: `pGl5pqLLG0QDixANpFnP` (America/New_York). SparkBot rep Jussara
Ferreira `8dc0cb84-…` (+16892033343). IA de atendimento (lead-facing):
**"Jussara Lima — Vendas"** `a297dadc-873a-4803-885d-472c65414168` (sales_agent,
audience=lead, ativo).

Fonte: lista de 8 pontos que a Jussara mandou (15–16/jul). Investigação via
`execution_log`, `agent_configs`, `sparkbot_messages` (prod).

---

## Triagem — o que é NOSSO vs. sistema

| # | Reclamação (telefone) | Sistema | Veredito |
|---|---|---|---|
| 1 | "chat continua perguntando qual cliente" (860-890-9332) | **SparkBot** | NOSSO — atrito de desambiguação (não é bug) |
| 2 | "não responde os patrocinados" (Thais Guimarães) | **IA atendimento** | NOSSO — **targeting restritivo demais (P0)** |
| 3 | "pedi tag triagem e ela não recebeu as msgs" (774-340-8187) | SparkBot + GHL | **PARCIAL** — SparkBot põe a tag ✅; as msgs são automação do GHL (sistema) |
| 4 | tag "Contato de Emergência" não inicia fluxo (773-301-9220) | GHL | **SISTEMA** — 0 automações nossas nesse agente; é workflow do GHL |
| 5 | "fluxo para depois que o cliente responde" (754-291-9556) | **IA atendimento** | NOSSO — **auto-pause F52 engolindo msgs (P0)** |
| 6 | "robô parou de responder" (609-600-0703) | **IA atendimento** | NOSSO — mesma raiz do #5 |

**Números que provam (execution_log, últimas 48h do agente da Jussara):**
`targeting_skip` = **42** · `ai_paused_skip` = **12** · `send_message` = 16 ·
`ai_processing` = 14. Ou seja: o agente **pulou muito mais do que respondeu**, e
por 2 motivos: targeting e auto-pause.

---

## Root cause #2 — Targeting restritivo demais (P0, IA de atendimento)

**Config atual** (`agent_configs.targeting_rules` do `a297dadc`):

```
match=all → grupo g0 (match=any):
  • message CONTÉM "Tenho interesse e queria mais informações"  OU
  • tag = "ai qualification active"
```

O agente **só responde** se a mensagem tem AQUELA frase exata **ou** o contato já
tem a tag `ai qualification active`. Lead de anúncio (patrocinado/metaads) que
escreve qualquer outra coisa e ainda não recebeu a tag → **pulado em silêncio**
(`targeting_skip`, "regras de ativação não casaram"). Foram **42 skips** em 2
dias. É exatamente o "não responde os patrocinados / Thais Guimarães".

Os próprios contatos dela têm tags `metaads` / `patrocinados` (vi na
desambiguação do SparkBot) — mas o targeting não reconhece essas tags.

**Fix (config, rápido):** afrouxar o targeting da Jussara. Opções:
- (A) adicionar as tags de origem de anúncio (`metaads`, `patrocinados`) como
  gatilho no grupo `any`; **ou**
- (B) trocar pra "responder a todos os inbounds" (remover targeting) se a
  intenção dela é a IA atender TODO lead que chega; **ou**
- (C) garantir que a automação do GHL que aplica `ai qualification active` cubra
  os leads de anúncio (isso é GHL/sistema — depende dela).

Recomendo **(A) ou (B)** porque não depende de automação externa. É mudança de
config (posso aplicar via UI/script) — decidir com a Jussara qual comportamento
ela quer (responder a todo mundo vs. só qualificados).

**Follow-up de produto (código):** o `targeting_skip` é **silencioso** — a
Jussara só descobriu reclamando. Adicionar telemetria/resumo ("a IA pulou N
leads por não casar o targeting nas últimas 24h") no painel dela, pra flagrar
targeting mal-configurado sem depender de reclamação.

---

## Root cause #5/#6 — Auto-pause F52 engolindo mensagens (P0, IA de atendimento)

**Todos** os `ai_paused` / `ai_paused_skip` têm motivo
`auto_pause:human_message:history` (trigger `F52_history_fallback`), com
`messages_swallowed: 1–2` por skip. Um contato (`YmxiYv2j…`) foi pausado **6×
numa manhã** — a IA "achou" que um humano assumiu a conversa e se **auto-pausou**,
engolindo as respostas do lead. É o "para de responder depois que o cliente
responde".

**Mecanismo** (`lead-history.ts` `isHumanOutboundMessage` + `message-sources.ts`):
a IA classifica um outbound como "humano assumiu" e pausa. A classificação já foi
endurecida (casos Alves Cury/Marina: automação welcome/workflow do GHL não conta
como humano). **Resíduo de falso-positivo:** quando o GHL devolve a mensagem
**sem `source`** mas **com `userId`**, cai no fallback por `userId` (com anti-eco
via `aiTexts`). Uma msg de **automação do GHL** (a Jussara roda várias: triagem,
emergência) que chegue sem source + com userId, e que não bata no anti-eco, é
classificada como humano → **pausa indevida**.

> Conexão com #3/#4: as automações do GHL da Jussara (triagem, emergência)
> mandam mensagens; se essas mensagens estão envenenando a detecção de "humano",
> os fluxos DELA (sistema) estão causando a pausa da NOSSA IA. Une os 4 casos.

**⚠️ VALIDAR ANTES DE MEXER:** preciso confirmar, num contato pausado real
(pegar o GHL conversation de `YmxiYv2j…` ou dos telefones 754-291-9556 /
609-600-0703), **qual mensagem** o F52 classificou como humano. Dois desfechos:
- **Falso-positivo** (automação/eco virou "humano") → endurecer
  `isHumanOutboundMessage` (o fallback por userId): não contar como humano
  outbound cujo `messageType`/janela indica automação; exigir sinal humano mais
  forte. É o **F56 pendente** ("não confiar no source / anti-eco"), agora com
  caso real.
- **Correto** (a Jussara ou o time — Brenda/Eduarda — respondeu de verdade no
  inbox) → a pausa está certa; o problema é de **expectativa/visibilidade**: a
  Jussara não sabe que a IA pausou porque um humano falou. Nesse caso o fix é
  **avisar** ("pausei a IA da Fulana porque alguém do time respondeu — quer
  retomar?") + retomada fácil.

**Em QUALQUER desfecho:** o auto-pause hoje é **silencioso** pro lado da Jussara
(engole msg sem avisar). Fix comum: quando auto-pausar por histórico, **emitir
sinal + notificar** (reusar `handoff-notify`/SparkBot) — nunca engolir mensagem
de lead sem deixar rastro visível pra ela.

---

## Root cause #1 — SparkBot pergunta "qual cliente" demais (P1, atrito real)

**Não é bug** — o SparkBot está **desambiguando corretamente**. A Jussara tem uma
base cheia de **nomes duplicados** de anúncios: apareceram **5 "Mônica"** e
várias "Marcia" na mesma conversa. Quando ela diz "coloca tag na Mônica", há 5
Mônicas → o bot pergunta qual (e acerta: "Tag triagem adicionada na Marcia
Lopes ✅"). Do ponto de vista dela, "ele fica perguntando".

**Fix (melhoria, H47 Contact Engine V2 — estudo já existe):**
- **Memória de foco:** lembrar o último contato referido na conversa (ela acabou
  de falar da "Mônica das 6h" → herdar) em vez de re-perguntar do zero.
- **Desempate por recência/contexto:** priorizar o contato com interação mais
  recente / que casa com o assunto (apólice, horário citado).
- Não é reescrever o resolver — é ligar herança de foco + ranking (F1/F8/F10 do
  plano H47 em `_planning/sparkbot-contact-engine-v2/`).

Atenuação imediata (sem código): as duplicatas são um problema de dados —
sugerir à Jussara mergear/limpar os duplicados no Spark Leads reduz o atrito na
hora.

---

## #3 e #4 — Fluxos por tag (triagem / Contato de Emergência) = automação do GHL

O agente da Jussara tem **0 automações no nosso motor** (`agent_configs.automations
= []`). Logo, os fluxos que a tag "triagem" e "Contato de Emergência" deveriam
disparar **não são nossos** — são **workflows do GHL** que a Jussara montou
(bate com o `manual_context` dela: "tag triagem dispara a automação do Spark
Leads"). Então:

- **#3:** a parte NOSSA (SparkBot pôr a tag) **funciona** — vi "Tag triagem
  adicionada ✅". As mensagens que deveriam seguir são da automação do GHL
  (sistema). Se não saíram, é lá. **👤 Confirmar com a Jussara/Pedro**: é a
  automação do GHL ou ela esperava que fosse nosso follow-up?
- **#4:** idem — "Contato de Emergência" não existe no nosso código; é workflow
  do GHL. **Provável "sistema" → ignorar** (conforme você disse), salvo se você
  quiser que a gente passe a disparar esses fluxos pelo nosso reaction-engine
  (F27.D — dá pra ligar tag-trigger nosso, mas é escopo novo).

> **Ponto de atenção que CRUZA:** mesmo sendo do GHL, esses fluxos podem estar
> causando o #5/#6 (as mensagens deles envenenando a detecção de humano). Então
> vale investigar o #5/#6 mesmo tratando #3/#4 como sistema.

---

## Plano de correção (ordem sugerida)

**P0 — hoje (destrava a Jussara):**
1. **Targeting (#2):** decidir com a Jussara "responder a todos" vs. "incluir
   metaads/patrocinados" → aplicar no config (UI ou script). Additive, reversível.
2. **Validar o auto-pause (#5/#6):** puxar o GHL conversation de 1–2 contatos
   pausados → confirmar se é falso-positivo (automação/eco) ou humano real.
   Decide o fix exato.

**P0/P1 — na sequência (o fix de código do #5/#6):**
3. Conforme a validação: endurecer `isHumanOutboundMessage` (F56) **ou**
   melhorar visibilidade/retomada da pausa. **Em ambos:** parar de engolir msg
   de lead em silêncio — emitir sinal + notificar a Jussara.

**P1 — melhoria (#1):**
4. Ligar herança de foco + ranking de recência no Contact Engine (H47 F1/F8/F10)
   pro SparkBot parar de re-perguntar com base duplicada. + sugerir limpeza de
   duplicados.

**👤 Decisão da Jussara/Pedro (#3/#4):**
5. Confirmar que triagem/emergência são workflows do GHL (sistema) → ignorar; ou
   pedir pra migrarmos pro nosso reaction-engine (escopo novo, F27.D).

**Transversal — tirar do silêncio:**
6. `targeting_skip` e `auto_pause` são invisíveis pra ela hoje. Surface no painel
   + notificação — pra próxima config errada aparecer sem depender de reclamação.

---

---

## PROGRESSO (2026-07-16)

### ✅ #2 Targeting — APLICADO em prod
`UPDATE agent_configs.targeting_rules` do `a297dadc`: adicionadas as tags
`metaads` e `patrocinados` ao grupo `any` (aditivo). Agora a IA responde a lead
de anúncio que tenha essas tags. **Reverter** = restaurar o valor antigo:
```json
{"match":"all","version":2,"groups":[{"id":"g0","match":"any","rules":[
  {"id":"t1","type":"message","message_operator":"contains","message_value":"Tenho interesse e queria mais informações"},
  {"id":"81qoc6ee","type":"tag","tag":"ai qualification active"}
]}]}
```
Nada de código/deploy — só config. Efeito imediato no próximo inbound.

### 🔬 #5/#6 — root cause REFINADO (validado em prod, mudou a hipótese)

Puxei a conversa REAL de 3 contatos pausados (`scripts/diag-jussara-autopause.ts`).
**Descoberta que mudou o diagnóstico:** na conta da Jussara (Stevo/WhatsApp)
**TODA mensagem tem `source="api"`** — IA, Brenda digitando manual, E automação
do GHL, tudo "api". A minha 1ª hipótese (no-source+userId) estava errada.

O pause usa `classifyLastOutbound` (`human-takeover.ts`), escada:
1. source ∈ AUTOMATION_SOURCES → não-humano — **mas "api" NÃO está nesse set** → passa
2. eco da IA (bate `aiTexts`) → não-humano
3. tem `userId` → **humano** ← automação rodando "como user" (ex: template
   quebrado "Oi Nome do Cliente") cai aqui → falso-positivo
4. IA nunca falou → não-humano
5. sem texto (áudio/mídia/reaction) → **humano** ← frota manda áudio/reaction o tempo todo
6. texto + IA já falou + não bate eco → **humano** ← eco não-logado da própria IA cai aqui

**Ou seja:** com tudo em `source="api"`, a escada não distingui IA × humano ×
automação e cai nos passos 3/5/6 como "humano assumiu" → **auto-pausa e engole o
lead, em silêncio** (o `return` na linha 771 NÃO notifica a Jussara).

**Mix real:** alguns pauses são CORRETOS (a Brenda realmente atende manual muitos
contatos — vi "Aqui é a Brenda, assistente da Jussara"); outros são FALSOS
(template de automação "Oi Nome do Cliente"; áudio; reaction 👍; eco da IA não
logado). É por isso que **não dá pra patchar `classifyLastOutbound` às cegas** —
essa função carrega 6+ fixes (Marina/Vandinha/Marcela Lana/Alves Cury) e um erro
aqui regride outras contas.

**Recomendação (2 frentes, precisam do teu OK no approach):**
- **(a) Tirar do silêncio (seguro, sem regressão):** quando o auto-pause por
  HISTÓRICO dispara, **notificar a Jussara** via SparkBot (deduped/cooldown) —
  "pausei a IA da [contato] porque parece que alguém respondeu; se foi engano me
  avisa que retomo". Não muda QUEM pausa, só torna visível + reversível. Ataca a
  reclamação real ("parou e eu não soube").
- **(b) Reduzir falso-positivo (targeted, baixo risco):** detectar **placeholder
  não-interpolado** no corpo ("Nome do Cliente", "[nome]", "{{...}}") → é
  automação, não humano (humano não digita isso). Pega o caso "Oi Nome do
  Cliente".
- **(c) Decisão de produto (tua/da Jussara):** numa conta onde o time atende
  manual por WhatsApp (tudo "api"), o auto-pause-on-human é intrinsecamente
  guessy. Vale decidir se pra ela o comportamento certo é "pausa quando o time
  toca" (atual, mas chuta) vs. "só pausa via pause explícito no painel".

**NÃO mexer ainda no `classifyLastOutbound` sem alinhar o approach.**

---

## Confiança

- #2 targeting: **confirmado** (config + 42 skips no log).
- #5/#6 auto-pause: **causa confirmada** (12 skips `human_message:history`);
  falta **validar falso-positivo vs. humano real** antes do fix de código.
- #1 desambiguação: **confirmado** (base duplicada, bot acertando).
- #3/#4: **confirmado que não há automação nossa** → sistema/GHL (a menos que se
  queira migrar).
