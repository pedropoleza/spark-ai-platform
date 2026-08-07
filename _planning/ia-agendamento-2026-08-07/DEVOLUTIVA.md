# IA de Agendamento — devolutiva por caso (2026-08-07)

> Fonte da demanda: `spark-os/_planning/sessoes/PROMPT_IA_AGENDAMENTO.md`
> (chamados #89, #90, #91, #93, #99, #100).
>
> **Regra que este documento segue:** nada aqui é declarado resolvido sem o caso
> reproduzido antes e falhando depois. Em 04/08 dissemos "corrigido em
> definitivo" e não se sustentou — o motivo está na seção 0.

---

## 0. Por que "voltou" depois do 04/08

O diagnóstico de fuso estava **certo**. O fix não.

Em 04/08 subimos o H66, que coage o horário do agendamento "pro fuso da conta"
antes de gravar. Só que **o fuso da conta estava errado no nosso banco** —
`America/Sao_Paulo` numa conta que roda em Nova York. A coerção fez o que foi
mandada fazer: reproduziu o erro com fidelidade. Tratamos o sintoma.

A causa real: o widget do SparkBot dentro do Spark Leads gravava em
`locations.timezone` **o fuso do navegador de quem abrisse a página**. Como o
time tem gente no Brasil, conta americana virava BRT.

Esse campo alimenta as **duas pontas** do agendamento: o rótulo do horário que o
lead lê no chat *e* o offset gravado no CRM. Com BRT numa conta ET as duas
divergem em exatamente 1 hora.

---

## 1. Caso B — "ofereceu 7PM e agendou 6PM" ✅ CORRIGIDO

**Reprodução** (`scripts/test-repro-fuso-marcia.ts`, determinística, funções reais):

```
ANTES (America/Sao_Paulo):  lead lê "8:00 PM" → grava 19:00-03:00 → cai 6:00 PM ET
DEPOIS (America/New_York):  lead lê "7:00 PM" → grava 19:00-04:00 → cai 7:00 PM ET
```

**Flagrante em produção**, conversa `3Hvmd9IDbbpJhx573oAr`, 06/08 23:09 UTC — o
próprio cliente final pegou o erro:

| Hora | Quem | O quê |
|---|---|---|
| 23:09:01 | IA | "Você prefere amanhã (sexta) às 1:00 PM ou às 5:00 PM (ET)?" |
| 23:09:46 | lead | "5:00 PM" |
| 23:10:21 | IA | "Agendado para amanhã, sexta (07/08), às 5:00 PM ET! 🎉" |
| 23:10:30 | automação | "confirmar nosso encontro agendado para: 08/07/2026 **04:00 PM**" |
| 23:32:37 | lead | "Então o horário e as 4 e não as 5?" |
| 23:33:07 | IA | "Você está certo, me desculpa pela confusão!" |

**Alcance — não era só a Márcia.** Auditei as 160 locations contra a API do Spark
Leads: **43 estavam com o fuso errado**, 38 delas com `America/Sao_Paulo` em conta
americana. **5 tinham agente ativo marcando reunião errada naquele momento:**

| Conta | Erro |
|---|---|
| Horizon (Márcia) | −1h |
| LIBERTY FINANCIAL | −1h |
| Agencia Up | −1h |
| Dream Team | −1h |
| Five Rings | −1h |

A conta da **Luciana** (#99) também estava 1h fora (`America/New_York` → `US/Central`).

**Feito:** 43/43 corrigidas a partir da API do Spark Leads (backup do estado
anterior em `/tmp/fuso-locations-backup-*.json`). A causa foi corrigida no código
e deployada — o widget não grava mais o fuso do navegador, e o painel não reseta
mais o valor que o SSO buscou. Auditoria repetível: `scripts/audit-fuso-locations.ts`.

---

## 2. Caso C — reunião duplicada ✅ CORRIGIDO (uma metade)

**`+1 (508) 665-7240` (Anne), reportado em 05/08 13:28: "o sistema agendou ela
para hoje E amanhã".**

Forense: reschedule às 08:42 criou a reunião de 06/08 e a de 05/08 **continuou
viva** — só foi cancelada à mão às 09:21, 39 minutos depois.

Causa no código:

```js
try { await client.delete(...) } catch { /* Se falhar ao deletar, continua e cria novo */ }
await client.post(...)   // cria assim mesmo → DUAS reuniões
```

Delete falhando = duplicata silenciosa. O cliente final recebe confirmação e
lembrete da reunião fantasma, e quem cancela uma continua vendo a outra disparar.

**Feito:** reagendar agora é **UPDATE** — move o horário preservando o ID, então
existe uma reunião só, sem janela de duplicata e sem redisparar a automação de
"novo agendamento" do Spark Leads. Só cai no delete+create se o update for
recusado; e **se o delete falhar, aborta** em vez de duplicar.
Teste: `scripts/test-reschedule-sem-duplicata.ts` (3 cenários).

### ⚠️ A outra metade do caso C não é nossa

**`+1 (508) 560-9151` (Douglas), 06/08 14:55.** A reunião está `cancelled`
corretamente no Spark Leads e **a IA não encostou nela** (zero linhas no log).
Mas o contato continua com a tag `appointment-scheduled`.

Nosso motor **não manda lembrete nem confirmação de reunião** — isso vem de
workflow dentro da conta. Enquanto o gatilho desse workflow não for corrigido
(provavelmente disparando por tag ou por update do appointment, em vez de checar
o status), cancelar vai continuar mandando confirmação. **Precisa ser visto no
Spark Leads da conta, não aqui.**

---

## 3. Caso A — slot de 30 min ✅ RESPONDIDO (não é o software)

O calendário `1.1 - Primeiro Encontro` está **hoje** em 1h/1h. A forense mostra
reuniões de 30 min criadas nele em 04 e 05/08 (a Anne às 10:30, horário que só
existe com intervalo de 30). Ou seja: a config foi alterada e depois revertida —
o "voltou" dela está certo.

**Não fomos nós.** Nenhum dos dois sistemas escreve configuração de calendário —
só cria/edita agendamentos e lê horários livres. Nunca mandamos duração no
booking; quem define é o próprio calendário.

O doc pedia "descobrir o que reverteu antes de mexer". A resposta é: **saiu de
fora do nosso código** — alguém editou no Spark Leads ou um snapshot/template da
agência sobrescreveu. Tem que sair do log de auditoria de lá.

---

## 4. Caso D — "a IA continua falando que não consegue ouvir áudio" ✅ CORRIGIDO

Capturado ao vivo na conversa `pqLVt4TltuQZfCLIM04v`:
`16:44:59 [lead] 🎤 Mensagem de voz (0:17)` → `16:45:36 [IA] "Não deu pra ouvir seu áudio..."`

O áudio **não** estava quebrado: chega com URL válida em 145 de 146 casos em 7
dias, e a transcrição funciona (testei 3 áudios reais da conta, 3/3 com texto
correto em português).

O defeito era o que o modelo **lia**. A transcrição era anexada por baixo, e o
corpo continuava começando com o rótulo cru `🎤 Mensagem de voz (0:17)`. O modelo
lia a primeira linha como "tem um áudio aqui que eu não acesso" e se desculpava —
com a transcrição logo abaixo.

**Feito:** o rótulo agora é **substituído** pela transcrição. E quando a
transcrição falha de verdade, o texto diz isso explicitamente, pra a recusa ser
honesta em vez de aleatória. Teste: `scripts/test-audio-rotulo.ts` (6 cenários).

---

## 5. Caso H — follow-up à meia-noite ✅ CORRIGIDO

**`(862) 371-8457`, 05/08 06:32: "a mensagem foi meia-noite".**

O agendamento do toque era `agora + delay`, **sem checagem nenhuma de horário**.
Lead que parava de responder às 23h recebia o toque de 1h à meia-noite.

**Feito:** todo follow-up passa por uma janela de envio (08h–21h **no fuso da
conta**). Fora da janela, é empurrado pra abertura seguinte; dentro, não muda
nada. Vale pra frota inteira. Teste: `scripts/test-janela-de-envio.ts` (10
cenários, incluindo virada de ano e virada de horário de verão).

**A sequência de 3 toques dela foi implementada** com o texto verbatim (1h / 24h /
72h). Duas ressalvas:
- O toque 1 cita "o vídeo do Matheus". Se o agente atender lead de outra
  campanha, vai soar errado pra ele.
- O toque 2 pedia **vídeo anexo**. Follow-up só manda texto hoje; o vídeo não vai.

---

## 6. Casos E e G — identidade e coleta ✅ CORRIGIDOS

**E — "tem usado o nome da Rob dnv" (06/08 17:26).** A persona se chamava
"Marcia" e a IA assinava individualmente. Agora ela atende em nome do time,
e o prompt proíbe explicitamente assinar como "Rob"/"Roberta" ou se apresentar
como uma pessoa só.

**G — "eles estão mandando picada e às vezes a gente não vê se a pessoa é
fumante" (06/08 12:30).** Achado no caminho: **faltava o campo de nome** na
configuração — a IA nunca pedia nome e sobrenome, só data de nascimento, estado e
fumante. Adicionado. E o prompt agora manda os 4 dados **na mesma mensagem, na
ordem que ela pediu**: nome e sobrenome, data de nascimento, estado, fumante.

---

## 7. Caso F — IA falando com quem já está em atendimento ✅ CORRIGIDO (monitorar)

Reportado 2× (04/08 01:14 e 04/08 14:33) e respondido com "zero casos" em 04/08.

Causa: `handoff_policy` estava **desligado** nessa conta. Sem ele, a regra
"humano respondeu nos últimos N minutos → a IA cala" simplesmente não existia. A
única proteção era uma pausa que age **depois** do turno já ter saído.

Ele foi desligado nas contas 100% IA porque a classificação "humano assumiu"
confundia o próprio eco da IA com um humano. Essa escada foi endurecida em 28/07
(anti-eco por ID do envio, anti-eco por texto, merge field, atividade de CRM não
conta). E esta conta **não** é 100% IA — a Márcia e a Roberta atendem o inbox
ativamente. É exatamente o cenário pro qual o gate existe.

**Feito:** gate ligado (janela de 60 min) + `deactivation_rules` por tag de
cliente (`cliente`, `client`, `active client`, `apólice ativa`,
`personal contact`). Essa segunda trava roda **antes de enfileirar** — contato
tagueado como cliente nunca chega na IA, que é o caso literal que ela relatou.

⚠️ **Monitorar 48h.** Se a IA ficar muda em conversa de lead novo, é o gate
misfirando: procurar `should_respond_skip` no `execution_log`.

---

## 8. Item I — fora do motor de agendamento

**#99 (Luciana) — tarefas automáticas de ligação.** Nenhum dos dois sistemas cria
tarefa de ligação no CRM dela. O que existe é o que **nós dissemos** que íamos
gerar (30/dia) — o oposto do que ela pediu. Não há nada pra desativar no código:
é responder que não vamos gerar e conferir se alguém montou isso na conta dela.
Ela elogiou o resto: *"essa parte de tarefas ficou ótima"*.

**#100 (Jussara) — robô do Instagram não responde.** Não está quebrado: a
ativação dela exige uma de **duas frases exatas de anúncio** ou uma de três tags.
As DMs do Instagram são conversa orgânica ("Oii Jussara", "Q lindo ❤️🔥",
"Como funciona profissão de Life Planner?") e nenhuma bate. Chegaram 49 DMs em 10
dias, todas processadas e nenhuma ativada — comportamento correto pra config
atual. **Decisão dela:** o que deve ativar a IA no Instagram?

**#100 — "só o primeiro nome nos disparos".** Superfície de disparo em massa, não
do agendamento. Fica de resposta pendente — e o histórico dessa conta é de 8
reports sem conclusão, então **fechar o laço mesmo que a resposta seja "não dá"**.

---

## O que fica pendente (👤)

| # | O quê | Onde |
|---|---|---|
| C | Workflow que manda confirmação/lembrete de reunião cancelada | Spark Leads da conta (Márcia e Luciana) |
| A | Descobrir quem alterou a duração do calendário pra 30 min | Log de auditoria do Spark Leads |
| H | Confirmar com a Márcia o texto do toque 1 ("vídeo do Matheus") e o vídeo do toque 2 | Com ela |
| F | Monitorar 48h se o gate de humano misfira | `execution_log` |
| I | #99: confirmar que ninguém montou geração de ligações · #100: definir gatilho do Instagram e responder o "primeiro nome" | Com as clientes |
