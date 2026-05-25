# PROMPT — Design do Front-End "Spark AI Hub" (para agente de DESIGN, sem contexto)
### 2026-05-25 · cole tudo isto como prompt. O agente NÃO conhece o projeto — está tudo aqui.

---

## O QUE VOCÊ VAI FAZER

Projete o **front-end visual completo** de um produto SaaS chamado **Spark AI Hub** — um painel web onde **agências de seguros** criam e gerenciam **agentes de IA** que conversam por WhatsApp/Instagram. Quero um **design distinto, premium, coeso e production-grade** (anti-genérico), com **todas as telas** desenhadas em alta fidelidade.

**Entregável:** um **protótipo visual autocontido** — **HTML + Tailwind (via CDN) + Google Fonts**, um arquivo navegável (ou poucos), renderizável direto no navegador, **alta fidelidade**, com **dados realistas em PT-BR** (sem lorem ipsum), **responsivo**, e um **design system documentado** no topo (tokens de cor/tipografia/espaçamento/sombra/raio/motion + componentes). Você **NÃO** integra com backend — é só o **design**; outra pessoa implementa depois. Então capriche na fidelidade visual e deixe os tokens explícitos.

Você tem **liberdade criativa total na estética e nos fluxos não-definidos** (ex.: o passo-a-passo do onboarding, vazios, micro-interações). Comprometa-se com **uma direção forte e memorável** e execute com precisão. **Evite "AI-slop"**: nada de Inter/Roboto/Arial, nada de gradiente roxo em fundo branco, nada de layout clichê. Tipografia com caráter (display + corpo), paleta intencional, atmosfera/textura, motion com propósito.

---

## 1. O PRODUTO (contexto completo — leia com atenção)

**Spark AI Hub** é o painel da plataforma **"Spark Leads"** (um CRM). Donos/operadores de **agências de seguros** usam o painel pra montar e operar **agentes de IA**. Existem dois tipos de agente, por **audiência**:

- **SparkBot — agente "rep-facing"**: fala com o **próprio corretor/operador** (o "rep") pelo WhatsApp dele. É o copiloto: busca contatos, cria notas/tarefas, agenda reuniões, dispara follow-ups, responde dúvidas. **Vem incluso e grátis** em toda conta. Tem 1 SparkBot por conta.
- **Agentes "lead-facing"**: falam com os **leads/clientes** (não com o rep), em nome da agência. Três famílias:
  - **Venda** — qualifica e agenda leads de venda.
  - **Recrutamento** — qualifica e agenda candidatos.
  - **Custom** — montado do zero pra um propósito (ex: agente de **evento/expo**, nicho, temporário).
  Cada agente lead-facing vive numa **sub-account** com **canais conectados** (WhatsApp, Instagram DM, e mais no futuro). São **upsell pago**: **$50/agente por mês**.

**A grande ideia — agente = peças (módulos) que encaixam.** Um agente é montado de **módulos**. O catálogo de módulos:
| Módulo | O que faz |
|---|---|
| **Comportamento** | personalidade, tom (4 dimensões), naturalidade, estilo de resposta |
| **Janela de tempo** | horários ativos / quiet hours / fuso |
| **Follow-up** | sequências automáticas de mensagens |
| **Qualificação** | quais dados coletar do lead (campos) |
| **Agendamento** | marcar reunião (calendário, duração, conflitos) |
| **Anti-spam / Compliance** | limites de envio, opt-out (lead-facing) |
| **Canal** | por onde fala (WhatsApp / Instagram / …) |
| **Operações no CRM** | criar/editar contatos, notas, tarefas, tags, oportunidades |
| **Base de Conhecimento** | responde com base em docs/treinamento da agência |
| **Disparo em massa** | campanhas pra muitos contatos |

**Liberação (entitlement):** os agentes pagos são liberados por **admin** (manual, por enquanto). Quem não tem liberação vê o agente como **bloqueado** (com caminho pra liberar/contratar). SparkBot nunca é bloqueado.

**Público-alvo:** donos de agência de seguros (Brasil + EUA). **Tom da marca:** profissional, confiável, moderno, **premium** — software sério, mas com personalidade e calor humano. **Idioma da UI: PT-BR.**

### Marca (honre isto)
- Nome do CRM na UI: sempre **"Spark Leads"** (ou "Spark"). **NUNCA escreva "GHL" ou "GoHighLevel"** em texto visível.
- Cor da marca: **azul Spark `#1675F2`** (e um tom mais profundo `#155EEF`). Você pode introduzir **1 cor de acento** à sua escolha e definir a paleta toda — mas o azul Spark deve estar presente como cor central.
- **Não** mostre jargão técnico/infra na UI (nada de nomes de provedores, IDs internos, status codes).

---

## 2. TELAS A DESENHAR (todas, alta fidelidade, com dados realistas)

Para **cada tela**, desenhe os estados relevantes: **normal/cheio**, **vazio** (com CTA), **carregando** (skeleton), **erro** (amigável + retry) e, onde houver agente pago, **bloqueado** (sem liberação). Mostre **toasts** de sucesso/erro e **validação** de formulário. Use **dados realistas PT-BR** (nomes de agentes, leads, números, datas).

### 2.1 Shell / Navegação (presente em todas as telas internas)
Barra de topo com marca "Spark Leads", indicador da **conta/agência ativa** (multi-conta — permita trocar), e navegação entre seções: **Agentes** · **Atividade** · **Billing** · **Configurações** · **Admin** (só pra admin). Inclua estado de usuário/logout.

### 2.2 Hub de Agentes (home) — tela mais importante
Lista os agentes **agrupados por audiência**:
- Bloco **"Seu SparkBot"** (rep, incluso) — 1 card.
- Bloco **"Agentes de Leads"** (venda/recrut/custom, pagos).
Cada **card de agente** mostra: nome, tipo, **badge de audiência** ("fala com você" × "fala com leads"), **status** (ativo/pausado), **canais conectados** (WhatsApp/Instagram), **badge de preço** ($50/mês ou "Incluso", ou "Bloqueado — Liberar"), **mini-stats** (ex: "128 msgs/24h", "taxa de resposta 72%"), e **expiração** se for temporário (ex: agente de evento). Botões no card: **Abrir/Configurar**, **Pausar/Ativar**, **Testar**.
**CTA forte `+ Novo Agente`** (abre o onboarding). Desenhe também o **empty state** (conta que só tem SparkBot → convite a criar o 1º agente de leads).
Dados de exemplo: agência "Brazillionaires"; agentes "SparkBot", "Agente de Vendas", "Agente de Recrutamento", "Expo Seguros 2026" (custom/evento, expira em 30/06).

### 2.3 Onboarding / Wizard "Novo Agente" — VOCÊ define o fluxo exato
Objetivo: montar um agente do zero de forma deliciosa e clara. Esqueleto sugerido (refine/repense à vontade): **escolher tipo → conexão (canal/sub-account) → compor módulos → revisar → criar**. Faça a metáfora de **"montar de peças/módulos"** ser tangível e satisfatória.
- **Tipo:** cards dos templates (SparkBot "Incluso"; Venda/Recrut/Custom "$50/mês"), com audiência e **cadeado** se não liberado.
- **Conexão:** SparkBot = "fala direto com você"; lead = escolher canais conectados (WhatsApp/Instagram, com indicador "conectado").
- **Módulos:** ligar/desligar os módulos do catálogo (filtrados pela audiência); o template já vem com um conjunto pré-selecionado.
- **Revisar + nomear + Criar** (com resumo: tipo, audiência, conexão, módulos, preço).
- Desenhe a tela de **sucesso** pós-criação.
Considere também (e pode desenhar como opção/fase) um **modo conversacional**: uma IA que conversa com o usuário e monta o agente por ele.

### 2.4 Detalhe / Configuração do Agente — config **MODULAR**
A config do agente é **organizada por MÓDULOS ligados**: cada módulo é uma **seção** com **toggle** (ligar/desligar) + seus **settings**. A MESMA linguagem vale pra SparkBot e pra lead agents.
- **Header do agente:** nome (editável), status, audiência, conexão, preço, expiração; ações **Salvar**, **Pausar/Ativar**, **Testar** (chat de teste inline), **+ Adicionar módulo** (abre o catálogo), **Remover módulo**.
- **Settings por módulo** (desenhe os controles): Comportamento (4 sliders de tom 0–100, instruções custom, escolha de modelo de IA, modo de confirmação); Janela de tempo (horários + fuso + dias da semana); Follow-up (sequência + intervalos); Qualificação (lista editável de campos a coletar); Agendamento (calendário padrão + duração); Canal (canais habilitados); Operações CRM (tools liberadas/bloqueadas); Base de Conhecimento (upload/editor + instruções); Anti-spam (limites + opt-out).
- Área de **Atividade do agente** (conversas recentes + métricas).

### 2.5 Admin → Liberação de Agentes (Entitlements)
Só admin. **Tabela/grid de contas × capacidade** (Venda / Recrutamento / Custom): status (ativo/revogado), **preço** ($50 default, editável), liberado por/quando, **expiração**. Ações: **Liberar** (com preço + expiração opcional), **Revogar**, editar preço, **buscar/filtrar por conta**. Desenhe o modal de "Liberar agente".

### 2.6 Dashboard / Analytics
KPIs (mensagens, **taxa de resposta**, agendamentos, leads qualificados), **filtro de período** (presets: 7d/30d/custom), **breakdown por agente**, gráfico de atividade ao longo do tempo. Dados realistas.

### 2.7 Billing
Assinatura + uso: **agentes pagos ativos** ($50/mês cada, com total), uso medido (mensagens/áudio/imagem), **cap mensal**, histórico de cobrança. Deixe claro o que é **incluso** (SparkBot) vs **pago**.

### 2.8 Atividade (log) + Configurações (conta)
Log de mensagens/ações com filtros (por agente, canal, período). Configurações da agência (preferências, fuso, marca, usuários).

### 2.9 Login / Landing
Tela de entrada coerente com a marca (entrar na conta).

### 2.10 (Bônus) Chat embed do SparkBot
Um painel de **chat** (estilo mensageiro) do SparkBot — bolhas user/assistente, composer com texto + anexo + áudio, sugestões rápidas, avatar/mascote. Desenhe se quiser dar uma cara nova a ele também.

---

## 3. DIREÇÃO ESTÉTICA (você decide — comprometa-se)
- Escolha tema (claro ou escuro), **tipografia distinta** (uma display com caráter + uma de corpo legível — **não use Inter/Roboto/Arial**), paleta (sobre o azul Spark + 1 acento), textura/atmosfera (grão, grid, mesh, profundidade), **sombras e raios** consistentes, e **motion** com propósito (entradas, hovers, transições de passo).
- Faça um **design system explícito** no topo do arquivo: variáveis de cor, escala tipográfica, espaçamento, raios, sombras, e os **componentes** (botão [primário/secundário/ghost/perigo], card, input, select, toggle, tabs, badge, chip, modal, tabela, slider, skeleton, toast, empty-state). Tudo coeso pra "encaixar".

## 4. BARRA DE QUALIDADE
- **Alta fidelidade**, pronto pra virar produto. Coeso, distinto, premium — **sem AI-slop**.
- **Responsivo** (mobile → desktop). Considere **acessibilidade** (contraste, foco, tamanho de toque).
- **PT-BR** em tudo, dados realistas, **"Spark Leads" (nunca GHL)**.
- Estados completos (cheio/vazio/carregando/erro/bloqueado) e micro-interações.

## 5. FORMATO DE ENTREGA
- **HTML + Tailwind (CDN) + Google Fonts**, autocontido e navegável (um arquivo, ou um por tela + um índice). Renderiza no navegador sem build.
- No topo: o **design system documentado** (tokens + componentes + notas de uso) pra a implementação depois ser fiel.
- Sem backend, sem dados ao vivo — **mock realista**. Foco: a **cara e o fluxo**.

> Resumo: você é livre na estética e nos fluxos abertos (onboarding, vazios, micro-interações). O que está fixo é: o **produto** (agentes modulares rep×lead, SparkBot incluso, lead pago $50, liberação por admin), as **telas** da seção 2, a **marca** (Spark Leads, azul Spark, PT-BR) e a **barra de qualidade**. Capriche.
