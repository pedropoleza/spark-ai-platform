# Análise — conversas reais de IG da conta da Marina (atendimento atual)

> Fonte: `inbound_webhook_samples` (location A62s5EQj1hldOuvBEowv), janela **17–18/06/2026** (é o que a captura de webhook tem; o histórico completo vive no GHL e precisa do token, que não roda local). ~6 atendimentos reais multi-turno + uma porção de aberturas avulsas. Gerado 2026-06-18.

## 0. Quem atende o IG da Marina hoje: AMBÍGUO (humano com snippets OU ferramenta) — NÃO dá pra cravar

> ⚠️ Correção (Pedro questionou "o bot já falou com outras pessoas? acho que não"). Eu tinha afirmado "é bot" pelo timing — **retiro a certeza.** Os dados não decidem.

Sinais a favor de automação: respostas com `source:"app"`, `userId:null`, e **3 bolhas no mesmo segundo** (21:42:40+:41; 21:49:19+:21+:24; 23:43:51+:52). Mas:
- No **IG**, `userId` quase nunca vem mesmo de humano (98 de 101 outbound = `null`), porque a msg sai pelo *conversation provider* que **não atribui o usuário** → `userId:null` no IG **não distingue humano de bot** (em SMS/WhatsApp sim: 75 de 76 humanos têm userId).
- 3 bolhas em 1s **tanto bot quanto humano com resposta-rápida/snippet** produzem.

**Conclusão honesta: inconclusivo.** Pode ser a SDR/pessoa do time atendendo com snippets, pode ser ferramenta (ManyChat/workflow). 👤 **Só o Pedro sabe** (pendência §7). **Certo é só:** (a) **não é a nossa IA** (Marina/Bianca inativas, zero `message_queue`, nunca falaram com lead real); (b) **as conversas são reais e bem atendidas** (3+ agendaram Zoom).

**Implicação (independe de quem atende):** o objetivo é **igualar o atendimento atual** no que ele faz bem (rápido + agenda de verdade + coleta contato) e **somar** o que a nossa IA tem de melhor (profundidade de qualificação, objeções, urgência honesta, asset pro cético, compliance).

## 1. O fluxo do bot atual (enxuto)

`saudação ("Boa tarde {Nome}, tudo bem?") → ESTADO → WORK PERMIT (gate) → CONVITE direto pra reunião → coleta email+WhatsApp → cria Zoom + manda link`

**Ele PULA profissão e a pergunta-ouro (motivação).** Vai de work permit direto pro convite. É mais rápido que o nosso desenho (que tem profissão + "o que te fez parar no anúncio").

A reunião é **"um encontro com a Marina, pequeno grupo onde ela explica os detalhes e você interage com ela"**, nos horários fixos **quinta 8pm / segunda 8pm (NY)** — confirma o modelo de **turma recorrente em grupo**.

## 2. O que está convertendo (e como)

Dos ~6 atendimentos reais, **pelo menos 3 agendados** com Zoom criado, e 1 no-permit salvo num bate-papo cortesia:

| Lead | Estado | Permit | Desfecho |
|---|---|---|---|
| **Emanuele** (MhYB) | Syracuse NY | tem (+residência) | ✅ **agendou** segunda 22/06 8pm |
| **Jeff** (R00V) | — | (assumido) | ✅ **agendou** quinta 18/06 8pm + Zoom enviado |
| **Rosangela** (Udi9) | Long Branch NJ | sim | 🟡 convite enviado (sem confirmação capturada) |
| **Roseane** (L2Drq) | TX (ainda no Brasil) | NÃO (F1, CPT futuro) | ✅ **bate-papo cortesia** agendado + interesse futuro registrado |
| **Abby** (zC5b) | — | — | 🟡 travou (bot perguntou "carreira ou planejamento pessoal?" e parou) |
| **(TtAnw)** | — | — | 🔴 **largado: 7 msgs do lead, 0 resposta** |

**Padrão de conversão:** lead com permit + interesse → **agenda em 4-6 trocas, rápido**. A velocidade (pular profissão/motivação) está claramente a favor da conversão.

## 3. O que o bot atual faz MELHOR que a nossa IA (adotar)

1. **Coleta email + WhatsApp no fechamento** ("pra confirmar, me passa seu email e WhatsApp") → e avisa "vou te mandar pelo e-mail e whatsapp tá?". Isso resolve **exatamente** o problema que o nosso review apontou: lembrete **fora da janela 24h do IG**. O bot atual já tem canal de lembrete; a nossa IA não. **ADOTAR.**
2. **Agendamento REAL** — cria o appointment ("agendado para 06/18/2026 08:00 PM, fuso EDT") e manda o **link do Zoom** na hora. A nossa Marina de teste está com `calendar_id` vazio (só convida). Pra chegar ao nível, precisa do **calendário + geração de link**. **ADOTAR.**
3. **Caminho cortesia pro no-permit** (Roseane): dá o gate honesto ("permissão é requisito") MAS não larga — oferece um **bate-papo 1:1 cortesia** + registra interesse futuro. A nossa IA hoje só registra e espera. O cortesia **recupera** lead que senão seria perdido. **AVALIAR adotar** (cuidando do escopo — ver §5).
4. **Conversão de fuso na hora** (NY ↔ Brasília ↔ Texas) — "5pm Brasília = 4pm NY", recalcula sozinho. Bom detalhe.

## 4. O que a NOSSA IA tem que o bot atual NÃO tem (nossa vantagem)

- **Pergunta-ouro / motivação + profissão** → qualifica intenção e cria rapport (o bot atual agenda "no escuro", sem saber a dor → pode encher a turma de lead frio que não aparece).
- **Banco de objeções honesto** (golpe/pirâmide/MLM/"quanto ganha") — o bot atual não foi testado sob objeção nessas conversas; o nosso tem resposta pronta e compliant.
- **Urgência honesta + cap de insistência** (não martela).
- **Asset tangível pro cético** (link National Life antes da reunião).
- **Compliance de renda blindado** (zero número).

## 5. Sinais / problemas no atendimento atual

- 🔴 **Lead largado (TtAnw):** mesma mensagem + anexo repetida **7×** sem NENHUMA resposta. Cheira a **duplicação de entrega** (o mesmo problema dual-app que mapeamos) OU o bot atual não respondeu. De qualquer forma = **lead perdido**. A nossa dedup (já coberta) evita isso.
- 🟡 **Abby travou** — o bot perguntou "carreira OU planejamento pessoal?" e a conversa morreu. Bifurcação que confunde/esfria.
- ⚠️ **No-permit vira "planejamento financeiro pessoal"** (Roseane: "melhor caminho agora é começar com seu próprio planejamento financeiro"). Isso desvia de RECRUTAR pra **VENDER um produto** pra quem não pode ser agente. Pode ser intencional (monetiza o no-permit), mas é **outro escopo/compliance** — decisão do Pedro se a nossa IA deve fazer isso ou só registrar.

## 6. O que adaptar na nossa Marina pra chegar ao nível atual (+ superar)

**P0 (igualar o que já converte):**
1. ✅ **FEITO (2026-06-18, `update-marina-attendance.ts`)** — **Coletar email + WhatsApp no fechamento** + avisar que manda o link por lá → lembrete cross-canal. Aplicado no BLOCO REUNIÃO + `data_fields` ganhou `email`/`whatsapp` (required:false, coletados no booking).
2. 🤖+👤 **Agendamento real**: prompt já tem a sequência (escolhe → coleta → confirma com fuso + `{{LINK_REUNIAO}}` → avisa cross-canal). Falta **ligar `calendar_id` da turma + o link/zoom real** (👤 Pedro passa calendar_id + link Zoom da turma; sem isso o bot convida e confirma mas não gera o appointment no GHL).

**P1 (nossa vantagem, sem perder velocidade):**
3. ✅ **FEITO** — profissão + pergunta-ouro mantidas mas **enxutas** (1 turno cada, "não vire entrevista") — qualifica sem matar a velocidade. Funil marcado "enxuto e RÁPIDO".
4. ✅ **FEITO** — caminho **cortesia/registro** pro no-permit aplicado (WORK PERMIT ramo "não tem": registra + "me chama quando o permit sair" + indicação OU bate-papo cortesia sem compromisso). **Guard adicionado:** "NÃO venda outro produto pra quem não pode ser agente" (evita o desvio pra "planejamento financeiro pessoal" do §5 — fica decisão consciente do Pedro se quiser monetizar no-permit, hoje NÃO).

**Decisão estratégica do Pedro:**
- **Velocidade (atual) × Profundidade (nosso desenho).** O bot atual agenda rápido pulando qualificação → mais agendamentos, talvez mais no-show/lead frio na turma. O nosso qualifica mais → menos agendamentos, mais quentes. **O ideal provável: o lean do atual + a pergunta-ouro enxuta + o cap/objeções/compliance do nosso.** Definir o ponto.

## 7. Pendências de dados pra fechar (👤 Pedro)
- **Calendar ID** da turma da Marina + **link do Zoom** (pra agendamento real).
- **Link National Life** (`{{LINK_NATIONAL_LIFE}}`).
- Decisão: no-permit = cortesia-chat (como o atual) ou só registro?
- (Opcional) liberar o pull do **GHL completo** (mais conversas / histórico maior) — preciso do acesso ao token store, ou roda no app deployado.
