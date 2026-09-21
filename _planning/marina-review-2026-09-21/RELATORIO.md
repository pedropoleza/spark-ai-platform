# Review da conta da Marina Couto — 21/09/2026

Corpus: 308 conversas reais, 13→21/09, contas `A62s5EQj1hldOuvBEowv` (Support /
agente "Manu") e `ONRf1DUKVnfxivEGxcTj` (Personal / Pós-Atendimento).
Método: leitura integral do corpus por 5 agentes adversários + detectores
determinísticos rodados contra o `execution_log` e a `message_queue`.

---

## Funil da semana

| degrau | n | % |
|---|---|---|
| Leads distintos que escreveram | 308 | 100% |
| Barrados na ativação | 105 | 34% |
| Mudos por falha de entrega (token) | 34 | 11% |
| **Atendidos pela IA** | **165** | **54%** |
| Escolheram horário | 37 | 12% |
| **Agendados** | **27** | **8,8%** |

**Quando a IA consegue falar, ela converte 16,4%. Quem chega a escolher
horário fecha em 73%.** Nenhum dos vazamentos é de qualidade de conversa — os
três são de encanamento.

---

## As três causas (nenhuma era "a IA parou")

### 1. Entrega — o token do CRM (a que estava sangrando AGORA)

De 18/09 a 21/09, **55 respostas foram escritas pela IA e nunca chegaram ao
lead**. Dois erros, uma raiz: o banco de tokens do Spark Leads (projeto
Supabase separado) com o PostgREST fora.

- 19/09: 27 falhas · 20/09: 19 · **21/09: 9h30 de mudez total (07:18→16:50 UTC)**
- O lead não vê erro nenhum: manda mensagem, a IA escreve, e do lado dele não
  acontece nada.
- **Recuperado às 16:50 UTC de 21/09.** O espelho `ghl_company_tokens` (H93)
  foi semeado com um par novo; a plataforma não depende mais daquele projeto.

⚠️ O projeto "GHL Token" **continua doente** (PostgREST 100% fora, pg_net
starvado, SQL do plano de controle intermitente). Não derruba mais a
plataforma, mas outros apps leem dele.

### 2. Cauda da fila — leads esperando de 3 a 5 horas

O claim da fila pega até 100 mensagens da frota inteira, mas um turno custa ~6s
e a lambda tem 35s: claimávamos dezenas de grupos sabendo que só dava pra
atender uns 4. O resto ficava preso em `processing` até o reaper, **5 min
depois**, e o ciclo se repetia.

- **567 mensagens órfãs em 3 dias.**
- De 08 a 14/09: **zero** mensagens acima de 10 min. De 16/09 em diante: **6 a
  15 por dia acima de 1 hora**, numa conta cuja mediana é 0,3 min.
- O H92 tornou isso visível mas não corrigiu — `withDeadline` só corre contra o
  relógio, o laço continua rodando.
- **Corrigido (H94):** o orçamento agora vai por dentro; o lote devolve o que
  não vai dar tempo. 5 min viram os 10s do próximo tick.

### 3. Porta de entrada — a regra casava com o ANÚNCIO, não com o lead

A ativação exigia "carreira" ou "entender melhor" — o texto que o anúncio do
Instagram **pré-preenche**. Quem vinha da mesma campanha e digitava a própria
frase era barrado: **135 contatos em 14 dias, ~22 leads reais**, incluindo
*"Tenho green card e um bom inglês"* e *"acabei de receber meu work permit"*.

Afrouxar o texto seria pior: **43 dos 135 eram "Parabéns"** de amigos no
aniversário da Marina (15/09) — e a regra acertava em barrar.

A separação não é o texto, é a **origem**:

| grupo | Paid Social | Social media |
|---|---|---|
| leads reais barrados | **17/20** | 3 |
| parabéns | **0/35** | 35 |

**Corrigido:** folha de atribuição como 3º grupo de ativação. Simulado contra
os 135 contatos reais antes de aplicar — **20 leads recuperados, 0 parabéns
liberados**. Reverter: `npx tsx scripts/aplicar-targeting-anuncio-marina.ts --reverter`.

---

## Qualidade da conversa — nota 7/10

### O que está limpo (verificado em 220 mensagens)

- **Zero promessa de renda.** O "mais de 100 mil por ano" aparece 28× no corpus,
  sempre no áudio do ANÚNCIO reencaminhado pelo lead. A IA nunca repetiu.
- **Zero erro de data em 43 pares** auditados na primeira janela; 9/9
  agendamentos com `start_time` batendo com o prometido.
- **Honestidade sob pressão:** *"É 100% comissão, não tem salário fixo"*,
  *"Existe um custo de licença oficial do estado"*, *"Não é vaga de operador de
  máquinas não"*.
- **Aceita o "não" de primeira**, sem insistir (6 encerramentos limpos).

### Defeitos reais

| # | defeito | volume | gravidade |
|---|---|---|---|
| 1 | "Fechado!" / "você já tem encontro marcado" **sem agendamento real** | 4 leads | 🔴 |
| 2 | Par dia/data errado — `segunda (22/09)` é terça | 3 pares, 2 contatos | 🔴 **corrigido** |
| 3 | Quebra de persona: lead acha que fala com a Marina | 45 de 188 (24%) | 🔴 |
| 4 | Qualificação fabricada (afirmou work permit/estado que o lead não deu) | 3 casos | 🔴 |
| 5 | Pede dado que o lead acabou de mandar (rajada) | 4 casos, 3 dos 9 bookings | 🟡 |
| 6 | Bolhas duplicadas / dois turnos concorrentes | 13 pares | 🟡 |
| 7 | Nome do lead = @ do Instagram, inclusive no título da reunião | 6 casos | 🟡 |
| 8 | Duração do encontro inventada (10/20/30/45/60 min) | 5 valores | 🟡 |
| 9 | Nunca nomeia o produto ("seguro") em 308 conversas | estrutural | 🟡 |

**Falso alarme desmentido:** a IA ecoou `+55 11 99959-0122` para um lead que
escreveu `45999590122`. O **valor gravado no CRM está correto**
(`+5545999590122`) — `normalizePhone` fez o certo. É alucinação de texto, não
corrupção de dado.

---

## Precisa de mão humana (leads que acham que têm reunião e não têm)

| contato | o que a IA disse | realidade |
|---|---|---|
| `3tcH5O1qORRC9aGBytzD` (Paulo) | "Terça, 22/09 às 8pm ET, **fechado!**" | sem reunião, sem telefone, sem email |
| `us1CXjbyKtXlvvt8sHwq` (Paul Goodman) | slot de sexta 25/09 (inventado, guard H58 barrou) | sem reunião; deu telefone e email |
| `UNNe12qtPZ3IxG7trpg6` (Karinna) | "você tinha confirmado a segunda" | nunca recebeu a msg que pedia os dados |
| `28dPWHw8grssmsjfFZnJ` | "vejo que vc já tem um encontro marcado" | zero reuniões |

Além destes, **34 leads ficaram mudos** durante o apagão de token (lista
completa na seção C do relatório dos agentes) — vale uma varredura manual.

---

## Rotinas instaladas

**`/api/cron/vigia-conta`** — job pg_cron 21, diário às 13:00 UTC (9h ET),
cobrindo as duas contas da Marina. Seis detectores determinísticos:

1. `entrega` — % de respostas que não chegaram ao lead
2. `cauda_fila` — p50/p90 e quantas esperaram mais de 1h
3. `porta_de_entrada` — barrados pela ativação que pareciam lead real
4. `dia_data` — par dia-da-semana × data errado **no texto entregue**
5. `falso_fechado` — IA afirmou agendamento sem `book_appointment`
6. `volume` — conta viva

Achado acima de "médio" vira sinal de admin. Sob demanda:
`npx tsx scripts/vigia-conta.ts <locationId> [horas]`.

⚠️ **Cada detector foi rodado contra as conversas reais de 13→21/09 antes de
entrar.** Todos reencontraram os defeitos achados na leitura manual, e o de
data achou 2 que a leitura manual tinha perdido.

---

## Pendências

- **Conta Personal (Pós-Atendimento Marina): zero mensagens em 30 dias.** O
  agente está ativo mas nunca foi acionado — depende dos templates e do
  workflow.
- **Persona (24% sem correção)** e **"fechado" sem agendamento** são de prompt;
  o segundo merece guard determinístico (mesma escola do H58).
- **Turn-lock (H86) não está aplicado aos agentes lead-facing** — é a causa das
  bolhas duplicadas e do "me passa o email" depois de o lead ter mandado.
- O projeto Supabase "GHL Token" segue doente e é ponto único de falha para os
  outros apps que leem dele.
