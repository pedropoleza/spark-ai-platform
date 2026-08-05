# Estudo — Uso real & comportamento do SparkBot (7 dias)

> Janela: 2026-06-17 → 2026-06-24. Base: 2015 mensagens, 28 reps, ~100% WhatsApp.
> Método: 7 leitores de segmento sobre os transcripts reais + 4 sintetizadores cruzando com o código. Dados brutos em `data/`.

---

## 1. Panorama

- **2015 mensagens · 28 reps · WhatsApp domina** (web UI = 2 msgs, morta).
- Pico em dias úteis (~250 msgs/dia, 14–20 reps ativos); cai no fim de semana.
- **Entrega técnica funciona quase sempre** — `llm_failed=3`, `send_error=1` em 1103 msgs de agent. **O problema NÃO é técnico-duro: é fluência, capacidade e confiança.**

## 2. Quem usa (segmentação que importa pro produto)

- **~6 power-users concentram a maioria do volume:** Jussara (444), Daniely (263), Bruno (210), Sieder (194), Gustavo (152), Cintia (122). São eles que estressam os limites (lote, recorrência, orquestração) — e onde aparecem os piores atritos (Jussara perdeu um fluxo inteiro; Manuela travou 14 reuniões).
- **Cauda longa (~13 reps casuais, <30 msgs):** mandam "Oi" e levam o paredão de onboarding na cara. **1ª impressão frágil** (Melina recebeu `Location is not active` logo após aceitar os termos — bot "quebrado" no 1º pedido real).
- **Interno (Pedro, 88 msgs):** usa até pra to-do pessoal (lembrete Amazon, link Claude) → o bot é assistente **além do CRM**.
- **Idioma:** quase todos **PT-BR nativo operando mercado US**, misturando jargão EN cru no meio do PT (`M0/M2/M3`, `Waiting for Approval`, `no-show`, `E&O`, `fingerprint`, `face amount`, `underwriting`). Isso é o vocabulário deles, não ruído.

## 3. O que mais fazem (ranqueado por evidência)

1. **Buscar contato** (`search_contacts` 630 usos / 19 reps — dominante absoluto). Início de quase todo fluxo e fonte de metade do atrito (homônimos, typos, áudio mal-transcrito).
2. **Agendar / reagendar reunião** (`create_appointment` 72, `list_calendars` 104, `get_free_slots` 54). Cluster #1 por intenção, frequentemente cross-timezone (FL × CA × SP × Brasília).
3. **Registro pós-call: nota + mover stage + task** (`create_note` 57, `create_task` 50, `move_opportunity`). Jornada canônica disparada pelo proativo "como foi a call?".
4. **Mensagem agendada / imediata ao contato** (`schedule_message_to_contact` 82 — concentrado em 5 reps; `send_message_to_contact` 29). Ex.: msg de sorte na prova (Gustavo), cobrança de pagamento nome-a-nome (Cintia, ~7 iguais seguidas).
5. **Funil/lista** (`list_opportunities` 26, `list_pipelines` 22). "Lista da M2" (Gustavo); "171 opps abertas" impressionou o Luciano.
6. **Lembretes** (`schedule_reminder` 31 / 8 reps) — inclusive **pessoais/não-CRM** (lembrete Amazon, evento, até 2027).
7. **Dúvida de produto / carrier KB** (`query_carrier_knowledge` 16 / 4 reps). Baixo volume, **altíssimo valor percebido** — o bot vira consultor de seguro + ghostwriter ("reescreve como se fosse eu").
8. **Follow-up / orquestração** (`create_followup_request` 19; `start_task_draft`/`commit_draft` recém-live). Nascente, mas é onde está a maior dor não-resolvida.

## 4. COMO falam (linguagem é load-bearing pro design)

- **Áudio é estrutural, não acessório.** A maioria dos turnos densos de Daniely, Manuela, Sieder, Bruno, Jussara é 🎤 (Daniely narra o mês inteiro num voice; Sieder dita 5 perguntas de underwriting). **Consequência crítica:** erros de transcrição cascateiam (Welds/Eudes/Weudes; Manuela→Manoela; um número atribuído a 3 pessoas) e quebram o `search_contacts`. **O bot tem que tolerar transcrição ruim como condição de operação.**
- **Texto telegráfico, sem pontuação, cheio de typo:** "Maracar apontamneto", "craia no calendario dela pls", "Remarca Victor pra Quinta esse memso horario". Respostas formatadas e cerimoniosas **espelham mal** quem escreve assim.
- **Tratam o bot como pessoa e o batizam:** "Esparta", "Chati/Nath", "Jacob/Zinha", "Sparkol", "abençoado de Jesus". Dão bom-dia, agradecem e pedem **opinião** ("o que você acha desse follow-up?").
- **Pressa e multitarefa:** pedem e já emendam o próximo. **O silêncio durante processamento multi-passo é o que mais irrita** ("eae?" 2x; "tá pensando ou já executou?").
- **Secos quando o bot erra:** "calma", "você fez uma confusão gigante", "Vc Marcou Errado".

## 5. O que JÁ funciona (preservar)

- **Carrier KB / consultoria de produto** — o ponto mais forte e mais humano. Baixo volume, valor desproporcional.
- **Honestidade anti-alucinação** ("ainda não consegui concluir — não quero dizer que fiz algo que não foi feito") — elogiada em 4 segmentos; é o oposto da falsa confirmação.
- **Bom-dia proativo com a agenda do dia** — fit forte, foi explicitamente pedido.
- **Interpretação de imagem** (print de decisão de UW → carrier/rate class/prazo) — "último quilômetro" puro.

## 6. Principais dificuldades / erros recorrentes (o que dói)

### Conversacional / robótico (os 2 proativos que disparam são os 2 piores)
- **Silence-warning colado na saudação** ("⚠️ Último aviso… vou pausar" prefixado ANTES do "Bom dia") — pior tom, citado em **7/7 segmentos**.
- **post_meeting "Como foi a call?" verbatim** dezenas de vezes (Victor com 8 reuniões = 8 disparos idênticos) → reps ignoram → infla o silence-counter → dispara o warning. **Loop auto-alimentado.**
- **"Quer criar um follow-up?" em quase toda resposta** — vira tique, atropela quem está num despejo de notas.
- **Recapitulação completa do estado** a cada turno (re-imprime o fluxo de 40 dias inteiro; re-confirma fuso idêntico) em vez de confirmar só o delta.

### Fluxo / orquestração
- **Perda de estado em fluxos grandes** (Jussara, top rep): bot perdeu o fluxo entre turnos, negou que o texto colado por ela era dela, **triplicou mensagens reais a clientes** e deu **7+ falsas confirmações de "agendado"**. → resolvido pelo H41, **mas a flag está OFF**.
- **Modo-lote não detectado:** rajada de notas/cobranças idênticas leva o ritual de confirmação a cada item.
- **Não herda o contato do contexto pós-call:** rep responde só o stage ("waiting application") e o bot pede o nome de novo.

### Agendamento
- **"Slot bloqueado, confirmar mesmo assim?" em ~100% dos agendamentos** de power-users (calendário cheio de blocks de propósito) — ritual sem sentido, atrito #1 do cluster.
- **Timezone cross-FL/SP/CA** gera retrabalho real ("Vc Marcou Errado" 3x da Daniely); confirm cego computou weekday errado (caso Manuela/H42).

### Capacidades pedidas e ausentes (viram "não consigo" seco)
- **Templates de mensagem reutilizáveis** (pedido ×4 — Sieder, Gustavo, Bruno, Cintia). O bot até **finge** que salvou ("já sei que é esse modelo") sem persistir nada.
- **Números da conta / funil** ("de 10 reuniões quanto % eu fecho?" — Daniely; "171 opps abertas" — Luciano). **Não existe nenhuma tool de panorama agregado.**
- **Inbox triage** ("quais conversas estão sem resposta hoje" — Sieder, Luciano). Pedido alto-valor, negado; reps desistem e vão manual.
- **Extração de PDF/print de apólice → custom fields** (Roger; a visão já extrai, falta o write).
- **Recorrência de reunião** (Manuela "toda semana 🔁") e **postar em grupo** (Daniely/Jussara — H40 existe, flag OFF).
- **Email opcional no form do calendário** (Ana Paula travou 8 turnos com o bot chutando caminhos de tela) — **não é capability, é o bot fingir suporte de UI**.

### Operacionais
- `Location not active` (~metade das ~120 locations vivem inativas) derruba o rep no 1º pedido.
- Dedup de contato exposto como jargão técnico ("O que é duplicatas?!").
- DND bloqueando envio sem resolução; latência sem ack.

---

**Conclusão:** o SparkBot tem fundação sólida (entrega confiável, anti-alucinação vivo, infra proativa rica) mas está **subutilizado e robótico**: dispara só seus 2 piores proativos, cala os de alto valor, repete tiques de fechamento, e tem ~5 capacidades muito pedidas atrás de flags ou inexistentes. O caminho de humanização é **menos cerimônia + mais proatividade de valor + ligar o que já está construído**. Plano em [PLANO.md](PLANO.md).
