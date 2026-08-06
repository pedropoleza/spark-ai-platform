# Richify.us (Yolanda + Willian) — agente(s) de IA lead-facing

**Location:** `VKJITQwWwWVRzce0dbSb` ("Yolanda Pessanha's Account")
**Cliente:** Richify.us — Willian Melo Poubel + Yolanda da Silva Penha Pessanha
**Material-fonte:** `DOC-CLIENTE-treinando-ai.txt` (docx "Treinando AI" enviado pelo cliente, 21 seções + anexo de objetivo)
**Data:** 2026-08-06

---

## 1. Scan: como a plataforma monta agente customizado hoje

Rodei o levantamento de **todos** os agentes lead-facing customizados que já entregamos. O padrão está consolidado e é sempre o mesmo — não existe "fork de código por cliente".

### 1.1 O motor é único, o cliente é dado

Nenhum cliente ganha código próprio. O que varia é **linha em `agents` + linha em `agent_configs`**. O prompt final é montado por `src/lib/ai/sales-prompt-builder.ts` (`buildSystemPrompt`), que concatena ~15 seções nesta ordem:

```
metaInstruction → typeFraming → identity → [leadHistory] → custom_instructions
→ conversation_examples → knowledge_base → objective → recruitment(anti-venda)
→ tone → data_fields → conversationRules → media → booking → feedback → responseFormat
```

Consequência prática (regra que os 4 clientes anteriores confirmaram): **o builder já entrega identidade, tom, qualificação, agendamento, mídia e formato de resposta.** O que a gente escreve por cliente é só o que a plataforma NÃO sabe:

| Onde vai | O quê | Cap |
|---|---|---|
| `custom_instructions` | O **método** do cliente: como abre, como qualifica, objeções, compliance, handoff | 8000 chars |
| `conversation_examples` | Frases-âncora reais (intenções, não script) | 8000 chars |
| `knowledge_base_instructions` | Identidade/filosofia/posicionamento da empresa | 4000 chars |
| tabela `knowledge_base` (por `agent_id`) | Itens longos (documentos, FAQ, páginas) — é o que a Cat "Conhecimento" da UI edita | 12000 no prompt |

### 1.2 Precedentes (o que já está em prod)

| Cliente | Location | Agentes | Particularidade que virou padrão |
|---|---|---|---|
| **Alves Cury** (`apply-alves-cury-agents.ts`) | `YuR0LCZomFzrfkDK2ezo` | Bruna (venda) + Bruno (recrut) | Roteamento por **custom field** quando 2 agentes dividem a mesma location (senão um engole o outro); `auto_pause_on_human_message: false` e `handoff_policy.enabled: false` em conta 100% IA (ligados, o bot se auto-pausava no 2º turno); working_hours OFF |
| **Raquel / Agência UP** (`apply-raquel-agent.ts`) | `7SWfC7Zah7j3wgerHgkz` | Raquel (venda) | Cliente novo → sobe **ACTIVE mas com targeting travado numa tag de teste** (`teste-ia`). Método no `custom_instructions`, identidade na KB, scripts nos exemplos |
| **Marina/Bianca** | — | recrutamento | `forbidden_terms` (bloqueio determinístico de "National Life"/"Five Rings" na saída), `require_contact_before_booking` |
| **Jussara** | — | venda | Task orchestrator (fluxos de follow-up longos) |

### 1.3 Guard-rails que TODO script de cliente repete

- `custom_instructions` ≤ 8000 chars e **zero travessão (—)** — validado com `throw` antes de escrever no DB.
- Escreve com `createAdminClient()` (service role), upsert idempotente (`SELECT` → `UPDATE` ou `INSERT`).
- Script fica em `scripts/apply-<cliente>-*.ts`, com header explicando a decisão.
- Nada disso é fork: depois de aplicado, **o cliente edita tudo pela UI** em `/hub/agents/[agentId]` (rail de Cats: Identidade, Tom & estilo, Ativação, Memória do lead, Canais, Qualificação, Agendamento, Follow-up, Conhecimento, Atendimento, Automações, Pausa, Limites, Proatividade).

---

## 2. Estado real da conta Richify (probe read-only 2026-08-06)

Scripts: `scripts/probe-richify-account.ts` + `scripts/probe-richify-tags.ts` (não escrevem nada).

**Location:** "Yolanda Pessanha's Account" · tz `America/Chicago` · Katy/Texas · richify.us

**Agentes hoje:** **zero.** Conta virgem em `agents`/`agent_configs`. (O `VKJITQwWwWVRzce0dbSb` só aparecia no repo numa notificação de SparkBot pro Willian.)

**Usuários:**

| Nome | ID | Role |
|---|---|---|
| Yolanda Pessanha | `D6woUKpWBJjtv8ga5IZD` | admin |
| Willian Poubel | `H4fmJyvZNLWUzNTnHa8H` | admin |
| Brenno Alves Viola | `8WPW38gFETpzlHc1c2Xb` | user |
| Rodrigo Braz | `Jb4xp63zZNkfltiyu5vp` | user |

**Calendários (3, todos 60min, RoundRobin):**

| Calendário | ID | Team |
|---|---|---|
| **Consulta Inicial** | `ZJX8C3wCIhkUXqVHj1Cu` | só Yolanda |
| Apresentação & Fechamento | `PdGN82VzwqG44ie3U7oN` | só Yolanda |
| Policy Review | `XHzNfhFG0YFpIAZum9rR` | só Yolanda |

> ⚠️ **Achado:** o documento diz que o agente encaminha para "**Willian ou Yolanda**", mas o Willian **não está no time de nenhum calendário**. Do jeito que está, 100% dos agendamentos caem na Yolanda. Ou se adiciona o Willian ao "Consulta Inicial" (round-robin divide), ou o prompt para de prometer os dois.

**Pipelines:** `Vendas` (Novo Lead → Em contato → Follow-up Automático → Apresentação → No Show Apresentação → Proposta → No Show Proposta → Aplicação → No Show Aplicação → Cliente) e `Apólices` (pós-venda: ciclo 12 meses, anniversary, review).

**Custom fields (15):** Underwriting Status, Monthly Premium, Client Policies/Products, Main Objection, Idioma (`Português|Inglês|Espanhol`), Block Incoming Messages, Next Follow-up, Lead Value etc. **Não existe** um campo tipo "AI" de roteamento (o que a Alves Cury usa pra separar venda × recrutamento).

**Contatos:** 215 · os 20 mais recentes (importados em 29/07) estão **sem tag e sem source**.
**Tags cadastradas (33):** `lead quente`, `lead frio`, `leads iul us`, `no-show`, `não interessado`, `indicação`, `follow-up ativo`, `cliente`, `apólice ativa`, `bloqueado`, `reativação apólice`… (várias duplicadas em PT e EN).

---

## 3. O que o documento pede (leitura do material do cliente)

O doc tem 21 seções de contexto de empresa + um anexo final que é a parte operacional. Resumo do que ele **manda o agente fazer**:

- **Objetivo único e explícito:** conduzir para uma **reunião** com um especialista. "O sucesso do agente não é medido pela quantidade de produtos explicados."
- **É marcador de reunião, não consultor.** Proibido explicar produto, taxa, índice, rendimento, benefício específico ou comparar soluções.
- **Postura consultiva:** pergunta antes de falar, gera reflexão (não medo), valoriza o que o lead já tem ("segunda análise", "complementar", nunca "está tudo errado").
- **Nunca:** prometer retorno, garantir resultado, dar conselho jurídico/contábil/tributário, criticar produto/profissional do lead, pressionar, pedir senha/documento/dado bancário, dizer que algo é livre de risco.
- **Agendamento:** nunca "quer agendar?" — sempre pergunta período e oferece **opções concretas** de horário.
- **Não-prontos:** não abandona; pergunta o que trava e reforça que a reunião é descoberta, sem compromisso.
- **Pilares (KB):** análise → proteção → crescimento → **dolarização** → aposentadoria em moeda forte → distribuição → herança/legado + educação financeira + relacionamento de longo prazo com Willian/Yolanda.
- **Perguntas prontas:** o doc entrega ~20 perguntas consultivas e ~15 falas-modelo — matéria-prima direta pra `conversation_examples`.

**O doc é 100% VENDA.** Não há uma linha sobre recrutamento de agentes. → é a pergunta nº 1 da seção 7.

---

## 4. Decisões de arquitetura pra Richify

| # | Decisão | Por quê |
|---|---|---|
| D1 | **1 agente `sales_agent`** (audience `lead`), modelo `claude-sonnet-5` | Padrão Raquel/Alves Cury. Recrutamento entra como agente 2 só se o cliente recrutar (§7 Q1) |
| D2 | Calendário **Consulta Inicial** (`ZJX8C3wCIhkUXqVHj1Cu`) | É literalmente a "primeira reunião" do doc. Os outros 2 são pós-venda |
| D3 | `objective: qualification_and_booking`, `post_booking: stop_and_handoff` | O doc é explícito: agente entrega a reunião e sai |
| D4 | Método do doc → `custom_instructions`; identidade/pilares → `knowledge_base_instructions` + itens de KB; perguntas/falas → `conversation_examples` | Separação que já provou funcionar (Raquel). Textão no prompt degrada; KB é consultada sob demanda |
| D5 | **Compliance como bloco inviolável** no prompt + `forbidden_terms` | O doc lista 12 proibições. Prompt sozinho vaza (caso H50/Marina). `forbidden_terms` é determinístico, redige antes de enviar |
| D6 | `auto_pause_on_human_message: false` + `handoff_policy.enabled: false` no go-live | Lição Alves Cury 2026-07-15: ligados numa conta 100% IA, o bot classificava a própria resposta como "humano assumiu" e morria no 2º turno. Religar só se Willian/Yolanda forem atender junto no inbox |
| D7 | `working_hours` **OFF** | Fora de horário a plataforma **adia** a resposta; lead de anúncio à noite esfria. Padrão dos 2 últimos clientes |
| D8 | Follow-up manual, 3 toques (1h / 24h / 72h), prompt próprio, zero travessão | O doc pede explicitamente pra não abandonar quem não está pronto |
| D9 | Rollout **ACTIVE com targeting travado em tag de teste** | Padrão Raquel. Só contato tagueado recebe; abrir depois é 1 clique na Cat "Ativação" |
| D10 | `activation_mode: trigger_once` | H51: se o targeting for tag e alguém tirar a tag no meio da conversa, o bot emudece. Trigger-once trata a tag como gatilho, não como coleira |
| D11 | `data_fields` enxutos (nome, estado/cidade, objetivo financeiro principal, preocupação/gancho) | O doc manda pedir só o necessário e proíbe dado sensível no 1º contato |
| D12 | `enable_audio_transcription: true` | Público brasileiro manda áudio |

### 4.1 Compliance — o bloco que não pode falhar

Do doc, vira regra dura no prompt (e o que der, `forbidden_terms`):

- ❌ prometer/garantir retorno, rendimento, % , resultado ou aprovação
- ❌ explicar produto, taxa, índice, cap, benefício específico, comparar soluções
- ❌ afirmar que é livre de imposto ou de risco
- ❌ conselho jurídico / contábil / tributário
- ❌ criticar produto ou profissional que o lead já tem
- ❌ pedir senha, nº de documento completo, dado bancário
- ❌ pressionar ou usar medo
- ✅ resposta-padrão pra pergunta técnica: "depende do seu caso → quem te mostra isso é o especialista na conversa"

---

## 5. Implementação

### Fase 1 — Aplicar o agente (script idempotente)

`scripts/apply-richify-agent.ts`, no molde do `apply-raquel-agent.ts`:

1. valida prompt (≤8000 chars, zero travessão) → `throw` antes de tocar no DB
2. `SELECT agents WHERE location_id AND type='sales_agent'` → UPDATE ou INSERT (`audience='lead'`)
3. upsert de `agent_configs` com o bloco completo (persona, tom, calendário, targeting, follow-up, compliance)
4. insere os itens de `knowledge_base` (por `agent_id`) com o conteúdo do doc partido em blocos temáticos: *Sobre a Richify · Missão · Metodologia (5 etapas) · Dolarização · Aposentadoria em moeda forte · Herança e legado · Diferencial e relacionamento · O que o agente não faz*
5. imprime resumo + pendências

### Fase 2 — Conferir na UI (o que o cliente vai ver)

Abrir `/hub/agents/<id>` e passar Cat por Cat (Identidade → Tom → Ativação → Canais → Qualificação → Agendamento → Follow-up → Conhecimento → Atendimento → Limites) confirmando que **tudo que o script escreveu aparece editável e bonito** pro cliente. Sem esse cruzamento, regressão silenciosa escapa (anti-pattern do CLAUDE.md: "refazer fluxo sem gate de paridade").

> ⚠️ **Bug de plataforma a corrigir junto:** o dropdown de modelo da UI (`AI_MODELS` em `src/lib/utils/constants.ts` e a lista local em `agent-detail-view.tsx:795`) **não tem `claude-sonnet-5`** — só 4.6/4.5. Se o cliente abrir a Cat e salvar, o select com valor fora da lista pode zerar o campo e derrubar o agente pro modelo default. Adicionar Sonnet 5 nas duas listas antes de entregar o link.

### Fase 3 — Teste antes do lead real

1. **Test chat** do próprio painel (`test-chat.tsx`) — 6 cenários: lead frio genérico · "quanto custa?" · "quanto rende?" · "já tenho seguro/401k" · "vou pensar" · pedido de conselho tributário.
2. **WhatsApp real** com a tag de teste, 1 número nosso, conversa completa até o agendamento aparecer no calendário da Yolanda.
3. Só então abrir o targeting.

### Fase 4 — Go-live

Trocar o targeting da tag de teste pro critério real (§7 Q3), avisar Willian/Yolanda, e monitorar as primeiras 48h (`execution_log` + conversas).

---

## 6. Riscos

| Risco | Mitigação |
|---|---|
| Bot promete rendimento/valor (o pecado nº 1 do doc) | Bloco de compliance + `forbidden_terms` + teste dirigido na Fase 3 |
| Agendamento cai todo na Yolanda enquanto o bot promete "Willian ou Yolanda" | §7 Q4 — ou adiciona Willian ao calendário, ou o prompt só cita quem está no time |
| Bot responde contato que não devia (215 contatos, muitos são clientes de apólice) | Targeting travado em tag + `Block Incoming Messages` / tag `bloqueado` como regra de exclusão |
| Bot se auto-pausa no 2º turno | D6 (lição Alves Cury) |
| Cliente edita na UI e quebra o agente | Fase 2 + fix do dropdown de modelo |

---

## 7. Execução (2026-08-06) — FEITO

Decisões do Pedro: **só vendas** (não há recrutamento nessa conta) · persona **Sofia** · sobe travado na tag de teste · Willian no calendário fica como anotação pro Victor · **os 3 idiomas**.

**Agente no ar (travado):** `7ce1f6f3-71f3-42f4-ba34-c85ac4f60233` — `/hub/agents/7ce1f6f3-71f3-42f4-ba34-c85ac4f60233`
Script: `scripts/apply-richify-agent.ts` (idempotente) · Teste: `scripts/test-richify-sofia.ts` · Probes: `scripts/probe-richify-account.ts`, `scripts/probe-richify-tags.ts`

| Item | Valor |
|---|---|
| Prompt / exemplos / KB geral | 7990 · 2332 · 1264 chars (cap 8000 — **prompt está no limite**, trimar antes de acrescentar) |
| Itens de KB | 8 (missão, 5 etapas, dolarização, aposentadoria, legado, diferencial, 1ª reunião, limites) |
| Modelo · calendário · fuso | `claude-sonnet-5` · Consulta Inicial · America/Chicago (CT) |
| Targeting | tag `teste-ia`, `activation_mode: trigger_once` |

### 7.1 Bugs de plataforma achados e corrigidos no caminho

| # | Bug | Fix |
|---|---|---|
| B1 | **`locations.timezone` da conta estava `America/Sao_Paulo`** (Katy/TX é CT). Essa coluna é a fonte do fuso do agente: formata os slots livres, a data/hora do prompt e o **offset ISO do `book_appointment`** → reunião marcada 2h errada. Causa: `/api/sparkbot/check-admin` gravava o `timezone` do **navegador** de quem abria o widget (o time tem 2 brasileiros) | Row corrigida + `check-admin` não manda mais o fuso do browser (`route.ts`) |
| B2 | `upsertLocation` escrevia `location_name: null` / `timezone: "America/New_York"` sempre que o caller não passava — e `/api/agents/ui-auth` chama sem os dois. Toda carga do widget apagava o nome real e resetava o fuso que o SSO tinha buscado do GHL | `sso.ts` só escreve a coluna quando o caller tem o valor |
| B3 | `claude-sonnet-5` não estava na lista de modelos da UI. `<select>` com value fora das options renderiza vazio → cliente abrir a Cat e salvar **rebaixava o agente pro modelo padrão** | Adicionado em `constants.ts` e no `agent-detail-view.tsx` |
| B4 | `post_booking.require_contact_before_booking` não estava no zod → `z.object()` **estripava** a chave, e como a UI manda `post_booking` inteiro, todo save do painel apagava o gate (afeta a Marina também) | Adicionado em `validation.ts` + preservado no seed do `agent-detail-view.tsx` |
| B5 | A regra de idioma do builder citava só inglês → lead em **espanhol** era respondido em português | `buildIdentitySection` generalizado (paridade 7/7 e 5/5 verdes) |

> ⚠️ **B1/B2 precisam de DEPLOY.** Até subir, qualquer um do time abrindo uma página de contato no GHL com o widget do SparkBot volta a sujar o fuso da location.

### 7.2 Validação

`scripts/test-richify-sofia.ts` — 8 cenários multi-turno com LLM real: lead frio · pede preço · pede rendimento/% · "já tenho tudo" · pergunta tributária · hesitação · inglês · espanhol. Aplica **8 proibições do doc §19 em TODO turno** (travessão, promessa de retorno, isenção de imposto, ausência de risco, valor/%, auto-declarar-se IA, dado sensível, citar carrier).

- ✅ **As 8 proibições passaram em 100% dos turnos, em todas as rodadas.**
- 2 lacunas REAIS de prompt achadas e corrigidas: (a) "já tenho 401k e seguro" não virava segunda análise, virou gatilho explícito de 3 passos; (b) "vou pensar" era tratado como recusa e a conversa morria, virou ordem obrigatória acolhe → pergunta o que trava → reforça que é descoberta.
- ⚠️ **Não validado no modelo real:** `ANTHROPIC_API_KEY` não está no `.env.local` e é *Sensitive* na Vercel (o `vercel env pull` devolve vazio), então o teste caiu no fallback **gpt-4.1-mini**, que é instável em seguir idioma (numa rodada acertou inglês, na seguinte não). Prod está com Claude normal (zero sinais de key faltando; os erros em `admin_signals` são respostas legítimas da API da Anthropic). Pra fechar: por a chave no `.env.local` e rodar de novo.
- Efeito colateral: as rodadas locais somaram ~30 ocorrências ao `admin_signal` "LLM lead-facing: tier primário degradado" (contador dedupado, sem impacto operacional).

### 7.3 Pendências

**👤 Pedro:** deploy dos fixes B1-B5 · `ANTHROPIC_API_KEY` no `.env.local` pra fechar o teste de idioma.
**👤 Victor (reunião):** ver `GUIA-VICTOR.md` — critério de ativação real · Willian no calendário · se alguém vai atender junto no inbox.

---

## 8. Perguntas abertas (respondidas em 2026-08-06)

1. **Recrutamento existe?** O doc é 100% venda. Faço só o agente de vendas, ou monto também o de recrutamento (nos moldes do Bruno/Alves Cury: qualifica, checa SSN + work permit, e sem documentação faz a virada de chave pra cliente)? Se sim, preciso saber quem entrevista e em qual calendário.
2. **Nome e gênero da persona.** Não pode ser "Yolanda" nem "Willian" (são pra quem o agente encaminha). Precedentes: Bruna/Bruno, Raquel, Marina. Sugestão: **Sofia** (venda) e, se houver, **Rafael** (recrutamento) — apresentando-se como pessoa (`identity_mode: human`), padrão de todos os outros.
3. **Como o lead entra?** Recomendo subir travado numa tag `teste-ia` e abrir depois. O critério final é: toda mensagem inbound? tag de campanha (`leads iul us`)? estágio "Novo Lead" do funil Vendas?
4. **Willian entra no calendário "Consulta Inicial"?** Hoje só a Yolanda está no time dos 3 calendários.
5. **Idioma.** Só PT-BR, ou o agente também atende em inglês/espanhol? (existe custom field `Idioma` com os 3, e eles estão no Texas)
