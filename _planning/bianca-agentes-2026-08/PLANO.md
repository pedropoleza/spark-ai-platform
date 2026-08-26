# Bianca Amorim — separação e reativação dos agentes de IA (2026-08-26)

> Conta: **Five Rings** `cRavIlyC52vFYgJATgi7` (company `TdmQMjj86Y3LgppiB96K`, tz America/New_York).
> Pedido do Pedro (26/08, 4 frentes): (1) ativador por TAG pra SDR ligar a IA pelo
> **celular**; (2) separar as IAs por ORIGEM (tráfego pago via UTM × orgânico);
> (3) cadência de follow-up por CANAL (IG hoje, WhatsApp depois); (4) agente NOVO
> pra **novos seguidores**, com a voz da Bianca, conversacional e sem push.
>
> Este doc é o plano de execução. Ordem das fases no §6. O que depende do Pedro
> está no §8. Tudo que está escrito como "medido" foi lido do banco/API em 26/08.

---

## 1. Resumo executivo — os 6 achados que definem o plano

| # | Achado (medido) | Impacto |
|---|---|---|
| **A1** | **O agente da Bianca está praticamente mudo: 274 `targeting_skip` (222 contatos únicos) contra 4 `send_message`** desde 28/07. Motivo único: `regras de ativação não casaram`. | É o mesmo defeito D1 do caso Jussara. **Nada do resto importa enquanto isso não for resolvido** — separar IAs que não falam não muda nada. Fase 0. |
| **A2** | A regra de ativação é **uma frase exata**: `message contains "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,"` (com vírgula final), `match: all`, grupo único. | Só entra quem manda o texto do anúncio LETRA POR LETRA. Quem escreve "oi", manda áudio, ou vem de outro criativo → skip. Explica os 222. |
| **A3** | **A atribuição funciona e é rica nessa conta**: de 100 contatos recentes, **13 `Paid Social` · 67 `Social media` · 20 sem sessionSource**, e **zero sem atribuição nenhuma**. Os pagos trazem `campaign`, `campaignId`, `adId`, `utmMedium`, `utmContent`. | A separação pago × orgânico que o Pedro pediu é **viável hoje, só de config** (folha `attribution` do H74). Não precisa de tag nem de código. |
| **A4** | **O webhook `ContactTagUpdate` NUNCA chegou** — zero ocorrências em 4.319 amostras de webhook e zero `reactive_trigger_fired` do tipo `tag_added` em 60 dias na frota inteira (os 7 que existem são `custom_field_changed`, da Alves Cury). | O caminho "tag adicionada → IA age sozinha" existe no código (F27.D) mas é **letra morta**: o evento não é entregue. Ligar isso é a única parte do pedido 1 que exige trabalho de infra. |
| **A5** | A SDR **já ativa a IA manualmente** — 5 `manual_switch` entre 20 e 25/08 (usuária `Sofia Assistente`), e isso funciona porque grava `ai_resumed_at`, que **bypassa o targeting** (GU-6). | Ou seja: hoje a operação depende de alguém abrir o **desktop**. A pílula é JS injetado na UI web; **o app mobile do Spark Leads não roda JS** → no celular não existe botão. É exatamente por isso que a tag é necessária. |
| **A6** | O agente tem `objective: qualification_and_booking` mas **`calendar_id` está VAZIO**. | O runtime só busca horários com `calendar_id` preenchido (`shouldFetchSlots`). **A IA não consegue agendar nada hoje** — o objetivo mente. A conta tem 1 calendário ativo: `1:1 com Bianca Amorim` (`7esidBgOQphCRLUt4YaL`). |

**Leitura conjunta:** a conta está com 3 defeitos silenciosos empilhados (não fala com quase ninguém, não agenda, e só liga no desktop). O pedido do Pedro (separar por origem + agente de seguidores) é a camada de cima — e ela só rende depois de destravar a de baixo.

---

## 2. Inventário medido da conta

### 2.1 Agente existente
- `17860a86-ace9-4299-9328-2452151348a0` — **"Manu — Recrutamento Bianca [TESTE]"**, `recruitment_agent`, `audience=lead`, **status `active`**, criado 18/06, config tocada por último em 04/08.
- Canais: **`["Instagram"]`** · debounce **10s** · `activation_mode: gate_ongoing` · `auto_pause_on_human_message: true`.
- `objective: qualification_and_booking` · **`calendar_id: ""`** (A6) · `slot_window_days: null` (=7, default do H80).
- Persona: **"Manu"**, `identity_mode: human`, "da equipe da Bianca" — decisão de continuidade documentada em `recrutamento-marina-bianca/ANALISE-conversas-bianca.md` (a conta JÁ falava como "Manu" antes da IA).
- `custom_instructions`: 7.959 chars · `conversation_examples`: **vazio** (0 chars) — oportunidade, ver §5.4.
- `data_fields` (todos `required: true`): `state`, `work_permit`, `current_occupation`, `motivation`; opcionais: `email`, `whatsapp`.
- `follow_up_config`: `mode ai_auto`, 3 toques em **180 / 600 / 1080 min** (3h · 10h · 18h), max 3, `min_delay 10min`, `max_delay 1380min` — **cabe dentro da janela de 24h do IG** ✅ (a cadência atual está correta pro canal de hoje).
- `automations`: 1 regra `i2wnvggc` — trigger `agent_activated` → `move_pipeline` pra `1- Prospects (Social Selling)` / estágio `Contato`. **Já dispara** (5×, 20–25/08).
- `handoff_policy`: ON, `skip_if_human_replied_within_minutes: 60`, notifica rep via SparkBot.
- `lead_history_config`: ON (20 msgs, notas, tags, opps).
- `notifications`: tudo OFF.

### 2.2 Volume real (26/08)
- Inbounds na fila: **292** desde 28/07; últimos dias entre 1 e 19/dia (25/08 = 19 inbounds / 12 contatos).
- `execution_log` da location: **274 targeting_skip · 6 ai_paused_skip · 5 lead_history_loaded · 5 agent_activated_automation · 4 send_message · 3 ai_processing · 2 should_respond_skip · 1 update_field**.
- `conversation_state` do agente: **6 linhas** (4 `active`, 2 `handed_off`) — contra 222 contatos que bateram no gate.

### 2.3 Atribuição (a base do pedido 2)
Amostra dos 100 contatos mais recentes (total da conta: **6.889**):

| sessionSource (1º toque) | n |
|---|---|
| Social media | 67 |
| (vazio) | 20 |
| **Paid Social** | **13** |

- `medium`: `instagram` em 80/100 · vazio em 20.
- Campanhas vistas: `[AF] [Perp] [Captura] Msg_Direct engaj_v7` · `…engaj` · `…engaj_raio` · `…engaj v4` · `…engaj_raio_NewAds`.
- Exemplo cru de pago: `{"sessionSource":"Paid Social","medium":"instagram","campaign":"[AF] [Perp] [Captura] Msg_Direct engaj v4","utmMedium":"[ADV]_Aberto_engj","utmContent":"[VID]_09_10_17_18","campaignId":"120250544685670600","adId":"120250544685660600"}`
- Exemplo cru de orgânico: `{"sessionSource":"Social media","medium":"instagram","mediumId":"2423577894718953"}`
- ⚠️ **1º toque ≠ último toque** (confirmado, mesma lição do H74): `isa~` entrou por `Paid Social` e o último toque virou `Social media`; `thays carvalho` fez o inverso. **Default do filtro = PRIMEIRO toque** (`attribution_scope: "first"`) — quem veio de anúncio não deixa de ter vindo.
- ⚠️ Os 20 "sem sessionSource" **não casam** filtro de anúncio (o runtime só dá match em `not_contains`/`not_set` quando não há atribuição). Eles caem no balde orgânico — o que é o comportamento desejado, mas precisa estar consciente.

### 2.4 Tags (50 na conta — as que importam)
`novo seguidor` **já existe** ✅ · `agendamento` · `qualificada` / `qualificado` · `desqualificada` · `recrutar` · `follow-up ativo` · `feito follow up` · `follow up finalizado` · `follow-up recruiting` · `stale 7d` / `stale 10d` / `stale 14d` · `waiting action` · `direct agent` / `undirect agent` · `stevo bianca` / `stevo rickson` · `pessoal bia` · `contato pessoal` · `novo contato` · `sem interesse` · `client` / `cliente` (+ 4 variantes sujas: `["client"]` ×4 e `15619456059` — lixo de import).

> ⚠️ **Lição Jussara (23/08)**: tag duplicada = gatilho morto. Antes de usar qualquer tag nova, criar **UMA vez só** no painel e conferir que não existe variante com acento/caixa/espaço. As 4 variantes `["client"]` provam que essa conta já sofre disso.

### 2.5 Calendários · Pipelines · Usuários
- **Calendários (5, só 1 ativo)**: ✅ `1:1 com Bianca Amorim` `7esidBgOQphCRLUt4YaL` · inativos: `Reunião com Rickson`, `5- Game Plan`, `Alinhamento com Agentes`, `Alinhamento`.
- **Pipelines (5)**: `1- Prospects (Social Selling)` `hU4StRMnVekmux8LAZWJ` (Contato · Qualificado · Não Qualificado · Agendado · Reagendar · Compareceu · Reagendamento · Recrutado · Perdido) — é o que a automação já usa; `3- Recruiting` `YrXpR0cGxg0n0ddXcpAf` (New Lead · Follow-up · In Contact · Qualified · Interview Booked · No-show · Interview Completed · Register · Not Interested · Trying Contact · Recrutado · Estudando · Agente Licenciado); + `2- Policies`, `4- Agency`, `5- Baseshop`.
- **Usuários (9)**: Bianca Amorim (admin) · **Sofia Assistente** `0CzrNBTMgxGDx5FDayJr` (admin — é quem faz os `manual_switch`) · Emanuele Gomes (user) · Maria Cecilia · Nathalia Freitas · Rickson Amorim · Barbara Crepaldi · Paula Moreira · Tâmara Carvalho.
- **rep_identities** na location: Sofia Assistente (+1 754 971-5189, **sem aceite de termos**), Bianca Amorim (+1 561 945-6059, aceitou 20/05), Emanuele Gomes, +1 web-only.

### 2.6 O que existe do lado da Marina (fonte de reuso)
- `_planning/recrutamento-marina-bianca/SPEC.md` (46KB, 16/06) — spec consolidado dos DOIS agentes de IG: funil travado (`estado → work permit → profissão → motivação → convite`), compliance de renda, árvore de work permit em 3 ramos, regras anti-"tell de bot", janela de 24h como modelo mental.
- `ANALISE-conversas-bianca.md` (18/06) — **a voz real da Bianca já está destilada**: emoji-rica (🥰😊☺️), rapport ANTES do pitch, ancora no conteúdo/trajetória dela, personaliza pela bio, qualificação suave na abertura ("tá buscando isso ou só gostou do conteúdo?"). Documenta explicitamente a decisão de **afrouxar a parcimônia de emoji pra Bianca** (Marina contida × Bianca calorosa).
- `REVIEW-conversas.md`, `ANALISE-conversas-reais.md`, `STRESS-TEST-2026-06-28.md`, `apply-config.sql`.
- Scripts: `create-bianca-recruitment-agent.ts`, `apply-marina-bianca-prompts.ts`, `compress-bianca-prompt.ts`, `patch-bianca-1on1.ts`, `patch-bianca-prompt-hardening.ts`, `patch-bianca-sim2.ts`.
- ⚠️ **Ambiguidade a confirmar (§8.1):** "as duas contas dela" — a Bianca tem **UMA** sub-conta no Spark Leads (Five Rings). Quem tem duas é a **Marina** (Support `A62s5…` + Personal `ONRf1DUKVnfxivEGxcTj`). Assumi que "as duas contas" = o par **Marina + Bianca** (é o escopo do SPEC compartilhado) e analisei os dois. Se houver uma 2ª conta da Bianca fora dessa company, me passa o id.

---

## 3. Arquitetura alvo

### 3.1 Os dois agentes (e por que dois, não um)
| | **Agente A — Tráfego Pago** | **Agente B — Novos Seguidores** |
|---|---|---|
| Base | o `17860a86` existente (renomeado) | **novo**, nasce inativo |
| Quem entra | `attributionSource.sessionSource` **contém `Paid`** (1º toque) | tag `novo seguidor` (já existe) **e/ou** ativação manual da SDR |
| Ativação | automática pelo gate | **SDR liga** (pílula hoje; tag depois) |
| Postura | funil completo, conduz ao agendamento | **rapport primeiro**; agendamento é consequência, nunca meta do turno |
| Persona | "Manu, da equipe da Bianca" (continuidade) | **mímica da própria Bianca** (§5.3) |
| Objetivo | `qualification_and_booking` | `qualification_and_booking`, mas com prompt anti-push |
| Canais | Instagram hoje → **+ WhatsApp** depois | Instagram |
| Follow-up | 3h/10h/18h no IG; cadência longa no WhatsApp (§5.5) | **1 toque leve**, sem cobrança (§5.5) |
| Marcação de origem | `add_tag: origem-anuncio-ia` no 1º turno | `add_tag: origem-seguidor-ia` no 1º turno |

**Por que dois agentes e não um com dois prompts:** o `activation_mode`, a cadência de follow-up, o `objective` e a postura de push são **por agente** no schema atual. Um agente só obrigaria o LLM a decidir a postura por conta própria a cada turno — exatamente o tipo de "config que vive só no prompt" que o H73 provou não sobreviver ao turno seguinte.

**Risco conhecido (o mesmo do caso Marina/pós-venda):** com 2 agentes lead-facing ativos na mesma location, o roteador de inbound decide o dono assim — (1) quem já tem `conversation_state` **ganha sempre** (ativo > pausado, `updated_at` mais recente desempata); (2) só se não houver dono é que o targeting decide; (3) sem match, o 1º agente **sem regra** vira catch-all. Consequências práticas:
- **Nenhum dos dois pode ficar sem `targeting_rules`** — o sem-regra vira catch-all e engole o outro.
- Um lead que já falou com o Agente A **nunca** migra pro B sozinho (nem com a tag). A troca é a pílula/SDR — ou o fix de router descrito em §7.2.

### 3.2 Como cada pedido do Pedro se materializa
| Pedido | Mecanismo | Precisa de código? |
|---|---|---|
| 1. Tag liga a IA pelo celular | **(a)** folha `tag` no targeting = a IA responde quando o lead escreve **e** a tag está lá → **config**. **(b)** tag dispara a IA **sem o lead escrever** → depende do webhook `ContactTagUpdate` (A4) → **infra + código** | (a) não · (b) sim |
| 2. Separar pago × orgânico | folha `attribution` (`sessionSource contains Paid`, escopo `first`) | **não** — já existe (H74) |
| 3. Follow-up por canal | `follow_up_config` é único por agente; IG e WhatsApp precisam de cadências diferentes | **sim** (§5.5) |
| 4. Agente de novos seguidores | agente novo + persona + tag `novo seguidor` | não (config) — o *tag trigger* é o item (b) |
| 4b. Medir agendamento por origem | tag por origem + custom field + (opcional) calendário separado | não |

---

## 4. Fase 0 — destravar o que está quebrado (URGENTE, config-only)

> Sem isso, 222 pessoas/mês continuam batendo num gate fechado. É a fase de maior
> retorno e a de menor risco. **Nada aqui exige deploy.**

**0.1 — Trocar a regra de ativação (A2).** Sai a frase única exata; entra um conjunto v2 `match: any` com:
- folha `attribution`: `sessionSource` **contains** `Paid` (escopo `first`) → pega TODO lead de anúncio, de qualquer criativo, sem depender do texto;
- folha `message`: a frase do anúncio (mantida — cobre quem chega pelo criativo antigo);
- folha `tag`: `novo contato` / `recrutar` (a definir com a SDR — cobre o que ela marca à mão).

⚠️ **NÃO repetir o erro da Jussara**: lá o gate foi zerado (`targeting_rules = null`) e a IA passou a atender clientes, fornecedores e contatos pessoais (24 contatos, 66 mensagens, reversão no mesmo dia). A conta da Bianca **também é a operação inteira dela** — tem `client`, `contato pessoal`, `pessoal bia`, `membro da agencia`. **Gate aberto está proibido aqui.**

**0.2 — Preencher o `calendar_id` (A6)** com `7esidBgOQphCRLUt4YaL` (`1:1 com Bianca Amorim`), senão `qualification_and_booking` é decorativo. Junto: definir `slot_window_days` (sugestão **14**, mesmo racional do H80 — a agenda dela precisa ser medida antes; ver §8.4).

**0.3 — Guarda de segurança junto com a abertura do gate:** folha de EXCLUSÃO no targeting (grupo `all` com `not_contains`) pras tags `client`, `cliente`, `contato pessoal`, `pessoal bia`, `membro da agencia`, `agent`. Isso é o que faltou na Jussara.

**0.4 — Higiene:** renomear `Manu — Recrutamento Bianca [TESTE]` → `Bianca — Tráfego Pago (IG)`. É produção; `[TESTE]` no nome já confundiu na conta da Marina.

**Verificação da Fase 0 (obrigatória antes de seguir):** rodar 48h e medir `targeting_skip` × `send_message`. Meta: skip cai de ~90% pra <30%, e **zero** contato com tag de cliente/pessoal atendido. Script: `_probe-bianca-atribuicao.ts` + query de execution_log.

---

## 5. Fase 1 a 4 — as quatro frentes do pedido

### 5.1 Fase 1 — Separação por origem (config, depende da Fase 0)
1. **Agente A** ganha a folha `attribution` como gatilho primário (feito na 0.1).
2. **Agente A** carimba `add_tag: origem-anuncio-ia` no primeiro turno (via `automations`, trigger `agent_activated` — o mesmo motor da regra `i2wnvggc` que já roda).
3. **Agente B** (§5.3) recebe folha `attribution` **negativa** (`sessionSource not_contains Paid`) **+** folha `tag: novo seguidor`, em grupo `all` — assim ele nunca rouba um lead de anúncio.
4. Campanha específica (quando a Bianca quiser recortar): a folha aceita `campaign`/`campaignId`/`adId` com `contains`/`in` — dá pra ter um agente só pra um criativo sem tocar em código.

### 5.2 Fase 2 — Tag que liga a IA pelo celular (pedido 1)
Dois níveis, entregues em ordem:

**Nível 1 (config, imediato) — tag como PORTA.** Tag `ia-ligada` (nome a confirmar, §8.2) entra como folha `tag` no targeting dos dois agentes, em grupo `any`. Efeito: a SDR adiciona a tag pelo **app mobile** (o app nativo permite tag), e **quando o lead responder**, a IA assume. Não precisa de nada novo. Com `activation_mode: gate_ongoing`, **remover a tag desliga a IA** — a alavanca que a Bianca quer, no celular, nos dois sentidos.
> Limitação honesta: no Nível 1 a IA **não fala primeiro**. Ela assume no próximo inbound do lead. Pro fluxo de novos seguidores (SDR manda a 1ª mensagem, lead responde) isso é **exatamente o comportamento desejado** — ou seja, o pedido 4 não depende do Nível 2.

**Nível 2 (código + infra) — tag como GATILHO.** Pra "adicionou a tag e a IA já manda a primeira mensagem":
- **Bloqueio medido (A4):** o evento `ContactTagUpdate` não chega. O handler existe (`reactive-trigger.ts`, `kind: "tag_added"`), o roteador reconhece o tipo, a flag `PROACTIVE_EVENTS_ENABLED` está em prod há 96 dias e não há allowlist restringindo — **só o evento não é entregue**.
- **Caminho 1 (preferido, resolve pra frota):** assinar `ContactTagUpdate` no app do Marketplace do Spark Leads. Se aparecer, o fluxo inteiro já funciona sem uma linha de código. **Custo: configuração.** Validar com 1 tag de teste e conferir `inbound_webhook_samples`.
- **Caminho 2 (fallback, por conta):** workflow dentro da conta (trigger: tag adicionada → ação Webhook) postando num endpoint novo nosso com bearer, no mesmo desenho do H71 (`sparkbot-command`): valida segredo, valida location, chama `handleReactiveTrigger`. ~150 linhas + testes. Não depende da Meta nem do Marketplace.
- ⚠️ Em qualquer caminho, o guard `hasConversation` do reactive-trigger continua valendo: **não reabre conversa de quem já é atendido**. E a idempotência de 24h por `(agente, contato, evento)` evita loop se o workflow re-disparar.

### 5.3 Fase 3 — Agente B: Novos Seguidores (pedido 4)
**Registro:** `custom_agent`, `audience=lead`, `template_key=custom`, nome `Bianca — Novos Seguidores (IG)`, **nasce `inactive`**.

**Persona — a própria Bianca, em 1ª pessoa** (mesma decisão do pós-venda da Marina). A voz já está levantada em `ANALISE-conversas-bianca.md` §3 e é o insumo direto:
- calorosa, emoji-rica com bom senso (🥰😊☺️ — **nunca** 🚀💰🔥, nunca 2 iguais seguidos);
- **rapport primeiro, pitch depois** — permitir turnos de puro papo sem pergunta nenhuma;
- informal e brasileira: `vc`, `pra`, `tá`, `né`, abreviação natural, zero travessão, zero juridiquês;
- ancora no conteúdo/trajetória dela; personaliza pela bio do lead quando houver;
- **1 pergunta por vez**, reação contextual antes da próxima (nunca "entendi" genérico);
- qualificação suave em vez de interrogatório: "tá buscando isso ou só gostou do conteúdo?".

**Regra de ouro da postura (o coração do pedido 4):** o objetivo do turno é **conexão**, não agendamento. O convite só nasce quando o lead **sinaliza interesse real** ("parece bacana", "como funciona?", "quero saber mais"). Proibido: convidar 2× seguidas, insistir depois de um "não" ou de silêncio, transformar a conversa em triagem. Se o lead só quer conversar → conversa e encerra bem. **Sem push.**

**Config proposta:**
- `data_fields` **todos opcionais** (o interrogatório é o inimigo aqui): `estado`, `o_que_busca`, `hobby_interesse`, `profissao`. Sem nenhum `required` — campo obrigatório vira gate de coleta e empurra o LLM a perguntar (lição E12 da Jussara).
- `debounce`: **25s** (conversa de rapport chega em rajada curta).
- `objective: qualification_and_booking` + `calendar_id` do 1:1 (o agendamento existe, mas o prompt decide quando).
- `follow_up_config`: **1 toque leve** em ~4h, `max_attempts: 1`, tom "sem cobrança" (§5.5).
- `activation_mode: gate_ongoing` (tirar a tag desliga).
- `auto_pause_on_human_message: true` + handoff com as mesmas palavras-chave do A.
- `conversation_examples`: **preencher** com 4-6 pares reais do IG da Bianca (hoje está vazio nos dois agentes — é o insumo que mais aproxima a mímica).

**Marcação de origem:** `automations` com trigger `agent_activated` → `add_tag: origem-seguidor-ia` + `move_pipeline` pra `1- Prospects (Social Selling)` / `Contato`.

### 5.4 Fase 3b — o que falta nos DOIS prompts (achado do inventário)
`conversation_examples` está **vazio** (0 chars) no agente da Bianca. O SPEC de junho previa exemplos e eles nunca foram carregados. Isso é a alavanca mais barata de naturalidade que existe — o caso Marina (pós-venda) usou 7 exemplos reais e o stress saiu 31/31. **Ação:** extrair 6 pares reais de cada perfil (pago × seguidor) do histórico do IG e carregar.

### 5.5 Fase 4 — Follow-up por canal (pedido 3)
**Situação:** `follow_up_config.manual_steps` é **uma lista só por agente**. Hoje ela está calibrada pro IG (3h/10h/18h — cabe nas 24h ✅). Quando o WhatsApp entrar **no mesmo agente**, essa lista vira errada pro IG **ou** curta demais pro WhatsApp — não dá pra servir os dois.

O que o runtime **já faz certo** (não precisa mexer): o `follow-up-scheduler` deriva o canal do último inbound do lead, sabe que IG e WhatsApp têm janela de sessão, **cancela a sequência quando a janela de 24h fecha**, e a `janela-de-envio` (H72) empurra todo toque pra 08h–21h no fuso da conta.

**Proposta de engenharia (aditiva, ~40 linhas + testes):** `follow_up_config.steps_by_channel` — um mapa `{ "Instagram": [...], "WhatsApp": [...] }`, lido no momento do agendamento (o canal já é conhecido ali). Ausente → cai no `manual_steps` atual = **zero mudança pra frota**. Cadências propostas:
- **Instagram** (janela 24h): 3h · 10h · 18h — o que já está.
- **WhatsApp** (sem janela apertada): 1h · 1 dia · 3 dias · 7 dias, respeitando 08h–21h.
- **Agente B (seguidores), IG:** 1 toque em 4h e para.

⚠️ **Pré-requisito do WhatsApp que não é nosso:** a conta precisa do WhatsApp oficial ativo e, pra falar fora de 24h, **template aprovado pela Meta** (não existe API de criação/aprovação no Spark Leads — é manual em Settings → WhatsApp → Templates; foi o que apuramos no caso Marina em 25/08).

---

## 6. Ordem de execução (a orquestração pedida)

```
FASE 0  (config, hoje)          ── destrava o gate + calendário + guardas
   │                                verificação: 48h de métrica
   ▼
FASE 1  (config)                ── separação por atribuição + tags de origem
   │                                verificação: 20 contatos classificados certo
   ▼
FASE 2-N1 (config)              ── tag como PORTA (SDR liga pelo celular)
   │                                verificação: SDR testa em 1 contato real
   ▼
FASE 3  (config + conteúdo)     ── agente B nasce inativo + persona + exemplos
   │                                verificação: bateria de stress (LLM real, zero envio)
   ▼
FASE 3b (conteúdo)              ── conversation_examples nos DOIS agentes
   │
   ├──► FASE 2-N2 (infra/código) ── tag como GATILHO (webhook ContactTagUpdate)
   │                                 independente — pode correr em paralelo
   │
   └──► FASE 4 (código)          ── steps_by_channel + prontidão WhatsApp
                                     só quando o WhatsApp dela existir
   ▼
FASE 5  (medição)               ── painel de origem: agendamentos pago × seguidor
```

**Regra de ouro do rollout:** uma fase por vez, com **48h de medição** entre elas. O incidente da Jussara (19/08) aconteceu porque gate + prompt + escopo mudaram no mesmo dia e ninguém conseguiu isolar a causa.

---

## 7. Fila de engenharia (o que exige deploy)

| # | Item | Tamanho | Depende de |
|---|---|---|---|
| **7.1** | **Webhook `ContactTagUpdate`** (Fase 2-N2): Caminho 1 = assinatura no Marketplace (config); Caminho 2 = endpoint dedicado com bearer, padrão H71 | config **ou** ~150 linhas + testes | decisão §8.3 |
| **7.2** | **Router cede posse por tag** — hoje quem tem `conversation_state` ganha sempre, então lead que já falou com o A nunca migra pro B. Fix: quando o dono está pausado por `stop_and_handoff`/`manual_ui` **e** outro agente ativo casa por TAG, a posse cede. **É o mesmo item pendente do pós-venda da Marina** — resolve as duas contas de uma vez | ~20 linhas + testes | GO do Pedro |
| **7.3** | **`steps_by_channel`** no follow-up (Fase 4) | ~40 linhas + testes | WhatsApp existir |
| **7.4** | **IG send-guard**: canal Instagram + último inbound >23h30 → skip com `ig_window_closed_skip` em vez de erro 400 da Meta + signal high. Já desenhado no plano da Marina (§5.C) | ~30 linhas | GO (já aprovado lá) |
| **7.5** | **UI do `slot_window_days`** — hoje só via SQL (H80 subiu sem tela) | pequeno | oportunidade |

---

## 8. Decisões que dependem do Pedro

1. **"As duas contas dela"** — a Bianca tem só a Five Rings (`cRavIly…`). Quem tem duas é a Marina. Confirmar se existe uma 2ª conta da Bianca fora dessa company; senão, sigo com Five Rings + o aprendizado do par Marina.
2. **Nomes das tags** (crio 1× cada, sem duplicata): proponho `ia-ligada` (porta universal, os 2 agentes), `origem-anuncio-ia`, `origem-seguidor-ia`. A `novo seguidor` **já existe** e eu reuso — confirmar se ela hoje é aplicada por workflow (se for, o agente B liga sozinho pra todo novo seguidor, o que pode não ser o desejado no começo).
3. **Caminho do gatilho por tag** (§5.2 Nível 2): Marketplace (resolve pra frota, depende da tela do app) **ou** endpoint dedicado por conta (mais trabalho, controle total)?
4. **Janela de agendamento** (`slot_window_days`) da Bianca: preciso medir o calendário `1:1 com Bianca Amorim` em 7/14/30 dias antes de sugerir número — faço junto da Fase 0.
5. **Postura do agente B com quem some**: 1 toque leve e para (minha proposta) ou zero follow-up?
6. **Quem é a SDR** que vai operar pelo celular — assumi a **Sofia Assistente** (é quem faz os `manual_switch`). Ela **não tem aceite de termos** no SparkBot; se for receber notificação de handoff por WhatsApp, precisa aceitar antes.
7. **Renomear** `Manu — Recrutamento Bianca [TESTE]` → `Bianca — Tráfego Pago (IG)`: ok?

---

## 9. Riscos e rollback

| Risco | Mitigação | Rollback |
|---|---|---|
| Abrir o gate e a IA atender cliente/contato pessoal (**repetir a Jussara**) | folha de exclusão por tag (0.3) + rollout medido de 48h | `targeting_rules` tem backup verbatim no script de apply; `--revert` restaura |
| Dois agentes brigando pelo mesmo lead | nenhum dos dois sem regra; agente B com `not_contains Paid` | desativar o B (`status=inactive`) — o A volta a ser único |
| Agente B soar "vendedor" e espantar seguidor | prompt anti-push + stress conversacional antes de ligar + nasce inativo | `status=inactive` |
| Tag aplicada em massa por workflow ligando a IA pra base inteira | usar tag NOVA e exclusiva pro gatilho; conferir workflows que aplicam `novo seguidor` | remover a folha de tag do targeting |
| Follow-up do WhatsApp fora de hora | `janela-de-envio` (H72) já força 08h–21h no fuso da conta | — |

---

## 10. Registro de execução

- **2026-08-26** — Levantamento completo (este doc). Medições: 274 skip × 4 send; atribuição 13 Paid / 67 Social / 20 vazio em 100 contatos; `ContactTagUpdate` = 0 ocorrências em 4.319 amostras; `calendar_id` vazio; 5 `manual_switch` da SDR. Probes criados: `_probe-bianca-contas.ts`, `_probe-bianca-atribuicao.ts`, `_probe-bianca-inventario.ts` (todos read-only). **Nada foi alterado na conta.**
