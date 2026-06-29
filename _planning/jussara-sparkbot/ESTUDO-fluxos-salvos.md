# Estudo — Biblioteca de Fluxos Salvos (templates nomeados reutilizáveis)

> Pedro 2026-06-29, a partir do feedback da Jussara (print no chat). Extensão do
> Motor de Orquestração de Tarefas (H41). Tudo continua atrás de
> `TASK_ORCHESTRATOR_ENABLED` (já ON em prod).

## 1. O que a Jussara relatou (3 sintomas)

1. 🛑 **"O robô não busca nas conversas os fluxos? Toda vez vou ter que mandar o fluxo?"**
   → ela quer montar um fluxo UMA vez e depois só dizer *"manda o fluxo de no-show pra Gislene"*.
2. 🛑 **"Fluxo disparado com nome de mulher, outra msg sem nome"**
   → bug do `[nome]` — **JÁ CORRIGIDO e deployado** (fix 2026-06-29, `interpolate.ts`).
3. 🛑 **"Disparou outro fluxo que não foi o que eu pedi"**
   → o bot pegou o fluxo ERRADO.

O print mostra o bot dizendo: *"olhei o histórico e não encontrei um fluxo de no-show
com textos definidos aqui… quer que eu monte um do zero?"* — ele procurou no **transcript
da conversa**, não numa biblioteca de fluxos.

## 2. Causa-raiz (sintomas 1 e 3 = mesmo buraco)

O orquestrador hoje opera no conceito de **"rascunho ativo/recente"** — 1 por vez,
resolvido por **recência**, não por **nome**:

- `resolveDraftAny` (core.ts) → `getLatestDraftForRep` → pega o **último** draft do rep.
  Se ela tem 5 fluxos e diz "o de no-show", ele pega o mais recente (→ fluxo errado = sintoma 3).
- **Não existe tool** pra LISTAR ou BUSCAR fluxos por nome. O prompt manda "buscar o fluxo
  que você mandou nessa conversa" → o bot relê o transcript (que comprime/expira) em vez de
  consultar os drafts salvos (→ "não encontrei" = sintoma 1).
- `task_drafts.status` não distingue **"template que ela reusa"** de **"rascunho abandonado"**.

**Não é falta de persistência** — os fluxos JÁ estão no banco (`task_drafts`/`draft_steps`).
Falta **biblioteca nomeada + busca por nome**.

## 3. O que JÁ existe (reuso — não reconstruir nada)

| Peça | Onde | Reuso |
|------|------|-------|
| Aplicar template a N contatos, **sem consumir** | `materializer.ts` `applyFlowToContacts` | é exatamente o "manda pra fulano" |
| Snapshot canônico do fluxo | `core.ts` `buildSnapshot` | mostrar o fluxo achado |
| Passos persistentes | `draft_steps` (00115) | os textos já estão lá |
| Interpolação `[nome]` por-contato | `interpolate.ts` (hoje) | template aplica certo pra cada um |
| **Scorer fuzzy** `nameScore`/`dice`/`deburr` | `contact-resolver/normalize.ts` (H45) | **genérico string×string** → ranqueia nome de fluxo direto |
| Confidence ladder (high/ambiguous/…) | padrão do `search_contacts` (H45) | mesma UX pra fluxo |

A infra de **aplicar** está pronta. Falta só **achar o fluxo certo por nome** + **marcá-lo como salvo**.

## 4. Design proposto — Opção A: estende `task_drafts` (recomendada)

### 4.1 Schema (1 migration aditiva)
```sql
ALTER TABLE task_drafts ADD COLUMN saved_at timestamptz;     -- null = não salvo; set = na biblioteca
-- opcional: índice pra busca por rep
CREATE INDEX idx_task_drafts_saved ON task_drafts(rep_id) WHERE saved_at IS NOT NULL;
```
- `saved_at` marca "este draft é um template da biblioteca". Ortogonal ao `status` — um fluxo
  pode estar `materialized` (já disparado) **E** salvo. O `title` já é o nome.
- **Não mexe** no CHECK de status (sem risco de quebrar a máquina de estado existente).

### 4.2 Repo (task-drafts.repo.ts)
- `markFlowSaved(draftId, name)` → set `saved_at=now()`, `title=name`.
- `listSavedFlows(repId)` → drafts com `saved_at IS NOT NULL` + contagem de passos.
- `findSavedFlowsByName(repId, query)` → carrega os salvos e ranqueia por `nameScore(query, title)`.

### 4.3 Resolver de fluxo (novo, fininho — espelha contact-resolver)
`task-orchestrator/flow-resolver.ts`:
- `resolveFlow(repId, query)` → usa `nameScore` (deburr + token-set + Dice) sobre os títulos
  salvos → devolve `{ best, candidates[], confidence }` (high / needs_confirm / ambiguous / low),
  **idêntico** ao padrão do `search_contacts` (H45). Zero lógica nova de scoring.

### 4.4 Tools (gated pela flag; user-facing em PT)
| Tool | Risk | O que faz |
|------|------|-----------|
| `save_flow` | medium | Salva o fluxo atual/recente na biblioteca com um nome ("salva como 'No-show'"). |
| `list_flows` | safe | Lista os fluxos salvos (nome, nº de toques, criado em). "quais fluxos eu tenho?" |
| `find_flow` | safe | Acha um fluxo salvo por nome (fuzzy) + confidence. |
| `apply_saved_flow` | **high** | Acha por nome + aplica a 1..N contatos (reusa `applyFlowToContacts`). "manda o fluxo X pra fulano". |

> `apply_saved_flow` resolve nome→fluxo **internamente** (1 tool) pra o LLM não pegar o id errado.
> Alternativa magra: só `find_flow` (devolve draft_id) + o `apply_flow_to_contacts` existente — mais
> superfície de erro pro LLM. Recomendo a tool dedicada.

### 4.5 Prompt (seção do orquestrador)
- **Buscar antes de remontar (inviolável):** rep pediu pra mandar/aplicar um fluxo que já existe
  ("manda o fluxo X", "aquele de no-show") → `find_flow` PRIMEIRO. Achou (high) → confirma o NOME
  e aplica. Ambíguo → `list_flows`/lista e pergunta. **NUNCA** remonta do zero se já existe; **NUNCA**
  dispara fluxo sem o rep confirmar QUAL.
- **Oferecer salvar:** terminou de montar um fluxo com nome claro → "quer que eu guarde como 'X'
  pra reusar depois?" → `save_flow`.

### 4.6 Anti-alucinação (espelha H45, inviolável)
- `find_flow` devolve **nome + confidence**; o bot **confirma o nome** antes de aplicar
  ("Achei *No-show seguro* (5 toques). Mando pra Gislene?").
- Ambíguo (2 "no-show") → lista, nunca auto-escolhe.
- **Nunca** aplica por id cego. Reusa a disciplina já provada do contact-resolver.

## 5. Alternativa — Opção B: tabela nova `flow_templates` (NÃO recomendada)
Tabela separada + `flow_template_steps`, "salvar" = copiar passos. Conceito mais limpo, mas
**duplica toda a infra** (snapshot, apply teria 2 fontes), mais migration e código, sem ganho real.
Reusar `task_drafts` (Opção A) é menor superfície e aproveita `applyFlowToContacts` direto.

## 6. Rollout / dados existentes
A Jussara já tem fluxos montados (Fluxo Triagem, no-show Isah/Aline). Pra biblioteca não começar
vazia, um script marca os bons como salvos (`saved_at=now()`) com nome limpo. (Os 2 "Fluxo Triagem"
duplicados — consolidar em 1, já defusados de nome literal hoje.)

## 7. Fases
1. **F1** migration `saved_at` + repo (markFlowSaved/listSavedFlows/findSavedFlowsByName).
2. **F2** `flow-resolver.ts` (reusa nameScore) + testes de score.
3. **F3** 4 tools + registro (gated) + prompt.
4. **F4** rollout: marcar os fluxos atuais da Jussara como salvos + consolidar duplicados.
5. **F5** smoke com LLM dirigindo ("manda o fluxo de no-show pra X") + stress.

Esforço: ~médio (1 dia). Tudo aditivo, atrás da flag existente, **zero mudança** pra quem não usa.

## 8. Decisões pendentes (👤 Pedro)
- **D1 — Salvar é explícito ou inclui já-disparados?**
  (a) Só `saved_at` explícito (previsível; exige `save_flow`/rollout). ✅ recomendado.
  (b) `find_flow` também enxerga `status='materialized'` com título (acha os já-disparados sem
  re-salvar, mas pode trazer fluxos de teste/lixo).
- **D2 — `apply_saved_flow` (1 tool) vs `find_flow`+`apply_flow_to_contacts` (2 tools)?** Recomendo a dedicada.
- **D3 — Editar fluxo salvo** ("muda o 3º toque do No-show"): incluir no MVP ou v2? (reusa edit_step
  apontando pro draft salvo). Sugiro v2.
- **D4 — Escopo de visibilidade:** fluxos salvos são por-rep (privados) ou compartilhados na location/agência?
  MVP = por-rep.

## 9. Sinergia
O fix de `[nome]` de hoje é **pré-requisito** disto: um template salvo SÓ é seguro de reaplicar a
vários contatos porque o `[nome]` agora interpola por-contato. Os dois juntos = "monta 1 vez, manda
pra quem quiser, cada um com o nome certo".
