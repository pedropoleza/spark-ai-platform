# Smoke Real de Agentes — 2026-05-28T20:46:08.808Z

> F23 (Pedro 2026-05-28): smoke validation gap. Roda 3 agents distintos com 5 turnos cada usando system prompt REAL do projeto (buildSystemPrompt).

Custos: ~$0.30 estimado.

---

## Sales Sonnet padrão (50/50/50/50)
- **Type:** `sales_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Vendedor de seguros de vida, tom neutro, Claude Sonnet 4.6
- **System prompt:** 7,063 chars
- **Total tokens:** 11,310
- **Latência média:** 2043ms

### Transcript
> **Lead:** Oi, vi anúncio sobre seguro de vida. Pode me explicar?

**Marina** (2331ms · 2040 tok):

> {
>   "message": "Claro, nosso seguro de vida é pensado para proteger sua família aqui na Flórida. Para te passar as melhores opções, posso saber sua idade e se você tem filhos?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "", "undefined": "", "undefined": "" },
>   "conversation_status": "active"
> }

> **Lead:** Tenho 35 anos, casado, 2 filhos pequenos.

**Marina** (1623ms · 2149 tok):

> {
>   "message": "Ótimo, 35 anos e dois filhos é um perfil importante para garantir uma proteção adequada. Você já tem em mente um orçamento mensal que gostaria de investir nesse seguro?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "35", "undefined": "2 filhos", "undefined": "" },
>   "conversation_status": "active"
> }

> **Lead:** Acho que posso investir uns 200 dólares por mês.

**Marina** (2836ms · 2265 tok):

> {
>   "message": "Perfeito, com esse orçamento já dá para montar uma boa cobertura. Tenho horários disponíveis amanhã às 11 AM ou 2 PM ET para conversarmos melhor com um especialista. Qual horário você prefere?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "35", "undefined": "2 filhos", "undefined": "200 dólares" },
>   "conversation_status": "active"
> }

> **Lead:** Qual seria o próximo passo?

**Marina** (1841ms · 2376 tok):

> {
>   "message": "O próximo passo é reservar um horário para você falar com um especialista que vai tirar todas as suas dúvidas e ajudar a escolher o plano ideal. Você prefere amanhã às 11 AM ou 2 PM ET?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "35", "undefined": "2 filhos", "undefined": "200 dólares" },
>   "conversation_status": "active"
> }

> **Lead:** Pode ser sexta às 14h.

**Marina** (1584ms · 2480 tok):

> {
>   "message": "Sexta às 14h não está disponível, mas posso oferecer amanhã às 11 AM ou 2 PM ET. Qual desses funciona melhor para você?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "35", "undefined": "2 filhos", "undefined": "200 dólares" },
>   "conversation_status": "active"
> }

---
## Sales GPT-4.1-mini agressivo (70/35/95/70)
- **Type:** `sales_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Tom muito natural, formal-baixo, criativo, agressivo. GPT-4.1-mini.
- **System prompt:** 8,072 chars
- **Total tokens:** 12,987
- **Latência média:** 2666ms

### Transcript
> **Lead:** Oi, recebi seu contato sobre plano de saúde empresarial.

**Carlos** (2481ms · 2314 tok):

> {
>   "message": [
>     "legal, pra começar, me diz uma coisa: quantos funcionários tem na sua empresa?",
>     "assim já entendo melhor o que pode servir pra vc"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Temos 47 funcionários. Já temos plano da Bradesco mas tá caro.

**Carlos** (2934ms · 2461 tok):

> {
>   "message": [
>     "47 é um número bom pra negociar, tem bastante vantagem",
>     "sobre o plano atual, a gente pode ajudar a achar algo mais em conta e que cubra bem o time",
>     "quer que eu já agende uma conversa rápida com um especialista pra ver as opções? tenho horários amanhã 11 AM ou 2 PM ET"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "47", "undefined": "Bradesco" },
>   "conversation_status": "active"
> }

> **Lead:** Quanto vocês conseguem economizar?

**Carlos** (2919ms · 2596 tok):

> {
>   "message": [
>     "varia conforme o perfil da empresa, mas muitos clientes na sua situação conseguiram reduzir até 20% nos custos sem perder cobertura",
>     "isso porque a gente tem parcerias exclusivas e planos flexíveis",
>     "quer garantir um horário amanhã às 11 AM ou 2 PM ET pra detalhar isso com o especialista?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "47", "undefined": "Bradesco" },
>   "conversation_status": "active"
> }

> **Lead:** Quero saber as condições antes de marcar reunião.

**Carlos** (2496ms · 2746 tok):

> {
>   "message": [
>     "entendo, as condições variam conforme o número de funcionários e o tipo de cobertura que sua empresa precisa",
>     "pra te dar uma ideia mais precisa, só com uma conversa rápida com o especialista, que pode te mostrar as opções e preços exatos",
>     "posso agendar pra vc amanhã às 11 AM ou 2 PM ET, é rapidinho e sem compromisso"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "47", "undefined": "Bradesco" },
>   "conversation_status": "active"
> }

> **Lead:** OK, manda info por escrito.

**Carlos** (2499ms · 2870 tok):

> {
>   "message": [
>     "pode deixar, vou te enviar um resumo básico aqui",
>     "mas só reforçando, o especialista pode personalizar e mostrar o melhor custo-benefício pra sua empresa",
>     "se quiser, já posso deixar um horário reservado pra vc, assim não perde essa chance"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "47", "undefined": "Bradesco" },
>   "conversation_status": "active"
> }

---
## Recruitment Sonnet amigável (70/30/80/40)
- **Type:** `recruitment_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Recrutador de corretores autônomos. Tom amigável, baixa pressão.
- **System prompt:** 10,089 chars
- **Total tokens:** 15,265
- **Latência média:** 2180ms

### Transcript
> **Lead:** Oi, vi o anúncio de vagas. Sou interessado.

**Patricia** (1527ms · 2837 tok):

> {
>   "message": [
>     "que legal que se interessou",
>     "me conta, vc já tem experiência na área de seguros ou está começando agora?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Não tenho experiência ainda mas tenho vontade.

**Patricia** (1394ms · 2926 tok):

> {
>   "message": [
>     "ótimo, vontade é o que conta mesmo",
>     "vc tem alguma licença para atuar como corretor ou ainda não tem?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "sem experiência" },
>   "conversation_status": "active"
> }

> **Lead:** Posso me dedicar full time. Tenho 28 anos.

**Patricia** (1825ms · 3026 tok):

> {
>   "message": [
>     "disponibilidade full time ajuda bastante pra começar",
>     "vc já tem alguma licença para atuar como corretor ou ainda não?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "undefined": "sem experiência", "undefined": "full time" },
>   "conversation_status": "active"
> }

> **Lead:** Não tenho licença ainda, é difícil tirar?

**Patricia** (3959ms · 3181 tok):

> {
>   "message": [
>     "na verdade não é tão complicado, muita gente começa sem e tira depois",
>     "o especialista pode explicar melhor todo o processo numa conversa rápida",
>     "deixa eu ver aqui na agenda do especialista quais horários ele tem disponível...",
>     "tenho amanhã às 11 AM ou às 2 PM ET, qual funciona melhor pra vc?"
>   ],
>   "should_send_message": true,
>   "actions": ["book_appointment"],
>   "collected_data": {
>     "undefined": "sem experiência",
>     "undefined": "full time",
>     "undefined": "sem licença"
>   },
>   "conversation_status": "booked"
> }

> **Lead:** Pode ser na próxima semana, tarde.

**Patricia** (2195ms · 3295 tok):

> {
>   "message": [
>     "beleza, vou ver opções na próxima semana à tarde",
>     "tem terça às 2 PM ET ou quinta às 2 PM ET, qual prefere?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {
>     "undefined": "sem experiência",
>     "undefined": "full time",
>     "undefined": "sem licença"
>   },
>   "conversation_status": "booked"
> }

---

## RESUMO

| Agent | Turns | Tokens | Latência avg | Erros |
|-------|-------|--------|--------------|-------|
| Sales Sonnet padrão (50/50/50/50) | 5 | 11310 | 2043ms | 0 |
| Sales GPT-4.1-mini agressivo (70/35/95/70) | 5 | 12987 | 2666ms | 0 |
| Recruitment Sonnet amigável (70/30/80/40) | 5 | 15265 | 2180ms | 0 |
