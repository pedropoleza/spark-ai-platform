# Smoke Real de Agentes — 2026-05-28T20:54:29.694Z

> F23 (Pedro 2026-05-28): smoke validation gap. Roda 3 agents distintos com 5 turnos cada usando system prompt REAL do projeto (buildSystemPrompt).

Custos: ~$0.30 estimado.

---

## Sales Sonnet padrão (50/50/50/50)
- **Type:** `sales_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Vendedor de seguros de vida, tom neutro, Claude Sonnet 4.6
- **System prompt:** 8,745 chars
- **Total tokens:** 13,618
- **Latência média:** 2565ms

### Transcript
> **Lead:** Oi, vi anúncio sobre seguro de vida. Pode me explicar?

**Marina** (1991ms · 2501 tok):

> {
>   "message": "Seguro de vida ajuda a proteger sua família financeiramente em caso de imprevistos. Para te passar uma proposta adequada, posso saber sua idade e se tem filhos?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Tenho 35 anos, casado, 2 filhos pequenos.

**Marina** (1522ms · 2600 tok):

> {
>   "message": "Ótimo, obrigado por compartilhar. Além disso, você já tem uma ideia do orçamento mensal que poderia destinar para o seguro de vida?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2" },
>   "conversation_status": "active"
> }

> **Lead:** Acho que posso investir uns 200 dólares por mês.

**Marina** (1681ms · 2720 tok):

> {
>   "message": "Perfeito, com essas informações já dá para avançar. Qual dia e turno (manhã ou tarde) funciona melhor para conversarmos com um especialista e ele te passar todos os detalhes e valores?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2", "orcamento_mensal": "200 dólares" },
>   "conversation_status": "active"
> }

> **Lead:** Qual seria o próximo passo?

**Marina** (6014ms · 2852 tok):

> {
>   "message": "O próximo passo é agendar uma conversa com um especialista que vai te apresentar as opções de seguro de vida conforme seu perfil e orçamento. Me diga um dia e turno (manhã ou tarde) que seja melhor para você, que eu verifico a disponibilidade e já confirmo o horário.",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "idade": "35", "filhos": "2", "orcamento_mensal": "200 dólares" },
>   "conversation_status": "active"
> }

> **Lead:** Pode ser sexta às 14h.

**Marina** (1619ms · 2945 tok):

> {
>   "message": "Vou verificar a disponibilidade para sexta às 2 PM ET e já te confirmo.",
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
- **System prompt:** 9,806 chars
- **Total tokens:** 15,116
- **Latência média:** 1563ms

### Transcript
> **Lead:** Oi, recebi seu contato sobre plano de saúde empresarial.

**Carlos** (1321ms · 2783 tok):

> {
>   "message": ["legal que recebeu", "pra começar, quantos funcionários tem na sua empresa?"],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Temos 47 funcionários. Já temos plano da Bradesco mas tá caro.

**Carlos** (1633ms · 2909 tok):

> {
>   "message": ["beleza, 47 funcionários e já com plano da Bradesco", "muita gente nessa situação tem conseguido opções melhores com a gente", "quer que eu veja uns horários pra um especialista te apresentar?"],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "qtd_funcionarios": "47", "tem_plano_atual": "Bradesco" },
>   "conversation_status": "active"
> }

> **Lead:** Quanto vocês conseguem economizar?

**Carlos** (1508ms · 3010 tok):

> {
>   "message": ["o especialista vai te passar os valores exatos na conversa", "mas posso tentar agendar uma ligação rápida essa semana, tenho poucos horários disponíveis"],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "qtd_funcionarios": "47", "tem_plano_atual": "Bradesco" },
>   "conversation_status": "active"
> }

> **Lead:** Quero saber as condições antes de marcar reunião.

**Carlos** (1763ms · 3141 tok):

> {
>   "message": ["entendo, mas as condições variam muito conforme o perfil da empresa", "a melhor forma de ver isso é com o especialista, que já traz tudo personalizado pra vc", "posso tentar um horário rápido, só pra apresentar o que pode ser melhor pra sua empresa"],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "qtd_funcionarios": "47", "tem_plano_atual": "Bradesco" },
>   "conversation_status": "active"
> }

> **Lead:** OK, manda info por escrito.

**Carlos** (1589ms · 3273 tok):

> {
>   "message": ["infelizmente não temos material detalhado por escrito que mostre as condições personalizadas", "mas posso agendar uma ligação rápida pra te explicar tudo e tirar suas dúvidas direto com o especialista", "tem algum dia e turno (manhã ou tarde) essa semana que funciona melhor pra vc?"],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "qtd_funcionarios": "47", "tem_plano_atual": "Bradesco" },
>   "conversation_status": "active"
> }

---
## Recruitment Sonnet amigável (70/30/80/40)
- **Type:** `recruitment_agent`
- **Model:** `gpt-4.1-mini`
- **Descrição:** Recrutador de corretores autônomos. Tom amigável, baixa pressão.
- **System prompt:** 12,013 chars
- **Total tokens:** 17,921
- **Latência média:** 1599ms

### Transcript
> **Lead:** Oi, vi o anúncio de vagas. Sou interessado.

**Patricia** (1303ms · 3378 tok):

> {
>   "message": [
>     "legal que se interessou",
>     "me diz rapidinho, vc ja tem experiencia trabalhando como corretor de seguros ou em algo parecido?"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": {},
>   "conversation_status": "active"
> }

> **Lead:** Não tenho experiência ainda mas tenho vontade.

**Patricia** (1176ms · 3457 tok):

> {
>   "message": "vc tem licença pra atuar como corretor de seguros ou ainda nao?",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "experiencia": "não tenho experiência, mas tenho vontade" },
>   "conversation_status": "active"
> }

> **Lead:** Posso me dedicar full time. Tenho 28 anos.

**Patricia** (1609ms · 3567 tok):

> {
>   "message": [
>     "show, disponibilidade full time ajuda bastante",
>     "me diz, vc ta em qual estado?",
>     "assim ja consigo te ajudar melhor"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "experiencia": "não tenho experiência, mas tenho vontade", "disponibilidade": "full time" },
>   "conversation_status": "active"
> }

> **Lead:** Não tenho licença ainda, é difícil tirar?

**Patricia** (2556ms · 3707 tok):

> {
>   "message": [
>     "entendo, mas nao se preocupa com isso agora",
>     "o especialista vai explicar tudo direitinho na conversa, inclusive sobre a licença",
>     "me fala seu estado pra eu ver os horarios disponiveis e ja agendar uma conversa com ele"
>   ],
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "experiencia": "não tenho experiência, mas tenho vontade", "disponibilidade": "full time", "tem_licenca": "não" },
>   "conversation_status": "active"
> }

> **Lead:** Pode ser na próxima semana, tarde.

**Patricia** (1351ms · 3812 tok):

> {
>   "message": "deixa eu ver aqui na agenda do especialista quais horarios ele tem disponivel na proxima semana a tarde...",
>   "should_send_message": true,
>   "actions": [],
>   "collected_data": { "experiencia": "não tenho experiência, mas tenho vontade", "disponibilidade": "full time", "tem_licenca": "não" },
>   "conversation_status": "active"
> }

---

## RESUMO

| Agent | Turns | Tokens | Latência avg | Erros |
|-------|-------|--------|--------------|-------|
| Sales Sonnet padrão (50/50/50/50) | 5 | 13618 | 2565ms | 0 |
| Sales GPT-4.1-mini agressivo (70/35/95/70) | 5 | 15116 | 1563ms | 0 |
| Recruitment Sonnet amigável (70/30/80/40) | 5 | 17921 | 1599ms | 0 |
