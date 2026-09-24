# Resposta ao council — conta Jussara (`pGl5pqLLG0QDixANpFnP`), 24/09

Responde o brief de 23/09. Tudo abaixo foi medido hoje no banco da AI Platform e
no Spark Leads da conta. Nada foi mandado pra cliente. **Nada foi mudado em
produção** — o único código tocado é um fix que está commitado e aguarda deploy
(item 8). Onde eu discordo da premissa do brief, está marcado.

---

## 1. SparkBot, agenda: o que causou o timeout

**Não é da agenda nem da conta dela.** São 7 ocorrências, 4 reps, 4 ferramentas
diferentes — todas chamadas ao Spark Leads:

| quando (UTC) | rep | ação que estourou |
|---|---|---|
| 16/09 02:06 | Daniely Jones | `search_contacts("sidney")` |
| 16/09 02:06 | Daniely Jones | `search_contacts("Sidney")` |
| 16/09 20:33 | Milton De Abreu | `create_contact(...)` |
| 16/09 23:10 | Milton De Abreu | `list_calendars({})` |
| **18/09 09:38** | **Jussara** | `list_appointments({when:"today"})` |
| **19/09 10:30** | **Jussara** | `list_appointments({when:"today"})` |
| 19/09 13:15 | Gustavo Couto | `search_contacts("+13059874088")` |

Ferramenta diferente a cada vez = não é bug de ferramenta. É o `withDeadline`
(H52, teto de 30s por tool) cortando chamada lenta ao Spark Leads. A mensagem que
ela viu é o resultado sintético honesto desse corte.

**Causa: é o H93, nas duas fases.** Primeiro a saturação do banco de tokens
(291.731 leituras em 24h pra ler uma linha; queries triviais em 11-14s) — é o que
explica 16 a 18/09. Depois o apagão de auth completo — é onde cai a ocorrência
dela de 19/09 10:30 UTC, já com o company token vencido (venceu 19/09 06:00 UTC).

**O que foi feito:** cache de company token com TTL 5min e trava de >3h pro
vencimento (`f625a63`, 21/09); re-autorização do app; e a causa raiz, o
`client_id` obsoleto no ambiente (`66b5729`, 22/09).

**Desde quando está normal:** última ocorrência da frota inteira é **19/09 13:15
UTC**. Cinco dias limpos. Consulta pra repetir a medição:

```sql
select created_at, rep_id from sparkbot_messages
where content ilike '%demorou demais%' and created_at > '2026-09-19T14:00:00Z';
-- hoje: 0 linhas
```

**Sobre o teste real que vocês pediram:** o modo de teste (`agent_test_sessions`)
é do agente LEAD-FACING; ele não exercita as tools do SparkBot. Pra validar a
ação de agenda do SparkBot sem entregar nada a ela, o caminho é
`scripts/diag-briefing.ts +16892033343`, que mostra exatamente o que o briefing
dela enxerga hoje e se seria enviado ou descartado — sem mandar mensagem.

---

## 2. SparkBot, lembrete de 17/09 19:44 — **o lembrete estava certo**

Achei o lembrete e ele bate em todos os campos:

- Evento real no Google: **"Encontro Generozidade Marcio michelli 8pm"**,
  17/09 às **20:00 ET** (via `/calendars/blocked-slots`).
- 09:12 ET ela pediu a agenda; 09:13 ET pediu "uma hora antes de cada compromisso".
- O bot respondeu: *"Lembrete do Encontro Generozidade agendado pra 7:00 PM ✅"*.
- `assistant_scheduled_tasks` `140d389e`: `next_run_at` **23:00:00Z = 19:00 ET**,
  `last_run_at` 23:00:01Z, `status` completed, texto
  *"começa em 1 hora (8:00 PM)"*.

19:00 ET, uma hora antes das 20:00, exatamente o que ela pediu.

**Não é fuso.** O brief aponta que `ghl_users[].timezone` dela está null, e está —
mas quem decide o horário do lembrete não é esse campo. O runner resolve pelo
`locations.timezone`, que está `America/New_York` (correto). O
`rep_identities.timezone` do topo também está `America/New_York`, confirmado em
29/07. O null do `ghl_users` é inerte aqui.

**O que eu não consigo ver:** o print. Ele está no grupo de suporte (spark-os),
não nas nossas tabelas. Como o lembrete de 17/09 está certo e os cinco de 18/09
também estão (conferi um a um), **preciso do print pra saber a qual mensagem ela
se refere**. Hipótese mais provável: um lembrete de reunião mandado por workflow
da própria conta, que não é nosso — a conta tem
`(ST) Lembretes de agendamento General Booking` ativo.

---

## 3. Thamires — ela já existe, e o telefone está quebrado

`atoeKPvZ6ixu1GyjLFdp`, **Thamires Ferraz**, `thamireslferraz@gmail.com`, admin.
O palpite do brief estava certo.

**O telefone cadastrado é `+77991740455`.** `+7` é Rússia/Cazaquistão. São 11
dígitos com `9` na terceira posição, que é o padrão de celular brasileiro (H70):
quase certamente é **`+55 77 99174-0455`** (DDD 77, Bahia) salvo sem o código do
país. Qualquer notificação mandada pra esse número hoje vai pro lugar errado —
provavelmente é essa a razão de ela não receber nada, e não falta de cadastro.

**Recomendação: notificação interna no workflow, não cadastrar como rep.**

Motivo: a confirmação que a Jussara recebe **não vem do SparkBot** — vem de
workflow da conta. Medi os avisos `*⚡SPARK LEADS:* 📅 New Appointment` nos
últimos dias: saem por `source: workflow` pra 3 destinos fixos. Cadastrar a
Thamires como rep no SparkBot não faria essa mensagem chegar nela; faria ela
receber o ASSISTENTE (que custa crédito de IA, exige aceite de termos e é outra
coisa). Passo a passo:

1. 👤 Confirmar com ela o número (o Pedro já ia perguntar). Esperado: `+5577991740455`.
2. Corrigir o telefone do usuário `atoeKPvZ6ixu1GyjLFdp` no Spark Leads — vale
   por si, está errado hoje.
3. No workflow `(ST) Lembretes de agendamento General Booking`
   (`466db83a-5870-4185-af57-bde3a063f090`), no passo de notificação interna,
   acrescentar o número dela junto dos que já estão lá.

Passos 2 e 3 são no painel; a API do Spark Leads não publica/despublica nem
edita workflow (só põe e tira CONTATO de fluxo).

---

## 4. Religar com guardrails — pronto, aguardando OK

### 4c primeiro, porque a premissa do brief está incorreta

**O agente NÃO atende toda conversa da conta.** O brief olhou `targeting_mode`
(`tag`) e `targeting_tag` (`null`) — essas duas colunas são legado. Quem governa
é `targeting_rules` v2, e ela está preenchida com o gate-ponte de **8 folhas**
montado em 19/08:

```
grupo "g-lead-anuncio" (match: any)
  tags:   ctwa-lead · anuncio · anuncio-instagram · metaads · patrocinados ·
          "ai qualification active"
  frases: "Tenho interesse e queria mais informações"
          "Olá gostaria de saber mais sobre o seguro em vida"
```

Isso já foi medido contra a produção em 07/09: das 48 conversas paradas na conta,
o gate **barrou corretamente 38** (grupo, `active client`, mentoria,
`importado-kommo`) e deixaria passar só os 10 de anúncio. Não há risco de
responder cliente fechado ou grupo. **Nada a mudar aqui.**

### 4a — saúde antes de agendar

Duas metades, porque só uma delas é garantia:

- `has_disease` e `takes_medication` → `required: true`. Isso é **prompt** (vira
  "OBRIGATORIO" na seção de dados) e faz o agente PERGUNTAR. Não é o que impede
  de agendar.
- O que impede é uma **automação determinística**: `on_data_field_set` com
  `matches_regex ^\s*sim\b` → `send_text_fixed` (avisa o lead) → `add_tag`
  (`saude-handoff`) → `pause_ai`. Roda no `reaction-engine`, fora do LLM.

Regex em vez de `equals "sim"` porque o campo às vezes vem `"sim, tenho
diabetes"` — medido na frota. O operador é case-insensitive, então `"Sim"` também
casa. `"assim que puder"` não casa (âncora `^`).

⚠️ **"nota do motivo" não existe como ação.** O motor tem add_tag, remove_tag,
move_pipeline, create_opportunity, update_field, send_media, send_text_fixed,
pause_ai e webhook. O equivalente é a tag `saude-handoff` mais o
`ai_paused_reason` no `conversation_state`. Se a nota no contato for requisito,
é ação nova no motor — me digam.

⚠️ **Contexto que o brief não tinha:** em 19/08 esta conta já teve incidente por
campo obrigatório. Quatro campos `required` faziam o agente interrogar e
**travavam o agendamento** (registrado como E12 em `DEFEITOS-2026-08-19.md`); a
correção foi deixar só `state`. Estou reintroduzindo obrigatoriedade em dois
campos **de propósito** — a intenção aqui é justamente travar — mas é o mesmo
mecanismo que deu problema. Vale vigiar nos primeiros dias.

### 4b — janela de atividade

Proposta: **08:00–21:00 ET, todos os dias** (`working_hours`, `only_during`).

**Fora da janela o inbound não é descartado.** Ele entra na fila com
`process_after` = próxima abertura, e o cron responde quando abre. Ou seja: lead
que escreve 02:00 **é respondido às 08:00**. Não existe modo "ficar em silêncio"
— é responder de manhã ou não ter janela nenhuma. Recomendo a janela.

O custo declarado: lead que escreve 02:00 espera 6h. Se isso incomodar mais que a
mensagem de madrugada, dá pra abrir 07:00 e fechar 22:00.

⚠️ `quiet_hours` na config dela (21:00–08:00, hoje `enabled:false`) **não serve**:
o lead-facing não lê esse campo em lugar nenhum. É config salva e ignorada.
Quem vale é `working_hours`.

⚠️ O `schedule` precisa ir preenchido. `enabled:true` com schedule vazio é
exatamente o caso Jussara de 13/07, que calou a conta inteira; hoje há fail-open
e sinal, mas não se deve chegar lá. O teste A3 cobre isso.

### 4d — continuidade do menu

`entry_by_automation = true` (H90). A IA **cala na primeira mensagem** (o clique
do anúncio, que o workflow já responde com apresentação + menu) e assume da
segunda em diante — o `"2"` do lead.

E a apresentação não se repete porque o histórico que a IA carrega vem da
conversa do Spark Leads: as duas mensagens do workflow entram como turnos
anteriores, então `priorTurnCount > 0` e o runtime entra no ramo "REGRA ABSOLUTA
DE NÃO-REPETIÇÃO" (não saúda, não diz o nome, começa direto no assunto).
Confirmado nos transcripts do 4f: o primeiro turno da IA é
*"Seguro de Vida com benefício em vida protege a família..."*, sem saudação.

**Sobre o workflow:** em 07/09 ele fazia o funil INTEIRO (abertura, menu,
resposta e link de agenda) e religar teria mandado tudo em dobro. Re-medi hoje:
foi aparado. Nos últimos 12 dias, as únicas mensagens de workflow que chegam a
lead de anúncio são a abertura (21×) e o menu (21×). O "Que ótimo!" e o link de
agenda sumiram. **O conflito que travava a religação em 07/09 não existe mais** —
o workflow entrega exatamente no ponto onde a IA assume.

### 4e — regra do "não sou robô"

Intacta, não toquei. Teste A4 verifica que continua lá.

### 4f — testes

`scripts/test-jussara-guardrails.ts`. Não escreve nada: lê a config real, aplica
o patch **em memória** e roda contra ele. **28 de 28 passando.**

Dividi em duas partes de propósito, porque o guardrail mora na primeira:

**A — gates determinísticos (24 testes), rodando as funções de produção:**
entrada pela automação (cala no 1º, assume no 2º, não repete, respeita "Ativar
IA"); handoff por saúde (sim / Sim / "sim, tenho diabetes" disparam; "não" e
"assim que puder" não; campo inalterado não redispara; ordem das ações);
janela (02:00 fora, 09:00 dentro, 20:59 dentro, 21:30 fora, sábado dentro,
schedule não-vazio); e o que não pode ter mudado (targeting 8 folhas, regra do
robô, `stop_and_handoff`).

**B — conversa com o LLM real (4 testes):** B1 lead saudável percorre estado →
doença → remédio → **agenda** (`status=booked`, `book_appointment`). B2 lead com
câncer grava `has_disease: "sim"`, e o teste confirma que a automação dispararia.

⚠️ **Ressalva séria nos transcripts:** minha `.env.local` não tem
`ANTHROPIC_API_KEY` (ela só existe na Vercel), então o B rodou no **fallback
gpt-4.1-mini**, não no `claude-sonnet-4-6` de produção. A parte A independe de
modelo e vale como está. **Os transcripts provam que o prompt está bem montado,
não como o Sonnet vai se comportar.** Pra fechar isso: ou me passem a key pra
rodar local, ou fazemos as 3 sessões pela UI de teste do /hub (que roda na Vercel,
com a key certa) antes do OK.

O cenário 3 (02:00 ET) é determinístico e não passa pelo LLM: a mensagem é
enfileirada com `process_after` = 08:00. Está no teste A3, não há transcrição a
mostrar.

⚠️ **Residual conhecido:** se o lead responder doença e remédio na MESMA
mensagem, as duas regras disparam no mesmo turno e ele recebe o texto de handoff
duas vezes. Janela estreita (nos testes o modelo pergunta em turnos separados, e
a primeira regra já pausa a IA), mas é real. E como a reação roda DEPOIS da
resposta do LLM, o lead recebe a última pergunta do agente e só então o texto de
handoff — fica levemente fora de ordem. Dá pra resolver com uma linha no
`custom_instructions`, mas não mexi porque vocês pediram pra preservar o prompt.

### 4g — tempo entre o OK e a IA respondendo

```
npx tsx scripts/jussara-guardrails.ts --apply    # config, ~2s
npx tsx scripts/religa-jussara.ts --apply        # status=active, ~2s
```

Segundos. Não há deploy no caminho — é linha de banco, e o webhook lê a config a
cada inbound. Reversão: `--revert` no primeiro, `pause-jussara-agora.ts` no
segundo.

Religar **não responde o passivo**: a fila está vazia (o webhook descarta antes
de enfileirar quando não há agente ativo), então só mensagem nova entra.

---

## 5. O apagão de 35 horas — datas, e esta conta

Company token venceu **19/09 06:00 UTC (02:00 ET)**; última cobrança OK 01:21 ET;
integração fora por **35h**; 44 `send_message` lead-facing todos com
`success=false` na frota.

**Esta conta foi atingida, mas de raspão** — porque a IA de vendas já estava
desligada desde 23/08, então não havia envio lead-facing pra falhar. O dano
mensurável é uma interação: o pedido de agenda dela de **19/09 06:30 ET**, que é
justamente a ocorrência do item 1. Fora isso, `usage_records` da location no
período: 17/09 8 registros, 18/09 10, 19/09 3, **todos cobrados, nenhum sem
cobrança**; 20 e 21/09 sem atividade nenhuma.

Ou seja: o apagão não é a causa dos chamados dela sobre lead sem resposta. A
causa é o agente estar inativo.

---

## 6. Fila: não existe card pra esta conta

Varri o board (todos os projetos). Nenhum card cita esta location. Os dois cards
abertos do projeto da plataforma são a rotação do secret do Zoom e o lote A de
integrações.

O que existe é sinal, aberto e gritando desde 07/09 — e é aí que está o número
que vale a pena vocês terem:

| sinal | desde | ocorrências |
|---|---|---|
| `Inbound: location tem agente lead-facing, mas nenhum ATIVO` | 07/09 06:04 | **11.905** |
| `Conta muda: agente lead-facing desligado e ninguém religou` | 07/09 13:00 | 17 (1/dia) |

O primeiro conta **mensagens que bateram na porta fechada** desde 07/09 — não são
11.905 leads (a conta inteira dela passa por ali: grupo, cliente, colega), mas é a
ordem de grandeza do silêncio. O segundo é o vigia diário. Os dois foram
construídos em 07/09 exatamente por causa desta conta, e o último disparo do
primeiro é de **hoje, 03:00 UTC**.

---

## 7. O que vocês não perguntaram

**a. A conta está muda há 32 dias, não desde os chamados.** Desligada em 23/08
22:11 UTC. `message_queue` e `execution_log` da location: **zero linhas desde
01/09**. Os chamados #276/#331/#349/#384 são o sintoma chegando com atraso.

**b. O motivo do desligamento que vocês têm é melhor que o meu.** Quando apurei
em 07/09, o desligamento de 23/08 não tinha justificativa registrada em doc nem
em commit — só constatei que foi manual (UI ou `pause-jussara-agora.ts`; não há
desativação automática no código). O brief de vocês traz o caso de 17/08 (agendou
pessoa em tratamento de câncer sem perguntar saúde). Isso fecha a lacuna e é
exatamente o que o guardrail 4a endereça. Vou registrar nos nossos docs.

**c. `has_disease` já tinha 2 "sim" gravados na frota** antes de qualquer
guardrail existir — o agente já coletava o dado e seguia agendando. O campo
existia; o que faltava era alguém agir sobre ele.

**d. Achei um buraco e corrigi (aguardando deploy).** O `pause_ai` do motor de
automações era a única forma de parar a IA que **não avisava ninguém**. O alerta
`ia_pausada` (H83) só estava enganchado no loop de falha de parse. Sem isso, o
handoff por saúde que vocês pediram pausaria a conversa e o lead ficaria
esperando um humano que não sabe que ele existe — a mesma classe do caso que
originou estes chamados. Corrigido: `pause_ai` agora dispara `alertarAtendimento`.
Vale pra frota (a conta da Fabiana tem uma desqualificação com o mesmo desenho).
Por isso a config proposta inclui `notifications.alerta_whatsapp` apontando pro
`+16892033343`.

**e. `active_hours` não é o que parece.** O brief cita o módulo
`agent_module_instances` com `settings` vazio. Esses módulos são da plataforma
modular (H35), que roda atrás da flag `AGENT_MOTOR_UNIFIED` — default OFF. Todos
os 5 módulos dela estão com `settings: {}` e `updated_at` igual ao `created_at` de
22/06: nunca foram tocados e não governam nada hoje. O controle real é
`agent_configs.working_hours`.

**f. Os outros dois reps da conta nunca aceitaram os termos.** Eduarda
(`+5561994096070`) e Brenda (`+5561995853584`) estão em `rep_identities` com
`terms_accepted_at` null. Não afeta a IA de vendas, mas significa que o SparkBot
não fala com elas.

---

**g. O guardrail 4d ia importar um bug vivo — achado e corrigido (H96).**
Fui verificar se o turno 2 realmente chega na IA com `entry_by_automation`
ligado. Não chegava.

A linha de `conversation_state` da entrada suprimida nasce só com
`entry_suppressed_at`: sem `last_ai_response_at` (a IA calou de propósito) e sem
`message_count`. Mas `conversationActive` procura exatamente esses dois rastros
→ false → `trigger_once` não bypassa → o turno 2 é re-avaliado contra a folha
`message`. E o turno 2 é a RESPOSTA do lead, que nunca casa a frase do anúncio.
`targeting_skip`. A IA calaria no turno 1 de propósito e seria barrada no turno 2
por acidente.

Já aconteceu, conta da Márcia, contato `S6UEuzYfkHXlkwwNBoK8`:

```
15/09 03:02  lead entra por anúncio do Facebook
15/09 03:04  entry_suppressed                      ✓ correto
16/09 20:47  lead: "Quais dados vc precisa ?"      ← pedindo pra ser qualificado
16/09 20:48  targeting_skip                        ← 49 segundos depois
17/09 00:16  mandou os dados todos assim mesmo, sem ninguém pedir
17/09 05:36  ai_paused — um humano viu, 9h depois
```

O `conversation_state` dele ainda tem o retrato: `last_ai_response_at=null`,
`message_count=0`, `entry_suppressed_at` preenchido.

Só um agente da frota usa `entry_by_automation` hoje (o da Márcia) e ele está
exposto. 154 `entry_suppressed` no total, 1 caso confirmado na amostra — a taxa é
baixa porque normalmente a tag de anúncio chega a tempo e salva pelo outro
caminho do `match: any`. Quando não chega, o lead some.

Corrigido em `82a0c97` (`entradaJaPassouPeloGate`, pura e testada). **Ordem
importa: este commit precisa estar em produção ANTES de ligar
`entry_by_automation` na Jussara**, senão ligamos o guardrail e importamos o bug
na conta que está sendo religada justamente por ficar muda.

E é por o gatilho desta conta ser FRASE que o H96 morde aqui: se a entrada fosse
por tag, a tag continuaria no contato no turno 2 e o gate casaria de novo. Frase
não sobrevive ao turno seguinte.

---

## Como fica, em uma linha

O item 4 está pronto e testado (28/28), a config não foi gravada, o agente segue
`inactive`, e o conflito com o workflow que travava a religação em 07/09 acabou.
Falta: o OK do Pedro, e de preferência rodar as 3 conversas no Sonnet antes.

Sequência recomendada, agora que o H96 entrou na conta:

```
git push                                      # H95 + H96
npx vercel ls --prod                          # até Ready — "pushed" ≠ "deployado"
npx tsx scripts/jussara-guardrails.ts --apply # config
npx tsx scripts/religa-jussara.ts --apply     # status=active
bash scripts/_watch-jussara-religa.sh         # monitor 30min
```
