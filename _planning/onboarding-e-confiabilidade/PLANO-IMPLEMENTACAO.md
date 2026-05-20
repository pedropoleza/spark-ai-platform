# SparkBot — Confiabilidade Conversacional + Onboarding
### Plano de Implementação — FORGE-3 · 2026-05-20

> **Convenção** (cada tarefa carrega um marcador):
> - 🤖 **Claude** — executo direto (código, prompt, testes).
> - 👤 **Pedro** — ação humana (aprovar cópia, tocar no smoke, setar env).
> - 🤝 **Híbrido** — eu preparo, você valida (smoke onde você interage e eu confiro no banco).

---

## 1. Visão geral

Duas frentes que saíram da análise do fluxo real das 15:34 EDT (agendamento com o Jonathan Duque — levou ~10 min e foi sofrido) + da revisão do onboarding:

- **Frente A — Confiabilidade conversacional:** o bot fragmenta mensagens, perde o contato no meio, ignora dados que o rep já deu, e pergunta o user à toa. 5 correções.
- **Frente B — Onboarding:** termos + aceite por botão + guia de instruções atualizado com as funções novas.

Objetivo: o rep manda o que quer (em rajada, como no WhatsApp de verdade), o bot **junta**, **resolve com firmeza** (sem re-perguntar o que já tem) e **confirma uma vez** — usando botões/listas onde encaixa.

---

## 2. Contexto (o que o fluxo real ensinou)

Conversa 15:34–15:44 EDT (`sparkbot_messages`, rep +17867717077):

| Sintoma observado | Causa | Turnos |
|---|---|---|
| 2 msgs do rep em 3s → **2 respostas** separadas e fragmentadas | **Sem debounce no path Stevo** (cada inbound processa na hora; o path GHL antigo tinha janela) | 19:34:24/:27 → :33/:37 |
| Contato virou "*Gabriel*" no meio (era Jonathan Duque) | **Drift de contato** — contaminou de conversa anterior | 19:35:47 |
| Pediu "4 Jonathan Duque, qual?" **depois** de confirmar — sendo que o rep deu o **telefone** no início | **Não usou o identificador já fornecido** + re-perguntou pós-confirmação | 19:44:09 |
| "rep atual é *John Doe*, não acho na lista — uso *Victor Alves*?" | **Self-user não resolvido**; sugeriu user aleatório | 19:35:24 |
| Calendário, slots e desambiguação vieram como **texto numerado** | **present_options inconsistente** pras escolhas | 19:34:33/:37/:55, 19:44:09 |
| Confirmou → pediu user → re-confirmou → pediu contato | **Confirmou antes de resolver tudo** | toda a sequência |

Onboarding atual (`terms.ts` + `processor.ts:136-162` + `onboarding.ts`): termos só por **texto** ("aceito"); guia de 4 exemplos **desatualizado** (sem filtros, bulk, follow-ups, nem os botões).

---

## 3. Decisões

- ✅ **Debounce leve "latest-wins"** no path Stevo (sem recriar a fila pesada do GHL): janela ~4s, processa só a invocação mais nova, concatenando as msgs não-respondidas do rep numa só.
- ✅ **Ancoragem de contato** é majoritariamente **prompt** (drift é comportamento do LLM) + reforço da regra de re-busca pelo identificador.
- ✅ **Self-user**: resolver automático (`self`); se não achar, **criar sem atribuir** — nunca perguntar nem sugerir outro user.
- ✅ **Regra refinada de botão vs lista**: lista quando 4+ opções **OU** rótulo longo (>~20 chars) **OU** quando uma descrição ajuda (telefone/email/data/stage). Botão só pra ≤3 curtas. Embutida no auto de `core/interactive.ts` **e** no prompt.
- ✅ **Termos por botão** `Aceito ✅ / Não aceito ❌` (ids `terms_accept`/`terms_reject`); `parseTermsResponse` ignora o sufixo de amarração (senão os "não" do texto dos termos viram REJECT). Fallback texto preservado (LGPD).
- 👤 **Cópia do onboarding** (§5 Etapa 5) — Pedro aprova/ajusta antes do merge.

---

## 4. Arquitetura

### A1. Debounce Stevo (🤖)
`stevo-handler`: após persistir a msg do rep, **não processa na hora**. Em vez disso, `waitUntil(debouncedTurn(...))`:
1. `sleep(~4s)`.
2. Query: existe msg `role:'user'` desse rep **mais nova** que esta (na janela)? Se sim → **bail** (a invocação mais nova processa o lote).
3. Se esta é a mais nova: junta todas as msgs `user` desde a última msg `agent` (não-respondidas), **concatena** num input só, e roda `processIncoming` **uma vez**.
4. Idempotência por messageId no insert continua (debounce é só *quando* + *batch*).
- Multimodal: se a rajada tiver arquivo+texto, usa o arquivo como anexo e concatena as legendas/textos. Arquivos isolados seguem normal.
- Configurável por env `STEVO_DEBOUNCE_MS` (default 4000; 0 = desliga → comportamento atual). **Rollback trivial.**

### A2. Ancoragem de contato (🤖, prompt)
`prompt-builder`: (a) ao receber telefone/email/ID, **re-buscar por esse identificador** e conferir o nome antes de agir; (b) uma vez resolvido o contato da tarefa, **manter o mesmo** até concluir — nunca trocar por nome parecido nem por contato de conversa anterior; (c) reforço da regra anti-alucinação de ID já existente.

### A3. Self-user (🤖)
`tools/calendar.ts` (e tasks): `assigned_to` default = `self` → `resolveAssignedUserId`/`getRepGhlUserId`. Se não resolver: **cria sem atribuir** (não pergunta, não sugere outro). Prompt: "appointment/task do próprio rep → atribui a ele em silêncio; nunca liste/sugira outros users a menos que o rep peça explicitamente." + 🤖 investigar por que o `ghl_user_id` do rep não veio na location ativa (identity/data).

### A4. Resolve-antes-de-confirmar + present_options pras escolhas (🤖, prompt + core)
- Prompt: juntar tudo (contato resolvido + calendário + horário + user=self + override) **antes** da confirmação; confirmar **1 vez** no fim.
- Prompt: usar `present_options` pra **calendário, slots e desambiguação** (não texto numerado).
- `core/interactive.ts` `extractInteractiveFromToolCalls`: auto-regra nova → `list` se 4+ **ou** algum label >20 chars **ou** algum option tem `description`; senão `buttons`. (LLM ainda pode forçar via `style`.)

### B. Onboarding (🤖 + 👤 cópia)
- `terms.ts`: nova `TERMS_OF_USE_TEXT` (Cópia 1), nova `buildOnboardingMessage` (Cópias 2+3), `parseTermsResponse` tira o sufixo `— (resposta à pergunta:` antes de checar negação/aceite.
- `processor.ts`: ao mandar termos, retornar `{ text: <termos+fallback>, interactive: { kind:'buttons', body: termos, options:[{id:'terms_accept',label:'Aceito ✅'},{id:'terms_reject',label:'Não aceito ❌'}] } }`. Aceite (tap **ou** "aceito" digitado) → `buildOnboardingForWhatsApp`.
- `stevo-send.ts`: cap defensivo do `description`/body em ~1024 (limite do interativo no WhatsApp).
- Gated pelo `STEVO_INTERACTIVE_ENABLED` já existente (off → termos viram texto numerado; aceite por digitação segue).

---

## 5. Etapas de execução

### Etapa 1 — Debounce no Stevo (maior impacto isolado)
- 🤖 `debouncedTurn` no stevo-handler (latest-wins + concat + env `STEVO_DEBOUNCE_MS`).
- 🤖 Teste: 3 msgs em <4s → 1 processIncoming com texto concatenado; msg isolada → processa normal; arquivo na rajada → anexo preservado.
- 🤝 Smoke: mandar 2-3 msgs em rajada e ver **uma** resposta coerente.
- **Saída:** rajada = 1 resposta 🤝; sem regressão em msg única 🤖.

### Etapa 2 — Ancoragem de contato
- 🤖 Regras no prompt (re-busca por identificador, manter contato da tarefa, anti-troca).
- 🤖 Golden de roteamento (cenário: telefone dado → não re-perguntar; nome repetido de conversa anterior → não trocar).
- **Saída:** no replay do caso Jonathan, o bot não vira "Gabriel" 🤝.

### Etapa 3 — Self-user automático
- 🤖 `resolveAssignedUserId('self')` robusto + fallback sem atribuir; prompt anti-sugestão-de-user.
- 🤖 Investigar `ghl_user_id` do rep na location (por que faltou).
- 🤖 Teste: appointment do rep → atribui self sem perguntar; self irresolúvel → cria sem atribuir.
- **Saída:** não pergunta "qual seu user?" nem sugere user aleatório 🤝.

### Etapa 4 — Resolve-antes-de-confirmar + present_options pras escolhas
- 🤖 Prompt (gather-then-confirm-once + present_options pra calendário/slots/desambiguação).
- 🤖 `core/interactive.ts`: regra rótulo-longo/descrição → lista; teste atualizado.
- **Saída:** no replay, calendário/slots/contatos vêm como lista/botão e há **1** confirmação 🤝.

### Etapa 5 — Onboarding (👤 aprova a cópia)
- 👤 Aprovar/ajustar Cópias 1-3 (abaixo).
- 🤖 `terms.ts` (cópias + `parseTermsResponse` strip do sufixo) + `processor.ts` (termos com botão Aceito/Não) + `stevo-send.ts` (cap body).
- 🤖 Teste: tap "Aceito ✅" (com sufixo de amarração) → accept; "Não aceito ❌" → reject; "aceito" digitado → accept; "não tá ok" → reject (LGPD preservado).
- **Saída:** primeiro contato vira botão de aceite + guia novo; rejeição/aceite digitado seguem funcionando 🤝.

### Etapa 6 — Smoke supervisionado + go-live
- 🤝 Replay do stress test (rajada, troca de contato, agendamento por telefone, taps fora de ordem) + onboarding do zero (resetar `terms_accepted_at` num número de teste).
- 🤖 Validar no banco (1 turno por rajada, contato certo, self atribuído, sent_kind correto, terms_accepted).
- 🤖 Deploy + envs (`STEVO_DEBOUNCE_MS`).
- **Saída:** fluxo do caso real refeito **redondo** 👤+🤖.

---

## 6. Cópias do onboarding (👤 aprovar)

**Cópia 1 — Termos + o que faz (corpo do botão):**
> Oi! Sou o *SparkBot*, teu copiloto aqui no Spark Leads. 👋
> Antes de começar, rapidinho:
> *O que eu faço* — você me pede em texto, áudio, foto, planilha ou PDF e eu executo no seu CRM: notas, tarefas, lembretes, agendamentos, consultas, mover/criar oportunidades, disparos em massa, sequências de follow-up e busca por filtros. Também tiro dúvidas de produto (NLG/carriers).
> *Suas informações* — acesso seus dados respeitando suas permissões e aprendo suas preferências pra ficar mais útil. Fica privado, só seu.
> *Segurança* — sou IA e posso errar interpretando. Por isso, em ações importantes (mandar msg pro cliente, apagar, agendar) eu *confirmo antes*. Não falo de você nem dos seus contatos com mais ninguém.
> *Parar* — manda "parar" que eu silencio; "apagar meus dados" → o admin remove tudo.
> **Topa começar?** → [ Aceito ✅ ] [ Não aceito ❌ ]

**Cópia 2 — Confirmação pós-aceite:**
> Fechou! Tô pronto. ✅
> Tua conta tá em *{cidade (fuso)}* — uso esse fuso pros agendamentos. Mudou de cidade? Só falar.

**Cópia 3 — Instruções (atualizada):**
> Algumas coisas que dá pra pedir:
> • "me lembra em 30min de ligar pro João" — agendo o lembrete
> • "que reuniões tenho hoje?" — vejo tua agenda
> • "cria nota no Pedro Silva: cliente quer Term" — anoto no Spark Leads
> • "manda 'oi, tudo bem?' pra +55 11 9…" — eu confirmo e envio
> • "me mostra os leads sem oportunidade aberta" — filtro na hora
> • "qual o cap do FlexLife em FL?" — consulto na NLG
> Manda áudio, foto, planilha ou PDF que eu processo. E quando eu te der opções, é só **tocar nos botões** — sem digitar. Qualquer coisa, é só pedir. 🚀

---

## 7. Checklist
- [ ] 🤖 Etapa 1 — debounce + teste + smoke
- [ ] 🤖 Etapa 2 — ancoragem de contato
- [ ] 🤖 Etapa 3 — self-user + investigação ghl_user_id
- [ ] 🤖 Etapa 4 — resolve-then-confirm + present_options + regra rótulo-longo
- [ ] 👤 Etapa 5 — aprovar cópias · 🤖 implementar onboarding
- [ ] 🤝 Etapa 6 — smoke + go-live

## 8. Rollback
- **Debounce:** `STEVO_DEBOUNCE_MS=0` → processa na hora (comportamento atual). Sem deploy.
- **Interativo/onboarding:** `STEVO_INTERACTIVE_ENABLED` off → termos e escolhas viram texto numerado; aceite digitado segue.
- **Prompt:** reverter o commit (sem mudança de schema).

## 9. Riscos & mitigações
| Risco | Prob | Impacto | Mitigação | Resp |
|---|---|---|---|---|
| Debounce atrasa resposta de msg única | Média | Baixo | Janela curta (4s) + bail rápido; env ajustável | 🤖 |
| Concat de rajada confunde o LLM | Baixa | Médio | Concatena com quebra de linha (parece o rep falando em partes); golden | 🤖 |
| Ancoragem de contato é prompt (não determinístico) | Média | Médio | Regras fortes + re-busca por identificador; medir no smoke | 🤖 |
| Termos no corpo do botão estourar 1024 chars | Baixa | Médio | Cópia concisa (~880) + cap defensivo no body | 🤖 |
| Self irresolúvel cria sem atribuir (rep esperava atribuído) | Baixa | Baixo | Bot informa "criei sem dono — quer atribuir a você?" | 🤖 |

## 10. Pós-projeto
- 🤖 Atualizar `CLAUDE.md` (debounce Stevo, regra botão/lista, onboarding por botão) + `DECISIONS` + `MEMORY`.
- Backlog: vCard (v2 já planejado), present_options proativo, debounce multimodal avançado (rajada de vários arquivos).
