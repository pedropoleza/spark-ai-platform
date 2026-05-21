# SparkBot — Review Listas & Botões: adoção + QUANDO/COMO
### Plano (o mais efetivo) · 2026-05-20

> Review dos erros pós-17h EDT do Pedro. Missão: fazer lista/botão **realmente
> entrarem** nos momentos certos, definindo QUANDO e COMO.

---

## 1. Diagnóstico (review da conversa pós-17h)

**`present_options` praticamente NUNCA dispara.** Em todos os turnos de escolha, a
resposta veio `sent_kind:"text"` (numerada) e `tools` SEM `present_options`:

| Turno | O que veio | Devia ser |
|---|---|---|
| 21:06:27 | "Criar nota OU mover stage?" (texto) | **botão** |
| 22:07:49 | "Tem muitas Marcias 😅 me dá sobrenome/telefone" (texto) | **lista** (se ≤10) das Marcias com telefone na descrição |
| 03:21:30 | "qual pipeline e stage? me confirma… ou listo" (texto) | **lista** |
| **03:21:47** | Pedro digitou **"lista"** → bot mandou "1. 1-Prospects 2. Prospecting. Qual?" em **TEXTO** | **lista** (o caso que crava) |

(Erros adjacentes: proativo perguntou de uma "Marcia" sem contexto e depois não soube
qual era — bug de contexto do proativo + desambiguação; tratados de passagem.)

## 2. Causa raiz

**Orientação conflitante no prompt.** A seção de canal ainda ensina, *com exemplos
concretos*, a formatar opções como **texto numerado** — e isso vence a seção nova de
`present_options` (exemplo concreto + seção sempre-presente + hábito do modelo):
- `prompt-builder.ts:500` — "Use listas com `-` ou `1.` `2.` pra opções múltiplas."
- `:516-522` — "Pra opções múltiplas use lista numerada… 1. *Pedro Poleza* 2. *Pedro Silva* Qual deles?"
- `:536-542` — outro exemplo numerado com SPLITTER.

O LLM tem `present_options` disponível (gate on) mas escolhe o caminho de texto porque o
prompt o ensina a fazer isso, com exemplo. **Adesão, não disponibilidade.**

## 3. A REGRA — QUANDO e COMO (a definição pedida)

### QUANDO usar interativo (present_options)
Sempre que você apresentaria uma **escolha de conjunto fechado** ou um **sim/não**:
- **Confirmação** de ação (Confirmar/Cancelar, sim/não) → **botão**
- **Desambiguação** (vários contatos/opps com nome igual) → **lista** (telefone/email na descrição), se ≤10; se >10, peça 1 filtro
- **Seleção fechada**: pipeline, stage, calendário, location → **lista** (nomes longos)
- **Horários (slots)** → **botão** se ≤3, **lista** se 4-10
- **Quente/fria**, **aprovar/editar/cancelar follow-up**, **estratégia de disparo** → botão/lista
- Qualquer **"qual desses?" / "X ou Y?"** → present_options

### QUANDO texto (NÃO interativo)
- Pergunta **aberta** ("como foi a call?")
- Pedir **valor livre** (nome, telefone, email, valor, data, texto de nota)
- Resposta **informativa** (não é escolha)

### COMO escolher o tipo
- **Botão**: ≤3 opções **curtas** (≤20 chars), sem descrição. (Confirmar/Cancelar, quente/fria, 3 horários.)
- **Lista**: 4+ opções **OU** rótulo longo (>20) **OU** precisa de descrição (telefone/email/data/stage). (Pipelines, calendários, contatos.)
- ⚠️ O **texto numerado** é gerado AUTOMÁTICO pelo sistema (fallback web/GHL) — **o LLM NUNCA escreve lista numerada à mão.** Ele chama `present_options`.

## 4. Plano (mais efetivo) — prompt + backstop determinístico

A lição do review: prompt sozinho **não basta** (já tínhamos a seção present_options e
mesmo assim não disparou). Então: corrige o prompt **E** põe uma rede determinística.

### Etapa A — Unificar o prompt (tira o conflito + reforça)
- 🤖 **Remover/reescrever** as orientações de texto-numerado (`:500, :516-522, :536-542`)
  pra apontar pra `present_options`. Deixar explícito: "NUNCA escreva 1. 2. 3. à mão pra
  escolha — chame present_options."
- 🤖 Tornar `present_options` o caminho **DEFAULT** pra escolhas, com **exemplos concretos
  por cenário** (desambiguação, pipeline/stage, calendário, slots, sim/não) — exemplo é o
  que dirige adesão do modelo.
- 🤖 SPLITTER `---`: manter só pra texto livre em partes, não pra opções.

### Etapa B — Backstop determinístico (a rede que garante)
- 🤖 No processor, DEPOIS do LLM: se **não** houve `present_options` E o `text` tem padrão
  de opções numeradas (≥2 linhas `^\s*\d+[.)]`) E tem cue de escolha (termina com "?" / contém
  "qual"/"escolhe"/"prefere") → **auto-converte** em lista (parse dos itens → options; body = a
  pergunta antes da lista) e seta `ProcessOutput.interactive`.
- 🤖 Guard contra falso-positivo: só converte com cue de escolha; se for lista informativa
  ("fiz 3 coisas: 1…2…"), não converte.
- 🤖 **Métrica**: loga `interactive_backstop_fired` quando dispara = o LLM esqueceu →
  mede adesão e calibra o prompt. Meta: backstop disparando cada vez menos.

### Etapa C — Casos estruturais (os mais frequentes)
- 🤖 Exemplos no prompt pra cada tool de seleção retornar via present_options:
  `search_contacts` (múltiplos)→lista · `list_pipelines`→lista · `list_calendars`→lista ·
  `get_free_slots`→botão/lista. (Opcional fase 2: as próprias tools devolverem um hint de
  "choices" que o runner renderiza — remove o LLM da equação nesses casos.)

## 5. Etapas, validação, rollback

- **Etapa A** (prompt): golden de roteamento — cenários (desambiguação, pipeline, calendário,
  slots, sim/não) devem pedir present_options; texto livre (nome/valor) NÃO.
- **Etapa B** (backstop): teste puro do detector/conversor (numerada+cue→lista; informativa→
  não converte; já-tem-present_options→não duplica).
- **Etapa C**: cobertos pelos exemplos + golden.
- **Smoke** (👤 Pedro): refazer o caso "lista" (03:21) e a desambiguação de contato → vir
  tocável. Eu valido `sent_kind` no banco.
- **Rollback**: `STEVO_INTERACTIVE_ENABLED` off → tudo volta a texto. Backstop só roda com
  o gate on. Prompt revertível por commit.

## 6. Riscos
| Risco | Mitig. |
|---|---|
| Backstop converte lista informativa | Só com cue de escolha + termina em "?" |
| Prompt muda demais e regride outra coisa | Mudança cirúrgica nas 3 linhas + golden de regressão |
| LLM ainda esquece às vezes | Backstop cobre deterministicamente; métrica mede |
