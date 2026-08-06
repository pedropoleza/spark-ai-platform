# Guia pro Victor — reunião de alinhamento Richify.us (Willian + Yolanda)

> Texto pronto pra mandar no WhatsApp está no fim do arquivo. O resto é contexto pra você chegar na reunião sabendo o que já está feito e o que precisa decidir com eles.

---

## O que já está pronto (não precisa fazer nada)

A **Sofia**, agente de vendas da Richify.us, já está criada e configurada na conta deles, montada em cima do documento "Treinando AI" que o cliente enviou.

- **Painel:** `/hub/agents/7ce1f6f3-71f3-42f4-ba34-c85ac4f60233`
- **Location:** `VKJITQwWwWVRzce0dbSb` (Yolanda Pessanha's Account)
- **Status:** ativa, mas **travada na tag `teste-ia`** (só quem tiver essa tag no contato recebe resposta). Ninguém real é atendido até você abrir.
- **Calendário:** "Consulta Inicial" (60 min)
- **Canais:** WhatsApp, SMS e Instagram · **Idiomas:** português, inglês e espanhol
- **Follow-up:** 3 toques automáticos (1h, 24h, 72h) se a pessoa sumir

**O que a Sofia faz:** acolhe, entende a necessidade, faz perguntas consultivas e conduz pra reunião com o especialista.
**O que ela NÃO faz (por decisão do cliente, está no documento deles):** não explica produto, taxa, rendimento ou benefício específico; não promete retorno; não dá orientação jurídica ou tributária; não critica o que a pessoa já tem; não pressiona. Toda pergunta técnica ela devolve com "quem te mostra isso é o especialista na conversa".

---

## As 3 decisões que precisam sair da reunião

### 1. Como o lead entra na Sofia (o mais importante)

Hoje está na tag de teste. Precisa definir o critério real. As opções:

| Opção | Quando usar |
|---|---|
| **Toda mensagem que chega** | Eles querem a Sofia atendendo tudo que entra |
| **Tag de campanha** (ex: `leads iul us`) | Só leads de anúncio; o resto fica com humano |
| **Estágio do funil** (`Novo Lead` do funil Vendas) | Entra na Sofia quando o lead cai no funil |

⚠️ **Cuidado importante:** a conta tem **215 contatos e boa parte é cliente de apólice** (tags `apólice ativa`, `cliente`, e o funil "Apólices" inteiro). Se abrir pra "toda mensagem", a Sofia vai começar a tratar cliente antigo como lead novo. Recomendação: começar por tag ou estágio de funil, não abrir geral no primeiro dia.

Onde muda: painel do agente → aba **Ativação**.

### 2. O Willian entra no calendário?

Hoje os **3 calendários da conta têm só a Yolanda** no time. O documento que eles mandaram diz que o agente encaminha para "Willian ou Yolanda", mas do jeito que está **100% das reuniões vão cair na agenda da Yolanda**.

Pergunta pra eles: é isso mesmo que querem, ou o Willian entra no "Consulta Inicial" pra dividir (round-robin)?

Se entrar, é no GHL: Calendários → Consulta Inicial → adicionar o Willian no time.

(Por enquanto a Sofia fala "um dos nossos especialistas" e só cita os dois pelo nome se perguntarem — então funciona dos dois jeitos, sem promessa errada.)

### 3. Quando um humano assume, a Sofia deve calar?

Hoje ela **não** pausa sozinha quando alguém do time responde no inbox — a conta está configurada como 100% IA. Isso foi de propósito: em outra conta (Alves Cury) essa detecção falhou e o bot se auto-pausava sozinho depois de 2 mensagens.

Se o Willian ou a Yolanda pretendem responder junto com ela no mesmo WhatsApp, avisa que a gente liga esse comportamento e testa antes.

---

## Antes de abrir pra lead real (checklist)

- [ ] **Deploy do fix de fuso horário feito** (ver abaixo) — bloqueante
- [ ] Testar 1 conversa completa pelo botão "Testar" do painel
- [ ] Testar 1 conversa real no WhatsApp com a tag `teste-ia`, indo até o agendamento aparecer na agenda da Yolanda
- [ ] Conferir com eles se o tom da Sofia está do jeito que querem (a aba "Identidade" e "Tom & estilo" são editáveis por eles mesmos)
- [ ] Só então trocar a ativação

### ⚠️ Bloqueante: fuso horário

A conta estava com o fuso errado no nosso banco (`America/Sao_Paulo` em vez de `America/Chicago` — Katy/Texas). Isso faz a Sofia oferecer e marcar horário **2 horas errado**.

Já corrigi no banco **e** corrigi a causa no código (o widget do SparkBot dentro do GHL estava gravando o fuso do navegador de quem abria a página — como tem gente do time no Brasil, ia pra São Paulo).

**Mas o fix de código ainda precisa ser deployado.** Enquanto não for, se alguém do time abrir uma página de contato no GHL com o widget do SparkBot, o fuso volta a ficar errado. Confirma com o Pedro que o deploy saiu antes de liberar a Sofia pra lead real.

---

## Texto pra mandar no WhatsApp do Victor

> Victor, montei o agente de IA da Richify (conta da Yolanda + Willian) em cima do documento que eles mandaram. Resumo pra tua reunião com eles:
>
> **Já tá pronto:** a "Sofia", agente de vendas. Ela acolhe o lead, faz perguntas consultivas e conduz pra reunião no calendário "Consulta Inicial". Fala português, inglês e espanhol. Tem follow-up automático em 3 toques se a pessoa sumir. Por decisão deles (tá no documento), ela NÃO explica produto, taxa nem rendimento, não promete retorno e não pressiona — toda pergunta técnica ela joga pro especialista.
>
> **Tá travada numa tag de teste**, então ninguém real recebe nada até você abrir.
>
> **3 coisas pra decidir com eles na reunião:**
>
> 1️⃣ **Como o lead entra na Sofia?** Toda mensagem que chega, ou só quem tiver uma tag de campanha, ou quem cair no estágio "Novo Lead" do funil? Atenção: a conta tem 215 contatos e boa parte é cliente de apólice — se abrir pra tudo, ela vai tratar cliente antigo como lead novo. Eu recomendo começar por tag ou estágio.
>
> 2️⃣ **O Willian entra no calendário?** Hoje os 3 calendários têm só a Yolanda, então TODA reunião vai cair na agenda dela. O documento deles fala "Willian ou Yolanda". Se quiserem dividir, é só adicionar o Willian no time do calendário "Consulta Inicial".
>
> 3️⃣ **Alguém vai responder junto com ela no WhatsApp?** Hoje ela não se cala sozinha quando um humano entra na conversa (foi de propósito, essa detecção já falhou em outra conta). Se eles pretendem atender junto, me avisa que a gente liga e testa antes.
>
> **Antes de abrir pra lead real:** testa 1 conversa completa com a tag de teste até o agendamento cair na agenda da Yolanda. E confirma com o Pedro que o deploy do fix de fuso horário saiu — a conta tava com fuso de São Paulo em vez de Texas no nosso banco, o que faz a IA marcar horário 2h errado. Já corrigi, mas precisa do deploy pra não voltar.
>
> Eles podem editar tom, identidade e a base de conhecimento sozinhos pelo painel do AI Hub. Qualquer coisa me chama.
