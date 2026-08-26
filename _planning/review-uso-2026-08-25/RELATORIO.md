# Review de uso do SparkBot — 13/08 a 25/08/2026

Método: li as **1.799 mensagens** do período (706 do rep, 1.093 do bot), uma a uma, e cruzei com
`admin_signals`, `execution_log`, `assistant_scheduled_tasks` e `usage_records`.
Dump bruto: `_planning/_scan-conversas-2026-08-25.txt`.

---

## 1. Retrato do período

| | |
|---|---|
| Mensagens | 1.799 (706 rep / 1.093 bot) |
| Reps que escreveram | 31 |
| Reps com termos aceitos | 117 |
| Reps **pausados por silêncio** | 36 (31% da base) |
| Custo | $174 em 13 dias → **~$400/mês** projetado |
| Canal | 94% WhatsApp, 4% system, 2% web_ui |

Dia mais pesado: **17/08** (370 msgs, $29) — o dia em que o Gustavo fez a varredura de 30 contatos.

**Alcance dos proativos:** só 2 de ~14 gatilhos rodam de fato — Resumo matinal (37 reps em 13 dias)
e Pós-reunião (22 reps). O resto continua seedado e desligado.

---

## 2. Como estão usando (por volume)

1. **Lembrete por voz, na correria** — o uso nº1. Raquel Moura sozinha criou ~35 lembretes por áudio
   dirigindo/entre reuniões. Luciano, John, Natalia, Danielle idem.
2. **Agendar reunião** — praticamente todo mundo. Legacy Agency, Milton, Ana Gusmão, Daniely, Jussara,
   Caua e Paulo usam quase exclusivamente pra isso.
3. **Mensagem agendada pro contato** — o Matheus Curty usa o bot *só* pra isso (41 msgs, todas
   "enviar mensagem para +1... dia X às Y").
4. **Nota pós-reunião colando resumo de fora** — Gustavo cola Fathom, Sieder cola ChatGPT, Claudia cola
   resumo em espanhol, Paulo dita por áudio. Blocos de 2.000+ caracteres.
5. **Pesquisar histórico do contato** — Gustavo é o power user: 30 consultas "qual meu histórico com X"
   em 3 horas no dia 17.
6. **Briefing matinal** — consumido em silêncio por todos, todo dia.

---

## 3. Erros — P0

### P0-1 · O bot age ANTES da resposta chegar → reunião no contato errado e duplicada
O caso mais claro é a **Daniely, 24/08 23:51**:

```
23:51:33 BOT  Marcar qual Thaty? 1. Thaty Gomes  2. thatyribeiro_usa  3. Outro número
23:51:51 BOT  Marcado! ✅ *Thaty Gomes* - terça 25/08 às 17:00     ← 4 s ANTES da resposta
23:51:55 REP  Outro número (+1 407 760-1354)
23:53:29 BOT  Marcado! ✅ *Tatiane Ribeiro* - terça 25/08 às 17:00
```
Resultado no briefing do dia seguinte: **três reuniões às 6:00 PM** (Thaty ×2 + Tatiane).

Mesmo padrão em: Ana Gusmão 17/08 (`Marcado!` às 21:21:14 e a checagem de conflito só às 21:21:33),
eric souza 14/08 (duas `present_options` concorrentes, rep respondeu as duas), Daniely 22/08
(`Marcado!` 01:41:54 → pede confirmação de novo 01:42:03).
**9 bolhas idênticas em <180 s** detectadas no período.

### P0-2 · Data × dia-da-semana ainda erra fora da janela do H68 — e o bot discute com o rep
**Ana Paula Rangel, 20/08 01:41–01:46** (24/09/2026 **é quinta-feira**):
```
BOT  ⚠️ Dia 24/09 cai num *domingo* - confirma que é isso mesmo?
REP  Dia 24 é uma quinta
BOT  ⚠️ O dia 24/09 é quarta, não quinta.
REP  24 de setembro é quinta
BOT  Olhando o calendário, 24/09 é uma quarta.
REP  Você está tendo erros
REP  Dia 24/09 é uma quinta — Você está me deixando preocupada
```
Só depois de **4 correções** o bot cedeu ("você estava certa o tempo todo").
Idem Ana Gusmão 17/08 ("Vc está errado") e Matheus 15/08 e 21/08.

**Números:** 265 pares "dia + data" emitidos pelo bot, **7 errados (2,6%)** — dos quais **5 batem
exatamente com o calendário de 2025**. A H68 derrubou de 16,5% → 2,6%, mas o `[CALENDÁRIO REAL]`
cobre 3 semanas e **todos os erros residuais estão além dessa janela** (14/09, 24/09, 15/10, 21/09).
Pior: o resíduo é justamente o caso que vira briga com o cliente.

### P0-3 · Handoff dispara na palavra "pessoa" — 11 de 11 são falso positivo
Todos os 11 handoffs "lead pediu falar com humano" do período tiveram o mesmo gatilho: `"pessoa"`.
O que o lead realmente escreveu:
- *"Não sou fumante e sou solteiro, vivo só com uma **pessoa**"* ← resposta de estado civil no underwriting
- *"Moro com um **pessoa**"*
- *"Eu trabalho interna cuidando de **pessoas** idosas"*
- *"Oi Marina essa **pessoa** sou eu!"*

Ou seja: a IA para de responder exatamente quando o lead está preenchendo a triagem. Atinge Marina,
Priscila e Jussara.

### P0-4 · Link de agendamento inventado
**Paulo, 17/08 22:14** — o bot fabricou `https://link.sparklaunch.io/widget/bookings/consulta-inicial-drabreu`,
apresentou como o link real da agenda e ofereceu mandar pro Pr Otto Fanini. O Paulo testou, não abriu,
e o bot admitiu: *"O link que eu gerei foi um exemplo genérico"*. Só não foi pro prospect porque o
Paulo pegou. Três reps pediram esse link no período (Paulo 2×, Danielle 1×) e nas outras vezes o bot
disse que não tem — **a inconsistência é o perigo**: às vezes recusa, às vezes inventa.

### P0-5 · Confirma um calendário e grava em outro
**Daniely, 17/08 15:12**: confirma *"1.2 - Segundo Encontro"*, e 20 s depois: *"Marcado! ✅ ... no
**1.1 - Primeiro Encontro**"*. O rep aprovou uma coisa e o CRM recebeu outra.

### P0-6 · Resumo de histórico do contato sai errado e só é corrigido se o rep reclamar
**Gustavo, 17/08**, duas vezes:
- *"esse histórico de mensagens está errado de Amanda Santos, ela tem me respondido sim"*
- *"esse historico da Erica esta errado"* → o bot devolveu um histórico **completamente diferente**
  e correto (Orlando, loja de doces, prova 14/07) no lugar do primeiro (Flórida, começou 09/07).

Ele está tomando decisão de recrutamento em cima desses resumos. Errar em silêncio aqui é caro.

---

## 4. Erros — P1

| # | Defeito | Volume |
|---|---|---|
| P1-1 | "Tive um problema técnico" visível pro rep | **24** msgs (2,2% do bot), 10 reps |
| P1-2 | Meta-correção do coherence-gate vazando no WhatsApp | 6× — texto de auditoria interna ("*Boa observação do sistema…*", "*não executei nenhuma ferramenta neste turno*") chegando pro rep no meio de outra pergunta |
| P1-3 | Lembretes duplicados criados pelo re-run | 6 pares em 80 (7,5%) — Raquel recebeu 10 lembretes às 10h de 17/08, sendo 2 pares idênticos |
| P1-4 | Loop-guard pausando IA em lead legítimo | **36** pausas, **30 numa conta só** (Priscila Rabelo) |
| P1-5 | Nudge de silêncio | **9,2%** das mensagens do bot — inclusive grudado em respostas úteis e no mesmo minuto em que o rep está conversando |
| P1-6 | Bot não enxerga lembrete que já disparou | Raquel 18/08: bot cria e dispara o lembrete do Evaldo, e 30 s depois diz *"nos lembretes ativos não tô vendo nenhum do Evaldo — parece que não ficou salvo"* |
| P1-7 | Loop de interrogatório de horário | Raquel 25/08: 6 pendências repetidas a cada turno por 5 h, nenhuma fechada. O bot exige hora exata pra todo lembrete em vez de assumir default |
| P1-8 | Contexto vazando entre conversas | Gustavo 18/08: *"o sistema tá interpretando 'dia 26' de outra conversa"*; Matheus 19/08: *"o sistema tá travado num conflito de data por causa do agendamento anterior do Gwaliton"* |
| P1-9 | Wesley 20/08 — loop de desambiguação | 5 rodadas pra escolher "Natália", rep desiste: *"Só isso. Só isso. Eu quero só que você faz isso."* |
| P1-10 | Data estagnada | John 23/08: *"Você tem a reunião com o Ricardo Matte amanhã 2:30 PM"* — reunião era 18/08, já tinha passado |

### Alarme que grita lobo
`SparkBot inbound MUDO` já disparou **7.406 vezes** e está disparando agora — porque é 23h e o
threshold noturno é 240 min. Ele não distingue "canal caiu" de "todo mundo dormindo". Foi esse alarme
que deveria ter pego o apagão de 13–14/08 e não pegou, porque ninguém confia nele. Precisa de sinal
positivo (heartbeat do engine), não ausência de inbound.

---

## 5. O que estão pedindo e não existe

| Pedido | Quem | Nota |
|---|---|---|
| **Link público do calendário pra mandar pro cliente** | Paulo (2×), Danielle | O mais pedido. Já causou alucinação (P0-4). O Spark Leads expõe isso na API |
| **Link de Google Meet gerado por reunião** | Felipe | Queria disparo automático no horário de cada aluno com o link embutido |
| **Lembrete 30 min antes de CADA reunião, como regra permanente** | Jussara (2×) | Bot: *"não consigo criar uma regra automática que dispara antes de cada reunião futura"*. Hoje só dá pontual |
| **Resumo do histórico no formato que ele ensinou, em lote** | Gustavo | Ele literalmente colou um exemplo e disse *"quando eu pedir o histórico, eu quero um resumo assim"*. O bot não guarda essa preferência — e ele fez 30 consultas 1-a-1 que deviam ser 1 comando |
| **Filtro por produto / apólice / cidade real** | Luciano | *"clientes de Term em Orlando"* → 0 resultados; *"todos da pipeline em Orlando"* → 3. Os dados existem, o filtro não alcança |
| **Passo a passo de claim na KB** | Manuela | Precisava pra apresentar pra uma agência no dia seguinte. KB só tem underwriting |
| **Ler endereço/link de evento do Google Calendar** | Paulo | Bot vê o compromisso mas não o endereço |
| **Relatório de atividade da semana** | Luciano | *"quantas ligações e mensagens foram feitas essa semana"* — não existe |
| **Registrar ligação feita pelo celular** | Luciano | O bot ofereceu ajudar a montar e o assunto morreu |

---

## 6. O que melhorou (vale registrar)

- **Resumo matinal: 37 reps alcançados em 13 dias.** Era 15 num dia bom antes da H69. A janela funcionou.
- **Erro de data caiu 16,5% → 2,6%** (H68). O que sobrou está fora da janela de 3 semanas.
- **Zero confirmação falsa de agendamento** na frota rep-facing — o H58/H78 está segurando. Quando o bot
  não consegue, ele diz: *"não quero te dizer que fiz algo que não foi feito"*.
- **Reagendamento sem duplicata** (H72): nenhum caso de reunião fantasma por reschedule no período.
- **Bulk tag**: Felipe aplicou tag em 33 contatos por custom field, zero falhas.
- **Custo**: ~$400/mês projetado, contra os $650 projetados em julho.

---

## 7. Ordem sugerida de ataque

**Pacote curto (1 dia)** — todos são de baixa complexidade e alto retorno:
1. P0-3 (handoff "pessoa") — exigir intenção, não a palavra solta. 11 de 11 são falso positivo.
2. P0-4 (link do calendário) — expor a tool; mata a alucinação e atende o pedido mais repetido.
3. P0-2 (janela do calendário) — estender o `[CALENDÁRIO REAL]` pra ~90 dias + regra dura de
   "rep discordou de data ⇒ rep está certo".
4. P1-2 (meta-correção vazando) — texto de auditoria não vai pro WhatsApp.

**Pacote médio (2–3 dias):**
5. P0-1 (ação antes da resposta) — serializar o turno por rep; é o que gera reunião errada.
6. P0-5 (calendário confirmado ≠ gravado) — mesmo remédio da H50: narrar a partir do retorno real.
7. P1-5 + P1-7 (nudge e loop de horário) — os dois pesam na percepção diária.

**Projeto:**
8. P0-6 + pedido do Gustavo — resumo de histórico confiável, em lote, com preferência de formato salva.
9. Lembrete automático pré-reunião como regra (pedido da Jussara).
10. Alarme de canal com heartbeat em vez de ausência de inbound.
