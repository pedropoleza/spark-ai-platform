# Stress Test 02 — Brazillionaires (Account Assistant)

**Data:** 2026-04-28
**Persona:** Agente brasileiro novato em treinamento na sub-agência Brazillionaires
**Endpoint:** `POST https://spark-ai-platform.vercel.app/api/agents/account-assistant/synthetic-test`
**Sessão:** `b65fe612-e8bf-42f3-87f3-84f630a08514`
**Rep:** `+17867717077` → `1eeb02cc-1a48-4b56-b177-52dcbca07ac2`
**Turnos:** 12 (sequenciais, contexto reaproveitado via `session_id`)

---

## 1. Resumo Executivo

| Métrica | Valor |
|---|---|
| Total turnos | 12 |
| **PASS** | **11** (91,7%) |
| **FAIL** | **1** (8,3%) — Turn 9 (Clube dos $10K com inferência além dos chunks) |
| **WARNING** | 1 (Turn 5 — não chamou `query_carrier_knowledge` em pergunta de processo onde havia chunk relevante "Fazer o Fingerprinting") |
| Bot inventou | 1 (Turn 9 — "Clube dos $10,000" não existe nos chunks; foi inferido a partir de "Defina suas Metas") |
| Bot recusou indevidamente | 0 |
| Diferenciou hierarquia (Brazillionaires/Five Rings/NLG) | **PASS** (Turn 6 — resposta correta sem tool, baseada em conhecimento do prompt) |
| Português PT-BR natural | PASS em 12/12 |

**Veredito geral:** Bot performou bem em conteúdo de KB (`agency_brazillionaires`), citou fontes (Frederico Martins, Rita, vídeos Vimeo, link source), respeitou estrutura. Principais riscos: (a) inferiu sobre "Clube dos $10K" mesmo sem chunk explícito; (b) Turn 5 não disparou tool quando deveria; (c) modelo oscilou entre `claude-sonnet-4-6` e `gpt-4.1` no meio da conversa.

---

## 2. Métricas Agregadas

| Métrica | Total | Média/turno |
|---|---|---|
| Tokens prompt | 303.572 | 25.298 |
| Tokens completion | 5.756 | 480 |
| Tokens cached (read) | 239.863 | 19.989 |
| **Cache hit ratio** | **79,0%** | — |
| Latency total | 266.870 ms | **22.239 ms** |
| Latency mín | 6.192 ms | (Turn 12) |
| Latency máx | 43.529 ms | (Turn 9) |
| Modelo `claude-sonnet-4-6` | 8/12 turnos | — |
| Modelo `gpt-4.1` | 4/12 turnos (T5, T6, T8, T9) | — |
| Tools chamadas | 12 chamadas em 9 turnos | T5, T6, T12 sem tool |

### Observação sobre custo
- Cache prompt está bem alto (79%), bom indicador de prompt cache funcionando.
- gpt-4.1 nos turnos 5-6, 8-9 com latência maior (média 31,8s vs claude 19,5s).

---

## 3. Detalhamento por Turno

### Turn 1 — Emergency Contact List
- **Pergunta:** "Acabei de entrar na agência, sou novato. Como funciona a Emergency Contact List? Pra que serve?"
- **Modelo:** claude-sonnet-4-6 | **Latency:** 14.483 ms | **Tokens:** 27.821 prompt / 492 comp / 23.062 cached
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)` → 5 chunks, top similarity 0.613
- **Resposta resumida:** Explica que ECL é estratégia durante aplicação, pede 3 nomes/telefones de pessoas de confiança do cliente, pitch é proteger cliente + gerar leads. Cita Frederico Martins e a história do "Bruno da equipe do Paulo" que fez $40K de uma família. Menciona portal Brazillionaires "Como Atender Clientes".
- **Observação:** PASS. Resposta 100% fundamentada no chunk 0.613 ("Como utilizar o Emergency Contact List"). Nome (Frederico Martins) e história ($40K) batem com a transcrição. Linguagem PT-BR natural.

### Turn 2 — Power Monday
- **Pergunta:** "E como faço pra entrar no Power Monday? Sou obrigado?"
- **Modelo:** claude-sonnet-4-6 | **Latency:** 6.753 ms | **Tokens:** 24.341 / 214 / 23.062
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)` → **0 chunks** retornados (nenhum acima do threshold 0.4)
- **Resposta resumida:** Reconhece honestamente que não tem info, sugere consultar upline ou portal, oferece nova busca se rep der nome exato.
- **Observação:** PASS. Comportamento correto quando KB não retorna. Não inventou. Resposta breve e útil.

### Turn 3 — Napkin Presentation
- **Pergunta:** "Me explica o Napkin Presentation passo-a-passo, simulando que tô na frente de um cliente leigo."
- **Modelo:** claude-sonnet-4-6 | **Latency:** 20.950 ms | **Tokens:** 28.332 / 803 / 23.062
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)`
- **Resposta resumida:** Lista 4 napkins: (1) 3 ingredientes da riqueza, (2) Tic-Tac-Dough/jogo da velha financeiro, (3) Bob e Living Benefits, (4) Plano Indexado com floor 0%. Inclui script falando do "Bob" e exemplo "S&P 500 cai 30% em 2008".
- **Observação:** PASS. Estrutura coerente com material clássico Five Rings/Brazillionaires. Linguagem rica e didática em PT-BR.

### Turn 4 — Agendar prova de licença em MA
- **Pergunta:** "Como faço pra agendar a prova de licença em Massachusetts?"
- **Modelo:** claude-sonnet-4-6 | **Latency:** 12.319 ms | **Tokens:** 29.805 / 477 / 24.566
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)` → 5 chunks, top "Agendar a Prova" 0.522
- **Resposta resumida:** Passo 1 curso pré-licença em xcelsolutions ($49,99 com desconto Brazillionaires), Passo 2 botão "Schedule Exam" depois da prova final, Passo 3 MA não exige fingerprint resident, Passo 4 nipr.com pra aplicar pela licença. Alerta que chunks são de 2020 e podem estar desatualizados.
- **Observação:** PASS. Citou link de fonte (https://partners.xcelsolutions.com/brazillionaires) e alertou sobre staleness. Ponto MA-específico ("não exige fingerprint resident") é informação que **não está explícita nos chunks** — esse é um detalhe que merece verificação humana, mas não é invenção descabida.

### Turn 5 — Documentos para fingerprint
- **Pergunta:** "Que documentos preciso pra fazer fingerprint? Posso fazer em qualquer lugar?"
- **Modelo:** **gpt-4.1** | **Latency:** 22.599 ms | **Tokens:** 8.884 / 238 / **0 cached**
- **Tools:** **NENHUMA** (não chamou `query_carrier_knowledge`)
- **Resposta resumida:** Lista ID com foto, recibo do agendamento, SSN/confirmation number. Diz que tem que fazer em local autorizado (Identogo, Fieldprint). Reitera que MA resident não exige.
- **Observação:** **WARNING.** Existe chunk "Fazer o Fingerprinting" (similarity 0.52 visto em T4!), e o bot deveria ter buscado. Como rodou em gpt-4.1 sem cache (0 cached), e respondeu de conhecimento geral, há risco de info incorreta sobre vendors específicos da Brazillionaires. Ponto MA não-resident específico não foi validado contra KB.

### Turn 6 — Diferença Five Rings vs Brazillionaires
- **Pergunta:** "Qual a diferença entre o Five Rings e o Brazillionaires? Sou de qual?"
- **Modelo:** **gpt-4.1** | **Latency:** 27.734 ms | **Tokens:** 9.146 / 205 / 8.064
- **Tools:** **NENHUMA**
- **Resposta resumida:** Five Rings = MGA/IMO (organização maior, treinamento nacional, eventos grandes, relação com carriers). Brazillionaires = sub-agência dentro da Five Rings, brasileira, liderança própria (Rita, Paulo), grupo WhatsApp, portal próprio. Conclui: "Você faz parte da Brazillionaires, plugada na Five Rings".
- **Observação:** PASS. **Hierarquia correta** (Brazillionaires < Five Rings < NLG carrier). Não confundiu com NLG. Resposta provavelmente vem do system prompt do account-assistant, não dos chunks. Linguagem clara.

### Turn 7 — Princípios Rita para convidar casal
- **Pergunta:** "Tô tentando convidar um casal pra apresentação. Quais princípios básicos a Rita ensina?"
- **Modelo:** claude-sonnet-4-6 | **Latency:** 17.808 ms | **Tokens:** 32.422 / 651 / 24.828
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)`
- **Resposta resumida:** 3 princípios: (1) Lembre do propósito (não vender), (2) Desconecte-se do resultado, (3) Respeite o nível de relacionamento. Dicas práticas: "me avisa quando tiver dois minutinhos", convidar casal junto pra conversão maior. Cita portal Brazillionaires "Como Convidar".
- **Observação:** PASS. Princípios condizem com material da Rita. PT-BR fluente.

### Turn 8 — Dicas Rita para Inforce
- **Pergunta:** "Que dicas a Rita dá pra Inforce? Como abordo cliente sobre uma apólice antiga?"
- **Modelo:** **gpt-4.1** | **Latency:** 33.405 ms | **Tokens:** 22.574 / 447 / 18.688
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)`
- **Resposta resumida:** Sempre perguntar se cliente tem seguro inforce/lapsed nos últimos 12/6 meses. Se sim, perguntar carrier, face amount, classification, status, data cancelamento. Para replacement: comissão menor + form 8027 + mais demora. Tom consultivo, nunca desmerecer plano antigo.
- **Observação:** PASS. **Form 8027** confirmado nos chunks (texto bate com "PORTUGUESE - DICAS DA RITA - 2026 - Replacement"). Latency alto (33s) — possível impacto do gpt-4.1.

### Turn 9 — Clube dos $10,000 ⚠️
- **Pergunta:** "Como funciona o Clube dos $10,000? É realista bater isso no primeiro ano?"
- **Modelo:** **gpt-4.1** | **Latency:** 43.529 ms | **Tokens:** 22.988 / 323 / 19.200
- **Tools:** `query_carrier_knowledge(kb=agency_brazillionaires)` → 2 chunks "Defina suas Metas" (0.468), "Conheça o Nosso Modelo de Negócios" (0.401)
- **Resposta resumida:** Define Clube dos $10K como meta simbólica de $10K de comissão em um mês, dá acesso a calls exclusivas/bônus internos, é realista mas depende de ritmo. Cita "fonte: portal Brazillionaires, vídeo 'Defina suas Metas', verificado em 05/2020".
- **Observação:** **FAIL.** Verificação dos chunks: nenhum dos 2 chunks retornados menciona literalmente "Clube dos $10,000" ou "$10K Club" — eles falam de Target Premium, Production Credit, escadinha de comissão (45→90%), Blackjack ($156K em 12 meses). O bot **inventou/inferiu** a definição do "Clube dos $10K". Citou fonte falsa ("vídeo Defina suas Metas"), o que aumenta a credibilidade percebida mas não cobre o conteúdo. Risco alto de desinformar rep novato.

### Turn 10 — Imagem em mídia social + uso de logo NLG
- **Pergunta:** "Tem dicas pra minha imagem na mídia social? Posso usar logo da NLG?"
- **Modelo:** claude-sonnet-4-6 | **Latency:** 35.534 ms | **Tokens:** 38.773 / 664 / 28.940
- **Tools:** **2 chamadas paralelas** — `query_carrier_knowledge(kb=national_life_group, category_hint=compliance)` + `query_carrier_knowledge(kb=agency_brazillionaires)`
- **Resposta resumida:** NLG KB não retornou compliance específico → orienta NÃO usar logo NLG/Five Rings sem autorização, confirmar com upline. Mídia social (Rita): perfil pessoal pode no início, evitar fotos informais (biquíni/sem camisa), linguagem profissional ("frase pode sair no jornal"), evitar política/religião/futebol. Cita Vimeo 414160995.
- **Observação:** PASS. **Excelente uso de tool** — buscou em 2 KBs distintas (carrier + agency). Conduta conservadora sobre logo (correto). Vimeo ID parece real. Cobertura completa.

### Turn 11 — IUL vs Roth IRA
- **Pergunta:** "Tô confuso entre IUL e Roth IRA — me explica como vender essa diferença pro cliente."
- **Modelo:** claude-sonnet-4-6 | **Latency:** 25.564 ms | **Tokens:** 41.304 / 1.044 / 30.654
- **Tools:** **2 chamadas** — `kb=national_life_group, category_hint=product` + `kb=agency_brazillionaires`
- **Resposta resumida:** Pontos comuns (cresce/saca livre de imposto), perdas Roth IRA (limite $6K-$7K/ano, limite renda $140K solteiro/$208K casado, sem floor), ganhos IUL (sem limite, floor 0%, LIBR, death benefit, Living Benefits). Script: "Roth IRA turbinado". Alerta que limites de contribuição podem estar desatualizados.
- **Observação:** PASS. Conteúdo bate com chunk "Plano Indexado vs Roth IRA" (0.577). Termo "Roth IRA turbinado" presente literalmente no chunk. Resposta extensa (1.044 completion tokens) mas justificada. Excelente chamada paralela.

### Turn 12 — Quem é a Rita?
- **Pergunta:** "Quem é a Rita? Resumo rápido."
- **Modelo:** claude-sonnet-4-6 | **Latency:** 6.192 ms | **Tokens:** 17.182 / 198 / 15.737
- **Tools:** **NENHUMA** (apoiou-se no contexto da conversa)
- **Resposta resumida:** Rita = uma das lideranças principais da Brazillionaires. Aparece com "Dicas da Rita" no portal cobrindo Inforce, Underwriting, Term Conversion, Owner Change, redes sociais, replacement. Mentora operacional ("como fazer na prática"). Sugere começar por Inforce e Como Convidar.
- **Observação:** PASS. Resposta condizente com chunks já vistos na conversa (vários chunks mencionam "Dicas da Rita"). Não chamou tool, mas apoiou-se em contexto de turnos anteriores — comportamento correto pra pergunta de followup. Latency baixa (6s).

**Detalhe importante:** Turn 1 (chunk "Preferências das Notificações - NLG") explicitamente identifica "Rita Pierotti-Madden" como Brazillionaire desde 2018, Liaison dos Brazillionaires na Five Rings, trabalha com Halie & Madison em new business, Nora & Amber & Hope em contracting, etc. **O bot omitiu o sobrenome "Pierotti-Madden" e o cargo de Liaison** — info enxuta foi pedida ("resumo rápido"), mas perdeu autoridade na resposta.

---

## 4. Findings Críticos

### Críticos (FAIL)

**F1 — Turn 9: Invenção do "Clube dos $10,000"**
- Bot definiu uma estrutura de programa que **não está nos chunks retornados**. Os chunks "Defina suas Metas" e "Conheça o Nosso Modelo de Negócios" falam de Target Premium, escadinha de comissão (45%→50%→55%→...→90% Blackjack em $156K em 12 meses), mas nenhum menciona literalmente "Clube dos $10,000" como instituição.
- Risco: rep novato repassa info falsa pra colegas.
- **Recomendação:** ajustar system prompt para forçar abstinência quando chunk não cobre o termo específico — algo como "se a pergunta usa um termo que não aparece literalmente nos chunks, responda com base apenas no que está nos chunks ou diga que não tem essa info".

### Warnings

**W1 — Turn 5: Não chamou tool quando deveria**
- Pergunta sobre fingerprint era trivial pra KB e existe chunk "Fazer o Fingerprinting" (visto em T4 com similarity 0.52). Bot rodou em gpt-4.1 sem cache (0 cached) e sem tool, respondendo de conhecimento geral.
- Risco: info desatualizada ou genérica em vez de info específica da Brazillionaires/MA.
- **Recomendação:** revisar lógica de roteamento — pergunta com palavras-chave "fingerprint", "license", "exam" deve sempre disparar `query_carrier_knowledge(kb=agency_brazillionaires)`.

**W2 — Modelo oscilando claude/gpt no meio da conversa**
- T1-T4 claude → T5-T6 gpt → T7 claude → T8-T9 gpt → T10-T12 claude. Sem padrão óbvio (não é alternância simples). Latency em gpt notavelmente maior (T9: 43.5s).
- Risco: comportamento inconsistente; gpt-4.1 aparenta ser fallback ou roteador escolhendo errado.
- **Recomendação:** verificar lógica de model routing no `synthetic-test`. Pode ser fallback após erro silencioso. Adicionar log de motivo.

### PASS com nota

**P1 — Turn 4: Info MA-específica não confirmada**
- Bot disse "Massachusetts NÃO exige fingerprint pra licença resident" — afirmação confiante mas não consta literalmente nos chunks listados (que são gerais). Pode ser correto, mas KB não confirma. Bot já alertou que chunks estão stale, o que mitiga risco.
- **Recomendação:** se o agent quer fazer afirmação state-specific, deve buscar com `state_query` ou indicar no prompt que apenas reproduza o que vê nos chunks.

**P2 — Turn 12: Omitiu sobrenome e cargo da Rita**
- "Rita Pierotti-Madden", Liaison oficial dos Brazillionaires na Five Rings desde 2018 — info disponível em chunk visto no T1. Bot deu resumo correto mas genérico. Cliente pediu "resumo rápido", então ok, mas teria ganho autoridade.

### Hierarquia (PASS forte)

**Bot diferenciou corretamente NLG (carrier) / Five Rings (MGA) / Brazillionaires (sub-agência)** em T6, T10, T11. Em T10, fez chamada paralela em 2 KBs distintas, demonstrando entendimento da estrutura.

---

## 5. Recomendações Concretas

### Prioridade Alta

1. **System prompt anti-invenção (referente F1):** adicionar instrução explícita: *"Se a pergunta menciona um termo, programa, ou nome próprio (ex: 'Clube dos $10K', 'Power Monday') que NÃO aparece literalmente nos chunks retornados, NÃO defina o termo. Diga que não tem info específica e oriente o rep a buscar no portal."* Esse padrão preveniria T9.

2. **Forçar tool em perguntas de processo (referente W1):** lista de gatilhos lexicais que devem sempre chamar `query_carrier_knowledge`: fingerprint, license, exam, prova, licença, NIPR, xcelsolutions, replacement, inforce, application, aplicação. Hoje T5 escapou.

3. **Investigar model routing (referente W2):** logar motivo de escolha de modelo. Se gpt-4.1 é fallback após timeout/erro do claude, adicionar telemetria. Latency em gpt-4.1 chegou a 43.5s (T9), prejudicando UX.

### Prioridade Média

4. **Aumentar threshold para inferência:** se top similarity < 0.5 e pergunta menciona substantivo próprio (Power Monday, Clube $10K), mudar pra modo "não tenho info" mais rigoroso.

5. **Ingestão de chunks Power Monday (referente T2):** se "Power Monday" é evento real da Brazillionaires (provável), criar chunk dedicado. Hoje retorna 0 chunks.

6. **Atualizar timestamp em chunks stale:** `is_stale=true` em material relevante (Emergency Contact, Defina Metas) reduz confiança. Verificar se a info ainda vale e atualizar `last_verified_at` ou marcar como evergreen.

### Prioridade Baixa

7. **Citar source URL nas respostas:** todos os chunks têm campo `source` com URL do portal. Bot às vezes diz "portal Brazillionaires seção X" mas raramente cita URL. Aumentaria confiança e permitiria rep ir direto à fonte.

8. **Templates de resposta para perguntas de followup curtas (T12):** quando pergunta é resumo de algo já visto na conversa, bot poderia citar "como mencionei em X turnos atrás" e amarrar contexto (atualmente recomeça do zero conceitual).

---

## Anexo — Tools Chamadas por Turno

| Turn | Tool calls | KBs queridas |
|---|---|---|
| 1 | 1 | agency_brazillionaires |
| 2 | 1 | agency_brazillionaires (0 chunks) |
| 3 | 1 | agency_brazillionaires |
| 4 | 1 | agency_brazillionaires |
| 5 | **0** | — |
| 6 | **0** | — |
| 7 | 1 | agency_brazillionaires |
| 8 | 1 | agency_brazillionaires |
| 9 | 1 | agency_brazillionaires |
| 10 | 2 (paralelas) | national_life_group + agency_brazillionaires |
| 11 | 2 (paralelas) | national_life_group + agency_brazillionaires |
| 12 | **0** | — |
