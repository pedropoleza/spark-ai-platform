# Marina Lab — página de teste e treino do agente de pós-atendimento (2026-08-26)

> Pedido do Pedro: uma UI temporária (dias, não meses) pra **Marina Couto** testar o agente,
> mandar sugestões/feedback e — o mais importante — **mandar print de conversa real e receber
> uma sugestão de resposta pra copiar**. Modo semi-automático: a IA NÃO fala com o lead;
> a Marina copia se gostar.

## 1. Por que isso vale mais que uma tela de teste

O `agent_feedback` já é lido pelo prompt (`buildFeedbackSection` em `sales-prompt-builder.ts:965`:
3 positivos como "estilo aprovado" + 5 negativos como "evitar", com a sugestão dela virando
`→ melhor: "..."`). Ou seja: **o 👍/👎 dela com sugestão entra no prompt do agente no turno
seguinte, sem deploy.** É a forma mais barata de capturar o estilo dela — melhor do que a
gente adivinhar a partir de prints (foi exatamente a lacuna que o swarm de 25/08 apontou:
a fidelidade foi medida contra a destilação, não contra a fonte).

O modo print fecha o outro lado: a gente passa a ter **pares reais (conversa do lead → o que
a Marina de fato mandaria)**, que é material de treino de primeira e valida o agente contra
casos que ninguém inventou.

## 2. Decisões de desenho

| Questão | Decisão | Motivo |
|---|---|---|
| Auth | Senha única em env (`MARINA_LAB_PASSWORD`) → cookie httpOnly JWT 7d | É temporário e pra 1 pessoa. Sem tabela de usuário, sem fluxo de recuperação. |
| Kill-switch | `MARINA_LAB_ENABLED` | Some sem deploy quando acabar o teste. |
| Envio real | **NUNCA.** Chat usa o endpoint de teste (`execute_actions:false`, `skipSendMessage:true`) | O combinado é semi-automático: a IA não fala com lead. |
| Chat | Reusa `/api/agents/test` com auth alternativa escopada ao agente da Marina | Zero duplicação do motor (histórico, prompt, sessão). Um `if` na rota. |
| Imagem do print | Processada em memória, **não** armazenada | PII de terceiros. Guardamos o texto extraído + a sugestão, que é o que serve de treino. |
| Onde grava | 👍/👎 → `agent_feedback` (alimenta o prompt) · resto → `marina_lab_feedback` (tabela nova) | Separar o que treina do que é recado pra gente. |
| Modelo do print | Mesmo `processWithAI` (Claude, vision) do pipeline | Um caminho só de multimodal; já testado em prod. |

## 3. Superfície

`/marina` — página única, 3 abas:

1. **Conversar** — fala com o agente como se fosse um lead. Cada resposta tem 👍 / 👎 /
   "eu diria assim..." (a sugestão vai pro prompt). Botão de recomeçar conversa.
2. **Sugestão de resposta** (o modo semi-automático) — sobe 1-3 prints da conversa com o
   lead + um bilhete opcional ("ela já disse que não tem o dinheiro"). A IA devolve:
   - o que ela entendeu do print (pra Marina conferir que leu certo),
   - **as bolhas prontas pra copiar** (botão de copiar em cada uma e em tudo),
   - e o porquê daquela resposta em 1 linha.
   👍/👎 + "eu mandaria assim" em cima da sugestão.
3. **Sugestões** — caixa livre pra ideia, correção de fato, "isso ela nunca falaria".

## 4. Rotas

- `POST /api/marina/auth` — `{senha}` → cookie. `DELETE` → sai.
- `POST /api/agents/test` — ganha auth alternativa: cookie da Marina vale **só** pro
  `agent_id` dela (defesa: o agente vem do token, não do body).
- `POST /api/marina/sugestao` — `{imagens:[dataUri], nota?}` → sugestão de resposta.
- `POST /api/marina/feedback` — `{tipo, texto, mensagem_ia?, rating?}`.

## 5. O que fica de fora (de propósito)

- Não conecta com a conversa real do CRM (ela copia e cola — é o combinado).
- Não guarda imagem.
- Sem multiusuário, sem permissão granular, sem histórico navegável de sessões antigas.
- Sem app mobile: é web responsivo (ela vai usar do celular, então o layout é mobile-first).

## 6. Quando acabar

`MARINA_LAB_ENABLED=0` mata a página. Os dados (feedback + pares de print) ficam — são o
material de treino. A tabela é aditiva e não é lida por nenhum caminho de produção além do
`agent_feedback`, que já existia.
