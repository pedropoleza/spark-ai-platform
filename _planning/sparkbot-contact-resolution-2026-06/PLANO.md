# PLANO — Resolução de contato (herança de contexto + motor de busca inteligente)

> Pedro 2026-06-26. Companheiro do `ESTUDO.md`. **Nada implementado — plano pra aprovar.**
> 11 fixes (F1-F11) em 3 fases. Objetivo: zerar (quase) os "não achei" — 45/semana hoje em 14 reps.

---

## Princípios
1. **Herança = PISTA, nunca id cego.** Todo id herdado vem de fonte REAL (`task_payload.contact_id` ou tool_result desta conversa) e é re-validado via `get_contact` antes de ação de risco. NÃO reabrir o furo do ID inventado (`prompt-builder.ts:422-425` fica de pé).
2. **Auto-confirm só com score alto E gap** pro 2º colocado (anti-falso-positivo de homônimo). "Marcar com contato errado" é pior que "não achei".
3. **Determinístico onde der.** A escada de busca (campo → primeiro-nome → recall amplo) roda DENTRO da tool/resolver — menos round-trips do LLM, comportamento previsível.
4. **Compatível com H44 (custo):** o bloco "contato em foco" vai no **runtime context (user message)**, nunca no system cacheado.
5. **Cada fase atrás de flag + validação de 1 conversa real** (padrão da casa). Migrations sempre em `supabase/migrations/`.
6. **Não tocar no Filter Engine** (segue pra critério múltiplo/listas) — só reusar o `POST /contacts/search` dele.

---

## Fase A — O dado chega ao turno (plumbing) · trivial/baixo risco · **desbloqueia tudo**

Sem isto, qualquer regra de herança é letra morta. Sozinha já resolve o caso Fernanda (herda o id → zero busca).

| # | Fix | Onde | Esforço/Risco |
|---|---|---|---|
| **F1** | Propagar `contact_id`/`contact_name` do `task_payload` → metadata da msg proativa (as 2 rotas de entrega; slot `extraMetadata` já existe) | `reminder-runner.ts:257-261,281-286` + `ScheduledTaskRow.task_payload` type | trivial / low |
| **F8** | Padronizar `contact_id`/`contact_name` no `extraMetadata` das regras proativas + briefing matinal | `dispatcher.ts:564-570,441-459` | small / low |
| **F2** | Loader de histórico passa a `select('metadata')` e expor pro processor um `[{role, created_at, metadata}]` leve (mantendo os turns do LLM como `{role,content}` — anti content-vazio) | `webhook-handler.ts:738-744,762-768` (+ stevo-handler) | small / low |

**Critério de saída:** 🤖 metadata de msg proativa passa a ter `contact_id`; 🤖 processor recebe o metadata do histórico; 👤 validar que um proativo novo (Fernanda-like) grava o id.

---

## Fase B — Herança de contexto ("contato em foco") · cobre a **Parte 1** do Pedro

| # | Fix | Onde | Esforço/Risco |
|---|---|---|---|
| **F3** | Bloco `# CONTATO EM CONTEXTO` montado no processor (varre últimas ~6 msgs, pega o `metadata.contact_id` mais recente de fonte real) e injetado no **runtime context** (user message). Escopar por `active_location_id`; resetar quando rep nomeia outro contato | `processor.ts:398-419,429-435,466-474`; render em `buildSparkbotRuntimeContext` | medium / med |
| **F4** | Regra de prompt: herança = **PISTA pra re-validar** (`get_contact(id)` exato, ou search por nome), confirma o nome inline, SÓ então age. Precedência explícita sobre `:423`. Generaliza a H43 (`:467`) pra task/reminder + briefing | `prompt-builder.ts:420-426,466-467`; `modules/scheduling.ts:22` | small / med |
| **F10** | (incremental) Ring buffer `rep_identities.profile.recent_contacts` (3-5 itens `{id,name,location_id,last_ref_at,source}`) — alimenta o "Outros recentes" do F3 + sinal de recência pro resolver, sem N chamadas ao GHL. TTL/invalidação ao trocar de contato | `rep_identities.profile` (JSONB aditivo); `buildMemorySection` | medium / low |
| **F11** | Aposentar o dead-code da semeadura cross-turn (`turn.tool_calls` que nunca existe) — housekeeping, sem mudança de comportamento (já é no-op) | `processor.ts:398-419`; `turn-context.ts:91-96` | trivial / none |

**Critério de saída:** 🤖 numa thread onde o bot avisou de X, o turno seguinte do rep ("marca follow-up dia 6") NÃO re-busca às cegas — herda o id, re-valida, confirma o nome; 👤 validar 1 conversa real estilo Fernanda (com F1+F3+F4 o caso fica resolvido) + 1 caso de id deletado (re-validação por id → 404 → re-busca, sem afirmar "feito").

---

## Fase C — Motor de busca inteligente · cobre a **Parte 2** do Pedro

Pro caso SEM contexto prévio ("marca uma reunião com o Pedro" do zero).

| # | Fix | Onde | Esforço/Risco |
|---|---|---|---|
| **F9** | `deburr(s)` central (NFD + strip `\p{Diacritic}` + lower/trim) reusado por filter-engine, text-ops e resolver — mata a classe **acento** já | `filter-engine/executor.ts:543-549`; `text-ops.ts:27-31` | trivial / low |
| **F5** | **Camada `resolveContact()`** (novo `contact-resolver/`): escada determinística — (1) `POST /contacts/search` por-campo (firstName/lastName contains, formato do `executor.ts:258-268`); (2) primeiro-nome isolado; (3) GET recall amplo. Normaliza acento dos 2 lados, token-set similarity, boost de recência, devolve `{best, score, alternatives}`. `search_contacts` vira fino sobre ela + devolve `match_score`/ordenação | novo `contact-resolver/*`; refit `tools/contacts.ts:54-87`; reusa `executor.ts:258-268` + `capabilities.ts:49-88` | large / med |
| **F6** | `normalizePhone` (BR-aware) na BUSCA + match por **sufixo dos últimos 8-10 dígitos** (E.164/país como desempate no score) | `contact-resolver/*` (phone path); `normalizePhone` de `../identity` | small / low |
| **F7** | Regra de prompt por **score**: `≥~0.9 E gap ≥~0.15` → auto-confirma inline mostrando nome+sobrenome ("Quer marcar com o Pedro Almeida?"); alto sem gap → `present_options`; "não achei" só depois da escada esgotar | `prompt-builder.ts:425,605-610`; `present_options` | small / med |

**Critério de saída:** 🤖 "Fernanda Lira" passa a achar "fernanada lira" (~0.9) e auto-confirmar; 🤖 "Barbara" acha "Bárbara"; 🤖 telefone em formato BR acha; 🤖 2 homônimos → lista, não auto-confirma; 👤 validar com um lote dos casos reais de prod (Tida, Maria Silva, Jorge Juniot, Eusébio).

---

## Tabela ROI / ordem de execução

| Fase | Fixes | Impacto | Risco | Resolve |
|---|---|---|---|---|
| **A** | F1, F8, F2 | desbloqueia herança; sozinha já mata o caso Fernanda via F3 | baixo | dado chega ao turno |
| **B** | F3, F4, F10, F11 | **Parte 1** — bot herda quem é, para de re-perguntar | médio (eval) | contexto/proatividade |
| **C** | F9, F5, F6, F7 | **Parte 2** — busca robusta a typo/acento/apelido/telefone + score | médio-alto (eval) | "não achei" do zero |

**Quick wins isolados:** F9 (acento) e F1+F2 (plumbing) são trivial/small e já cortam uma fatia grande sozinhos. F5 é o maior lever pro caso-do-zero, mas é o de maior esforço.

---

## Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Herdar id ERRADO → age no contato errado | id só de fonte real; re-valida via `get_contact` (exato); confirma nome inline antes de ação de risco; F4 mantém `:423` de pé |
| Falso-positivo de fuzzy em homônimo (2 "Pedro Almeida") | threshold + **gap** pro 2º; sem gap → `present_options`, nunca auto-confirma |
| Recência "grudar" no contato errado | `last_ref_at`/TTL no buffer; invalidar quando rep nomeia outro; recência NÃO domina a similaridade |
| Reabrir a alucinação de ID (regra `:422-425`) | F4 é aditiva e explícita ("você AINDA valida"); herança só onde há "contato em foco" |
| Telefone BR +55 × US +1 colidem por sufixo | E.164/país como desempate final no score |
| Custo do cache (H44) | bloco "contato em foco" no runtime context (user msg), nunca no system cacheado |
| GHL `POST /contacts/search` mudar de spec | já é usado em prod pelo Filter Engine; copiar o formato existente |

---

## O que precisa do Pedro (👤)
1. **Aprovar o plano** + a ordem (A → B → C; quick wins F9/F1 podem ir antes).
2. **Migration** do `recent_contacts` (F10) — aditiva em `rep_identities.profile` (JSONB, pode nem precisar de migration formal) ou coluna; Claude escreve, Pedro aplica.
3. **(opcional) Corrigir o cadastro da Fernanda** ("fernanada"→"Fernanda") — mas o objetivo é o bot NÃO depender disso.
4. **Ligar cada fase** após validação de 1 conversa real.

---

## Fora de escopo (anotado)
- Dicionário de apelidos PT-BR/EN (Beto→Roberto, Bill→William) — Fase futura; o fuzzy já cobre boa parte.
- Dedup/merge de contatos duplicados no CRM (causa upstream de parte dos homônimos) — problema de dados, não do bot.
- Resolver de entidade pra empresas/pipelines (só contatos por ora).
- Migrar 100% do `search_contacts` pro POST V2 (a escada do F5 já usa o POST onde importa; o GET fica como recall).
