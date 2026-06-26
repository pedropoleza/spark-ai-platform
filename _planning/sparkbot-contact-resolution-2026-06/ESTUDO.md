# ESTUDO — Resolução de contato do SparkBot (herança de contexto + motor de busca inteligente)

> Pedro 2026-06-26. Bug recorrente: o bot perde o contexto de QUAL contato está em jogo e/ou a busca por nome/telefone falha → responde "não achei, me passa o telefone". Objetivo: estudo + design das 2 partes (1: proatividade/contexto; 2: motor de busca com score). **Nada implementado — estudo + plano (`PLANO.md`) pra aprovar.**
> Evidência de prod e prova do incidente: `INCIDENT.md`. Base: auditoria multi-agente (4 superfícies, file:line) + pesquisa de entity-resolution.

---

## 0. Sumário executivo (8 linhas)

1. **Não é caso isolado — é sistêmico:** 45 "não achei" + 28 "me passa o telefone" em **14 reps** (metade da base) só nos últimos 7 dias, **todos em Sonnet 4.6** (não é o fallback gpt).
2. **São DOIS defeitos que se reforçam.** O bot perde o "quem" (Defeito A) E a re-busca é frágil de propósito (Defeito B).
3. **Defeito A — o `contact_id` nunca chega ao turno.** Ele existe no DB no momento certo (`task_payload.contact_id`), mas é jogado fora em 3 hops: a entrega do proativo não grava na metadata, o loader de histórico nem lê metadata, e a "ponte cross-turn" do turn-context é **dead code** (lê `tool_calls` que o histórico nunca popula).
4. **Defeito B — a busca é exata/frágil.** O fast-path de 90% dos lookups usa `GET /contacts/?query=` (deprecated), termo único cru, **sem fallback**, sem acento, sem fuzzy, sem normalizar telefone na busca, sem score nem ranking por recência.
5. **A tensão de prompt sela o problema:** a regra anti-alucinação (correta) "NUNCA reuse contact_id, re-search SEMPRE" foi implementada da forma mais destrutiva — empurra todo turno pro motor frágil e torna o 0-match **terminal** ("diga não achei").
6. **O unlock já existe no repo:** o Filter Engine **já usa `POST /contacts/search` por-campo** e funciona — o fast-path nunca foi religado nele.
7. **Caso Fernanda = as duas falhas juntas:** o proativo tinha `contact_id=58OGJEO8` (jogado fora) E a contato está cadastrada com typo "fernan**a**da lira" (busca exata por "Fernanda Lira" → 0; só "Lira" acha). Herança OU fuzzy resolveriam.
8. **Solução em 3 camadas:** (A) o dado chega ao turno (plumbing), (B) "contato em foco" herdado como **pista** (re-valida, não inventa), (C) resolver determinístico com fuzzy + telefone + recência + **score** (auto-confirma ≥~0.9 com gap, lista se ambíguo, "não achei" só em último caso).

---

## 1. O incidente (resumo — detalhe + provas em `INCIDENT.md`)

Sabrina recebeu 2 proativos nomeando "Fernanda Lira" (briefing 08:00 + lembrete de tarefa 09:45). Às 10:55 respondeu "Fernanda Lira follow up de recrutamento semana que vem dia 6". O bot (Sonnet) chamou `search_contacts`, buscou "Fernanda Lira" e disse "não achei no CRM, me passa o telefone".

- **Prova #1 (probe na CRM):** `"Fernanda Lira"` → 0; `"Lira"` → **"fernanada lira"** (`58OGJEO8…`). A contato existe; o **nome está com typo** e a busca exige todos os tokens.
- **Prova #2 (DB):** o lembrete `5aa5b196` tinha `task_payload.contact_id = "58OGJEO8…"` — o id exato. Mas a metadata da mensagem proativa só guardou `reminder_id`.

→ O sistema **sabia** quem era a Fernanda e **jogou fora** essa informação duas vezes.

---

## 2. Diagnóstico de causa-raiz (confirmado no código)

### Defeito A — O contexto de contato NUNCA chega ao turno inbound (herança quebrada em 3 pontos)
1. **Nasce com o id:** `proactive/task-reminders.ts:121` grava `task_payload.contact_id`.
2. **Descartado na entrega:** `reminder-runner.ts:257-261` (`deliverReminderWeb`) e `:281-286` (`deliverReminderWhatsapp`) persistem a msg sem `contact_id` — apesar do slot `extraMetadata` existir (`whatsapp-delivery.ts:89`). Idem o dispatcher das regras proativas (`dispatcher.ts:564-570` carrega `target_id`, não uma chave padronizada).
3. **O inbound nem leria:** o history loader faz `.select("role, content, created_at")` (`webhook-handler.ts:740`) — sem `metadata`; e mapeia pra `{role, content}` (`:762-768`).
- **Consequência: dead code.** `processor.ts:400-416` itera `turn.tool_calls` pra reidratar o contato cross-turn, mas o histórico nunca popula esse campo (o próprio comentário em :405 duvida). `createTurnContext()` nasce sempre vazio. **Nenhuma entidade atravessa o turno.**
- A única regra de herança (`prompt-builder.ts:467`, H43) é estreita: só cobre proativo **pós-call** sem-nome; não cobre task/reminder nem briefing — exatamente o caso Fernanda. E não entrega o id (força re-busca).
- ⚠️ Não confundir: o `metadata.ghl_contact_id` que o inbound já grava (`webhook-handler.ts:815`) é o card do **próprio rep**, não o contato discutido.

### Defeito B — A re-busca (fast-path) é exata/frágil, sem score nem fallback
- Fast-path (90% dos lookups por nome): `contacts.ts:54-66` → `ghlSearchContactsList` → **`GET /contacts/?query=<termo cru>`** (`operations.ts:287-298`, endpoint **DEPRECATED** por `_planning/ghl-api-reference.md:23-26`). Termo único, sem montagem por campo, **0 hits → `not_found` sem nenhum fallback**.
- **Acento:** nem o GET, nem o client-side filter (`executor.ts:543-549`), nem `text-ops norm` (`:27-31`) fazem strip-diacritics — só `toLowerCase().trim()`. "Barbara"≠"Bárbara".
- **Telefone:** `normalizePhone` (BR-aware) só roda em create/update (`contacts.ts:245,321`), **NUNCA na busca**. Sem match por sufixo dos últimos 8-10 dígitos.
- **Apelido/grafia:** sem dicionário nem fuzzy ("Jorge Juniot" → "Junior ou só Jorge?").
- **Sem score nem ranking por recência:** `contacts.ts:67-83` devolve lista crua, sem `match_score`, sem `sortBy` — embora `lastActivity` esteja disponível (`filter-tools.ts:177`). O LLM fica entre "não achei" e "qual dos vários?".

### A tensão de prompt (o que sela)
`prompt-builder.ts:423` ("NUNCA reuse contact_id — Re-search OBRIGATÓRIO") + `:425` ("Se 0 hits, DIGA que não achou") empurram todo turno pro motor frágil e tornam o 0-match terminal. Não há instrução de tentar variações (primeiro nome, sem acento) antes de desistir. A política anti-ID-inventado (correta) equipara "não reusar id cego" a "sempre re-buscar e, se falhar, desistir".

### O unlock que já existe
O Filter Engine **já usa `POST /contacts/search` com `filters` array** e funciona hoje (`executor.ts:258-268`); `capabilities.ts:49-88` confirma `firstName`/`lastName`/`phone`/`email` com `server_side_endpoint: "contacts_search"` + ops `contains`/`starts_with`. Dá pra montar busca por-campo (firstName contains X OR lastName contains X) hoje, sem depender da spec V2.

---

## 3. Pesquisa — resolução de entidade (o que sustenta o design)

| Técnica | Aplicação aqui |
|---|---|
| **Strip-diacritics (NFD + `\p{Diacritic}`)** | normalizar os DOIS lados antes do match — mata a classe "acento" (Bárbara/Barbara, João, Conceição) |
| **Token-set similarity** (tolera ordem nome↔sobrenome, subconjuntos) | "Fernanda Lira" vs "fernanada lira" pontua alto mesmo com 1 char e com ordem trocada; melhor que Levenshtein puro pra nomes de pessoa |
| **Fuzzy threshold** (trigram/Jaro-Winkler ~0.85-0.9 pra nomes) | piso pro auto-confirm; abaixo disso vira candidato, não certeza |
| **Recency blending** (boost por `lastActivity`, sem dominar a similaridade) | o "Pedro" que o rep falou ontem ganha do "Pedro" frio — cobre o pedido 2b |
| **Phone: E.164 + match por sufixo (8-10 dígitos)** | recall robusto a formato; E.164/país como desempate no score |
| **Threshold + GAP pro 2º colocado** | guarda contra falso-positivo de homônimo: score alto SEM gap (dois "Pedro Almeida") → lista, nunca auto-confirma |
| **Conversational entity grounding** (entidade ativa entre turnos) | o "contato em foco" — cobre o pedido 1a |

---

## 4. O design (3 camadas) — cobre as 2 partes do Pedro

```
                    PARTE 1 (contexto)                         PARTE 2 (busca)
   proativo/turno ─┐                                   rep diz "marca com o Pedro"
   tem contact_id  │                                            │
        ▼          │                                            ▼
 (A) DADO CHEGA ───┘    (B) CONTATO EM FOCO            (C) resolveContact()
  contact_id na          herdado como PISTA              fuzzy+fone+recência → score
  metadata → loader      no runtime context              ├ ≥0.9 e gap → auto-confirma inline
  lê metadata → bloco    "é a Fernanda, valide           ├ alto sem gap → present_options
  no prompt              antes de agir"                   └ esgotou a escada → "não achei" (raro)
        │                       │                                  │
        └─ get_contact(id) re-valida (exato) ◄── herança nunca é cega: re-valida, não inventa ─┘
```

- **(A) Plumbing** (Defeito A, ponto 1-3): o `contact_id` para de ser descartado e passa a chegar ao turno.
- **(B) Contato em foco** (parte 1 do Pedro): quando o bot já falou de X (proativo ou turno anterior), ele herda o id como **pista** e re-valida via `get_contact` (exato, robusto a fuzzy) — sem re-buscar do zero e sem "não achei".
- **(C) Resolver inteligente** (parte 2 do Pedro): quando NÃO há contexto, o `resolveContact()` resolve nome/telefone com fuzzy + recência + **score**, e o bot decide pelo score (auto-confirma / lista / desiste).

### O equilíbrio anti-alucinação (não reabrir o furo do ID inventado)
- Herança é **sempre de PISTA** (nome/id-candidato de fonte REAL: `task_payload.contact_id` ou tool_result desta conversa), **nunca** de inferência do LLM sobre texto.
- Antes de ação de risco, **re-valida** o id (`get_contact`, exato) e **confirma o nome inline** ("é a Fernanda Lira, certo?") — o rep corrige falso-positivo.
- Herdar id ERRADO é pior que pedir o telefone (age no contato errado). Por isso threshold + gap no auto-confirm e re-validação por id (robusto a contato deletado/mergeado — o motivo original da regra `:422-425`).

---

## 5. Por que isto vale muito
- **Atrito #1 do "último quilômetro":** 45+ falhas/semana em metade da base; cada uma é o bot "burro" na cara do rep.
- **Conecta com o que já existe:** reaproveita `normalizePhone`, o `POST /contacts/search` do Filter Engine, `present_options`, o padrão `turnContextBlock`/`buildMemorySection`, e a âncora-de-contato do scheduling. Pouca coisa é nova (1 módulo `contact-resolver/` + 1 campo JSONB).
- **Compatível com a Fase 1 de custo (H44):** o bloco "contato em foco" vai no **runtime context (user message), não no system cacheado** — não quebra o cache-write otimizado.

→ Execução priorizada em `PLANO.md`.
