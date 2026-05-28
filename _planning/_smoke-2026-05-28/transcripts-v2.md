# Smoke Real de Agentes — 2026-05-28T20:48:03.037Z

> F23 (Pedro 2026-05-28): smoke validation gap. Roda 3 agents distintos com 5 turnos cada usando system prompt REAL do projeto (buildSystemPrompt).

Custos: ~$0.30 estimado.

---

## Sales Sonnet padrão (50/50/50/50)
- **Type:** `sales_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Vendedor de seguros de vida, tom neutro, Claude Sonnet 4.6
- **System prompt:** 7,063 chars
- **Total tokens:** 11,382
- **Latência média:** 2157ms

### Transcript
> **Lead:** Oi, vi anúncio sobre seguro de vida. Pode me explicar?

**Marina** (1813ms · 2049 tok):

> {
>   "message": "Seguro de vida ajuda a proteger sua família financeiramente em caso de imprevistos. Para entender melhor suas necessidades, posso fazer algumas perguntas rápidas? Por exemplo, qual sua idade hoje?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Tenho 35 anos, casado, 2 filhos pequenos.

**Marina** (1329ms · 2151 tok):

> {
>   "message": "Ótimo, 35 anos e com 2 filhos. Isso ajuda bastante. Você já tem uma ideia de quanto gostaria de investir mensalmente nesse seguro?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2" },
>   "conversation_status": "active"
> }

> **Lead:** Acho que posso investir uns 200 dólares por mês.

**Marina** (2235ms · 2282 tok):

> {
>   "message": "Perfeito, um orçamento de 200 dólares por mês. Com esses dados, podemos agendar uma conversa com um especialista para montar a melhor opção pra você e sua família. Tenho horários amanhã às 11 AM ou 2 PM ET, qual prefere?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2", "orcamento_mensal": "200 dólares" },
>   "conversation_status": "active"
> }

> **Lead:** Qual seria o próximo passo?

**Marina** (2489ms · 2400 tok):

> {
>   "message": "O próximo passo é a gente marcar essa conversa com o especialista, que vai explicar tudo detalhado e ajudar a escolher o seguro ideal. Posso confirmar um horário para amanhã, 11 AM ou 2 PM ET?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2", "orcamento_mensal": "200 dólares" },
>   "conversation_status": "active"
> }

> **Lead:** Pode ser sexta às 14h.

**Marina** (2917ms · 2500 tok):

> {
>   "message": "Na lista de horários disponíveis, só temos amanhã às 11 AM ou 2 PM ET. Prefere algum desses?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2", "orcamento_mensal": "200 dólares" },
>   "conversation_status": "active"
> }

---
## Sales GPT-4.1-mini agressivo (70/35/95/70)
- **Type:** `sales_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Tom muito natural, formal-baixo, criativo, agressivo. GPT-4.1-mini.
- **System prompt:** 8,124 chars
- **Total tokens:** 13,174
- **Latência média:** 2129ms

### Transcript
> **Lead:** Oi, recebi seu contato sobre plano de saúde empresarial.

**Carlos** (1168ms · 2338 tok):

> {
>   "message": [
>     "que bom que recebeu, vou te ajudar rapidinho",
>     "pra começar, quantos funcionários tem na sua empresa?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Temos 47 funcionários. Já temos plano da Bradesco mas tá caro.

**Carlos** (2986ms · 2499 tok):

> {
>   "message": [
>     "47 funcionários, show, e já tem plano da Bradesco, entendi",
>     "muita gente nessa situação tem conseguido economizar com a gente",
>     "posso te mostrar umas opções melhores, quer agendar uma conversa rápida com o especialista?",
>     "tenho horário amanhã às 11 AM ou 2 PM ET, qual prefere?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "qtd_funcionarios": "47",
>     "tem_plano_atual": "Bradesco"
>   },
>   "conversation_status": "active"
> }

> **Lead:** Quanto vocês conseguem economizar?

**Carlos** (2211ms · 2634 tok):

> {
>   "message": [
>     "geralmente clientes com perfil parecido conseguem reduzir em até 20% o custo sem perder cobertura",
>     "mas pra te passar algo certeiro, o ideal é analisar sua situação detalhada",
>     "quer que eu já reserve um horário com o especialista? é rapidinho"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "qtd_funcionarios": "47",
>     "tem_plano_atual": "Bradesco"
>   },
>   "conversation_status": "active"
> }

> **Lead:** Quero saber as condições antes de marcar reunião.

**Carlos** (2122ms · 2780 tok):

> {
>   "message": [
>     "entendo, mas as condições variam conforme o tamanho da empresa e o perfil dos funcionários",
>     "pra não perder tempo, que tal uma conversa rápida só pra te mostrar as opções e tirar dúvidas?",
>     "tenho amanhã às 11 AM ou 2 PM ET, qual horário te encaixa melhor?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "qtd_funcionarios": "47",
>     "tem_plano_atual": "Bradesco"
>   },
>   "conversation_status": "active"
> }

> **Lead:** OK, manda info por escrito.

**Carlos** (2156ms · 2923 tok):

> {
>   "message": [
>     "poxa, mandar por escrito não dá pra mostrar as melhores opções personalizadas e tirar dúvidas na hora",
>     "a conversa é rápida e pode te ajudar a economizar de verdade",
>     "posso agendar um horário que não te atrapalhe, tipo 11 AM ou 2 PM ET amanhã?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "qtd_funcionarios": "47",
>     "tem_plano_atual": "Bradesco"
>   },
>   "conversation_status": "active"
> }

---
## Recruitment Sonnet amigável (70/30/80/40)
- **Type:** `recruitment_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Recrutador de corretores autônomos. Tom amigável, baixa pressão.
- **System prompt:** 10,331 chars
- **Total tokens:** 15,951
- **Latência média:** 2363ms

### Transcript
> **Lead:** Oi, vi o anúncio de vagas. Sou interessado.

**Patricia** (1998ms · 2943 tok):

> {
>   "message": [
>     "que legal que se interessou",
>     "me conta rapidinho, vc já tem experiencia na area de seguros ou algo parecido?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "experiencia": "",
>     "tem_licenca": "",
>     "disponibilidade": ""
>   },
>   "conversation_status": "active"
> }

> **Lead:** Não tenho experiência ainda mas tenho vontade.

**Patricia** (2069ms · 3055 tok):

> {
>   "message": "legal, vontade é o que conta mesmo pra começar nessa area. vc tem alguma disponibilidade de horario pra conversar com o especialista e conhecer melhor essa oportunidade?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "experiencia": "não tenho experiência ainda mas tenho vontade",
>     "tem_licenca": "",
>     "disponibilidade": ""
>   },
>   "conversation_status": "active"
> }

> **Lead:** Posso me dedicar full time. Tenho 28 anos.

**Patricia** (1817ms · 3178 tok):

> {
>   "message": "ótimo, full time ajuda bastante pra pegar o ritmo rapido nessa area. agora me diz, vc já tem alguma licença ou certificação pra atuar nessa area de seguros?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "experiencia": "não tenho experiência ainda mas tenho vontade",
>     "tem_licenca": "",
>     "disponibilidade": "full time"
>   },
>   "conversation_status": "active"
> }

> **Lead:** Não tenho licença ainda, é difícil tirar?

**Patricia** (1752ms · 3300 tok):

> {
>   "message": "nao, a gente sabe que pode parecer complicado no começo, mas o especialista vai te explicar direitinho como funciona o processo e o suporte que tem pra vc",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "experiencia": "não tenho experiência ainda mas tenho vontade",
>     "tem_licenca": "não",
>     "disponibilidade": "full time"
>   },
>   "conversation_status": "active"
> }

> **Lead:** Pode ser na próxima semana, tarde.

**Patricia** (4180ms · 3475 tok):

> {
>   "message": "deixa eu ver aqui na agenda do especialista quais horarios ele tem disponivel...",
>   "should_send_message": true,
>   "actions": [
>     {
>       "action": "book_appointment",
>       "parameters": {
>         "options": [
>           {
>             "day": "terça-feira",
>             "time": "2 PM ET"
>           },
>           {
>             "day": "quinta-feira",
>             "time": "7 PM ET"
>           }
>         ]
>       }
>     }
>   ],
>   "collected_data": {
>     "experiencia": "não tenho experiência ainda mas tenho vontade",
>     "tem_licenca": "não",
>     "disponibilidade": "full time"
>   },
>   "conversation_status": "booked"
> }

---

## RESUMO

| Agent | Turns | Tokens | Latência avg | Erros |
|-------|-------|--------|--------------|-------|
| Sales Sonnet padrão (50/50/50/50) | 5 | 11382 | 2157ms | 0 |
| Sales GPT-4.1-mini agressivo (70/35/95/70) | 5 | 13174 | 2129ms | 0 |
| Recruitment Sonnet amigável (70/30/80/40) | 5 | 15951 | 2363ms | 0 |
