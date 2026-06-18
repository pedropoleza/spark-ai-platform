# Análise — conta de IG da Bianca Amorim (atendimento atual + fluxo)

> Fonte: `inbound_webhook_samples` da location **`cRavIlyC52vFYgJATgi7`** (company `TdmQMjj86Y3LgppiB96K` — a mesma agência da Marina), janela **17–18/06/2026** (é o que a captura de webhook tem; histórico completo vive no Spark Leads e precisa do token). 101 amostras, **30 contatos**, canais **Instagram + SMS**, 94 msgs reais. Gerado 2026-06-18. Complementa o PDF `FLUXOS DE MENSAGEM Bianca.pdf`.

## 0. Infra confirmada (passos 2 do pedido)
- **App instalado**: webhooks chegando pelo `appId 68fd5ac9…` (nosso app Spark) via `medium:instagram`. 101 amostras só nas últimas ~18h.
- **Token**: a company `TdmQMjj86Y3LgppiB96K` tem company-token fresco no Token Refresher (refresh+access+escopo calendars, atualizado hoje 14:00). A location da Bianca está sob essa company (tabela `locations`, tz America/New_York). Logo o app consegue location-token pra ler/responder quando o agente for ativado.
- **Webhook ao vivo**: última amostra hoje 14:31. ✅

## 1. Quem atende hoje + persona
A conta usa a persona **"Manu" — "Sou a Manu e faço parte da equipe da Bianca"**. **NÃO** é "Maria" (o nome que o nosso spec inventou). Como a Bianca já fala com "Manu" no IG, há um forte argumento de **continuidade** pra nossa IA também se chamar Manu (o lead não estranha a troca de nome no meio do funil).

Igual ao caso da Marina, **quem digita é ambíguo** (humano com respostas-prontas OU ferramenta). Aqui há um sinal a mais de **roteiro/snippet**: vários contatos diferentes recebem a MESMA sequência de bolhas idênticas ("Bom dia, [Nome]! Tudo bem?" → "Que legal, [Nome]! 😊" → "Me conta uma coisa: em qual estado dos EUA você mora hoje?"). Texto idêntico repetido entre leads cheira a automação/saved-replies — mas pode ser pessoa com macros. **Certo:** não é a nossa IA (zero agente na location até agora) e o atendimento é real e caloroso.

## 2. O fluxo real da Bianca (reconstruído)
`saudação calorosa por nome ("Oi/Bom dia, [Nome]! Tudo bem? / Seja bem-vinda ao perfil!") → auto-apresentação ("Sou a Manu, da equipe da Bianca") → contexto do perfil ("a maioria aqui é brasileiro nos EUA buscando crescimento/liberdade") → QUALIFICAÇÃO SUAVE ("você também tá buscando isso ou só gostou do conteúdo?") → [estado] → pergunta-ouro emocional ("o que mais te chamou atenção no conteúdo/trajetória da Bianca?")`

Pelo PDF, o ideal continua: estado → work permit → profissão → **pergunta emocional** ("gosta do que faz ou quer mais liberdade/crescimento?") → **espelhamento empático** ("muitas que chegam até mim vieram desse mesmo lugar… trabalham muito, ganham por hora, mas não constroem algo delas") → ancoragem pessoal + convite pra apresentação → se "quero entender melhor antes" → explica a apresentação + **pergunta-ouro** ("o que mais te chamou atenção quando viu o anúncio?").

## 3. A VOZ real da Bianca (o que a diferencia da Marina)
- **Muito mais quente e emoji-rich**: 🥰😊☺️ aparecem com liberdade ("O favorito aqui de casa hahaha. Awwww 🥰🥰🥰🥰"). Relacionamento PRIMEIRO — teve turno de puro papo (sobre um filme) sem nenhum pitch.
- **Ancora no CONTEÚDO/trajetória da Bianca** ("o que te chamou atenção no conteúdo da Bianca?") — usa a autoridade dela como gancho emocional.
- **Personaliza pela bio do lead** ("Vi que você atua como estrategista financeiro e trabalha com famílias brasileiras nos EUA").
- **Qualificação suave logo na abertura** ("tá buscando isso ou só gostou do conteúdo?") — separa curioso de interessado sem espantar.

> ⚠️ **Tensão com o nosso prompt atual:** a revisão impôs **parcimônia de emoji** (1 a cada 3-4 bolhas) pensando no cético. Mas a marca real da Bianca é **emoji-rico e caloroso**. Decisão: **afrouxar a regra de emoji pra Bianca** (alinhar à voz dela) mantendo bom senso (sem 🚀💰🔥 de venda; sem repetir o mesmo emoji em todo turno). Marina segue contida; Bianca, calorosa. Isso É a diferenciação que o Pedro pediu.

## 4. O que adotar (igualar o atual) + o que a nossa IA soma
**Adotar do atual (rapport):** abertura com auto-apresentação "Manu, da equipe da Bianca" + contexto do perfil + qualificação suave; ancorar no conteúdo da Bianca; personalizar pela bio; emoji caloroso.

**Somar (nossa vantagem):** os mesmos ganhos portados da Marina —
1. **Coleta email + WhatsApp no fechamento** + aviso "mando o link por email e WhatsApp" → lembrete cross-canal (resolve a janela 24h do IG).
2. **Agendamento real**: escolhe horário → coleta contato → confirma com dia/data + **FUSO** explícito + `{{LINK_REUNIAO}}` → avisa cross-canal. (depende do calendar — 👤 Andrea/Pedro)
3. **Conversão de fuso** NY ↔ estado do lead.
4. **Cortesia/registro pro no-permit** + guard "não venda outro produto pra quem não pode ser agente" (recrutamento, não venda).
5. **Pergunta-ouro aprofundada 1 turno** sem esfriar.
6. Blindagem de compliance: renda zero-número, urgência honesta (turma recorrente, vaga real por turma; proibido "última turma do mês"), work permit sem SSN, persona humana, asset pro cético, cap de insistência, aceite-real, anti-repetição do bordão, micro-compromisso.

## 5. Diferença Bianca × Marina (mesmo objetivo, linguagem oposta)
| | Marina (direta) | Bianca (rapport) |
|---|---|---|
| Tom | direto, vai ao ponto | caloroso, escuta, espelha emoção |
| Emoji | contido | **livre/caloroso** (🥰😊) |
| Abertura | qualifica rápido | acolhe + se apresenta + qualifica suave |
| Gancho | a oportunidade/urgência | a **dor emocional** + conteúdo da Bianca |
| Ritmo | enxuto e rápido | vínculo antes do pitch |

## 6. Pendências pra fechar (👤)
- **Persona: "Manu" (recomendado, = conta real) vs "Maria"** — decisão do Pedro.
- **Calendar ID da turma da Bianca + link Zoom** (👤 Andrea/Pedro) — pro agendamento real.
- **Frase-gatilho do anúncio da Bianca** (a Marina ativa por mensagem "Olá Marina, queria entender melhor sobre essa carreira"; a Bianca precisa da dela pra ativação por mensagem em produção). Enquanto não vem, o agente fica **inativo + targeting por tag `maria-teste`** (seguro).
- **Link National Life** (`{{LINK_NATIONAL_LIFE}}`) pro asset do cético.

## 7. Workflow `bianca-rapport-agent` (9 agentes: 4 lentes → draft → 3 lentes adversariais → finalize)

**Veredito: 8.5/10** — liberar **piloto SUPERVISIONADO** na sub-account da Bianca (tag `maria-teste`), DESDE QUE o Pedro feche os 2 placeholders de produto (calendar/link da turma + link National Life) e confirme o lembrete fora-de-IG via time. Sem isso, não soltar pra leads reais com agendamento.

**Achados que viraram fix no prompt final (aplicado, 15.860 chars no agente `17860a86`):**
- 🔴 **Promessa cross-canal não-entregável** (a mais grave): "te mando o link por email e WhatsApp" — o pipeline lead-facing **não dispara** esse lembrete (verifiquei: `follow-up-scheduler.ts:322` cancela a sequência fora da janela 24h pra IG/WhatsApp; a infra de reminder é do SparkBot rep-facing). Era mentira material. **Fix:** manda o link AGORA na DM + "alguém do time te dá um toque" (handoff/F37); coleta email/WhatsApp com propósito que o sistema cumpre. **⚠️ Esse mesmo bug eu tinha posto na Marina hoje — já corrigi a Marina também.**
- 🔴 **Reserva vs honestidade**: os tokens `{{LINK_REUNIAO}}`/`{{dia}}`/`{{hora}}` são placeholders (não há interpolação no runtime — confirmei). Sem turma real, o bot afirmaria "teu lugar tá guardado" e vazaria o token cru. **Fix:** gate de honestidade virou DEFAULT + guard "nunca emita `{{LINK_REUNIAO}}` vazio / não invente link".
- 🔴 **Abertura de 2 caminhos** ("crescimento OU curiosidade?") = o anti-pattern que matou a lead Abby no atendimento real. **Fix:** abertura virou 1 pergunta aberta alinhada à pergunta-ouro, marcada como TEMPLATE A VARIAR (frase idêntica entre leads = tell de automação).
- 🔴 **Espelhamento como tabela-verbatim** soava roteiro. **Fix:** virou PRINCÍPIO (cita o detalhe específico do lead) + trava anti-repetição estendida.
- 🔴/🟡 **Renda**: blindagem reforçada — proibido testemunho em 1ª pessoa ("mudou minha vida"), proibido confirmar número que o LEAD traz ("vi que dá 10k"), catch-all pra %/preço/ticket/meta. A virada de carreira da Manu é **só emocional**, nunca financeira.
- 🟡 **Cap × follow-up**: o teto de 2 reformulações é só in-conversation; a cadência automática pode furar cross-system. Ficou NOTA DE SISTEMA no prompt + decisão aberta de wire.

**Decisões pro Pedro (do workflow):** persona Manu (recomendado, default já aplicado) vs Maria; calendar+link da turma; link National Life; wire do lembrete fora-de-IG (SDR/F37); sinal cap→scheduler; estrutura de custo (pra calibrar "tem que investir?"); frase-gatilho do anúncio; OK no afrouxamento de emoji (fidelidade à voz, não compliance).

> Diferença-chave vs Marina: a Bianca **afrouxa o emoji** (🥰😊 com liberdade, fiel à voz real dela) e abre pela **emoção/vínculo** antes de qualquer pitch — é a diferenciação de linguagem que o Pedro pediu, mesmo objetivo.
