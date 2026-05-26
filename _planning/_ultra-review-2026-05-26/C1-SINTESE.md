# C1 — Front-end & UX · Síntese (ultra-review 2026-05-26)

Análise **READ-ONLY por código** (tsx + `src/app/hub/hub.css`). Screenshots ao vivo = orquestrador (separado).
Domínio: `src/app/hub/**`, `src/components/hub/**`, `src/app/embed/sparkbot/**`, `src/lib/hub/data.ts`.

> Formato: **WORKS** / **BREAKS** (`file:line` — o quê — porquê — fix 1 linha) / **RISK**.
> Severidade: **P0** quebra/inacessível · **P1** degrada · **P2** polish.

---

## Tabela de severidade (resumo executivo)

| # | Sev | Área | Achado | Arquivo:linha |
|---|-----|------|--------|---------------|
| 1 | **P1** | A11y | Modal de agendamento do embed SEM role/aria-modal/Esc/focus-trap/focus-restore (regressão vs modais do hub) | `embed/sparkbot/page.tsx:1212-1221` |
| 2 | **P1** | A11y / Responsivo | Sidebar colapsada (≤880px, iframe estreito) vira icon-only SEM `title`/`aria-label` → nav sem nome acessível | `components/hub/sidebar.tsx:32` + `hub.css:441-448` |
| 3 | **P1** | Estados ausentes | NENHUM `loading.tsx`/`error.tsx`/`not-found.tsx` em `/hub` (telas `force-dynamic` com múltiplas queries) | `src/app/hub/**` |
| 4 | **P1** | Fluxos / Dados | Feed de atividade NÃO filtra por audiência mas copy diz "agentes de leads" → mostra ações do SparkBot | `lib/hub/data.ts:163-187`, `hub/page.tsx:108`, `messages-view.tsx:58` |
| 5 | **P1** | Dados / UX | `loadHubActivity` hardcoda `agent:"Agente"` e `channel:"Spark Leads"` → coluna de agente inútil (sempre "Agente · Spark Leads") | `lib/hub/data.ts:183-184` |
| 6 | **P1** | A11y | 4 sliders de tom (`<input type=range>`) sem `aria-label` (label só visual adjacente) | `agent-detail-view.tsx:445-452` |
| 7 | **P1** | A11y | Chat do embed e do wizard sem região `aria-live` → leitor de tela não anuncia respostas do bot | `embed/sparkbot/page.tsx:464-466`; `agent-wizard.tsx:437-440` |
| 8 | **P1** | A11y | `<textarea>` da composer do embed sem `aria-label` (só placeholder) | `embed/sparkbot/page.tsx:535-549` |
| 9 | **P2** | A11y | 7 `<select>` em detail-view sem `aria-label` (têm eyebrow visual, não associado) | `agent-detail-view.tsx` (targeting/automations/deactivation) |
| 10 | **P2** | Consistência | Preço `$50` hardcoded na UI vs `monthly_price_usd` real (modal de Acesso deixa custom) → drift se preço mudar | `primitives.tsx:70`, `new-agent-flow.tsx:72` |
| 11 | **P2** | Consistência | Var CSS errada `--warn-soft` (correto: `--warning-soft`) → callout de aviso cai no fallback cinza | `agent-detail-view.tsx:573` |
| 12 | **P2** | Dados / Copy | Billing mostra `action_type`/`ai_model` crus (`send_message`, `claude-sonnet-...`) sem humanizar | `lib/hub/data.ts:461-466`, `billing/page.tsx:82` |
| 13 | **P2** | Fluxos | CTA global "Novo agente" na topbar repete em TODA tela (inclusive no próprio wizard de criação e no detalhe) | `components/hub/topbar.tsx:45-47` |
| 14 | **P2** | Consistência | CSS órfão: `.sb__loc`, `.sb__foot*`, `.searchbox`/`kbd` (switcher+busca removidos) | `hub.css:159-161,170-172,179-182` |
| 15 | **P2** | Dados | Access grid esconde locations sem `location_name` (`.not(... is null)`) → escritórios somem silenciosamente | `lib/hub/data.ts:363` |
| 16 | **P2** | A11y | Status "online"/tags (`proativa`,`WhatsApp`) e dot verde dependem de cor; têm `title` mas sem texto p/ SR | `embed/sparkbot/page.tsx:447,1056-1058` |

**Contagem:** P0 = **0** · P1 = **8** · P2 = **8** · Total = **16**.

Nota geral: base sólida e bem-acabada. Tokens consistentes, `:focus-visible` global com ring, modais do hub (`test-chat`, `access-table`) com focus-trap+Esc+restore exemplares, clamp de números no save, escopo multi-tenant defensivo (`loadHubAgentDetail` filtra `location_id`). Os P1 são gaps pontuais (estados ausentes, paridade de a11y no embed, copy×dados do feed), não falhas estruturais. **Zero P0.**

---

## L1.1 — Inventário de telas & estados

### Telas catalogadas

| Rota | Arquivo | Vazio | Loading | Erro |
|------|---------|:---:|:---:|:---:|
| `/hub` (Início) | `hub/page.tsx` | ✅ (agentes + atividade) | ❌ sem `loading.tsx` | ❌ sem `error.tsx` |
| `/hub/agents` | `agents/page.tsx` + `agents-list.tsx` | ✅ "Nenhum agente neste filtro" | ❌ | ❌ |
| `/hub/agents/[agentId]` | `agent-detail-view.tsx` (1038L) | n/a (404 via `notFound()`) | ❌ | ❌ (só `notFound`) |
| `/hub/agents/new` | `new-agent-flow.tsx` | n/a | ❌ | ❌ |
| `/hub/agents/new/[template]` | `agent-wizard.tsx` (673L) | ✅ fluxo guiado | ✅ "montando…"/"transcrevendo…" | ✅ fallback compose + toast |
| `/hub/messages` | `messages-view.tsx` | ✅ ambas abas | ❌ | ✅ toast no resume |
| `/hub/billing` | `billing/page.tsx` | ✅ 3 estados vazios | ❌ | ❌ |
| `/hub/settings` | `settings-form.tsx` | n/a | ✅ "Salvando…" | ✅ toast |
| `/hub/access` | `access-table.tsx` (221L) | ✅ "Nenhum escritório" | ❌ | ✅ toast |
| `/embed/sparkbot` | `embed/sparkbot/page.tsx` (1420L) | ✅ Welcome + sugestões | ✅ typing/transcribing/uploading | ✅ banner `.error` clicável |

**WORKS** — Estados vazios bem cobertos quase em todo lugar (home, agents, messages 2 abas, billing 3 blocos, kb-manager, access). Sessão expirada no embed (`page.tsx:416`) tem fallback claro.

**BREAKS (P1)** — `src/app/hub/**` — **sem `loading.tsx`/`error.tsx`/`not-found.tsx` global** — todas as páginas são `force-dynamic` server components com 1–3 round-trips ao DB (home: 3 paralelos; billing: até 2000 linhas de `usage_records`). Sem `loading.tsx` a navegação trava sem feedback até resolver; sem `error.tsx` um throw em qualquer loader cai na tela de erro padrão do Next (quebra a estética dentro do iframe do Spark Leads). — fix: adicionar `src/app/hub/loading.tsx` (skeleton com `.page`) e `src/app/hub/error.tsx` ("use client" boundary com retry).

**RISK** — `kb-manager.tsx` faz `fetch` client-side com estado `loading` próprio (✅ bom), mas se a 1ª carga falhar (`catch` em `load()` linha 39) fica em "mantém o que tem" = lista vazia silenciosa, indistinguível de "sem documentos". — sugestão: estado de erro separado.

---

## L1.2 — Consistência de design

**WORKS** — `hub.css` é um design system maduro: tokens de cor/spacing/tipografia bem nomeados, dark theme + densidade via `data-*`, tudo `scoped` em `.hub-root` (não vaza pro `/dashboard`). Primitives reutilizáveis (`AMark`, `StatusBadge`, `ChannelChip`, `PriceBadge`, `KPI`). Componentes de form repetidos (`Field`, `fstack`) idênticos entre `settings-form` e `agent-detail-view` (`__head` reserva label+hint → alinhamento consistente em 2 colunas).

**BREAKS (P2)** — `agent-detail-view.tsx:573` — `background: "var(--warn-soft, var(--surface-2))"` — a var é `--warning-soft`, não `--warn-soft`; o nome errado nunca resolve e cai sempre no fallback `--surface-2` (cinza). O aviso "agente não responde nunca" perde a cor de alerta. — fix: `var(--warning-soft)`.

**BREAKS (P2)** — `primitives.tsx:70` + `new-agent-flow.tsx:72` — preço **`$50` hardcoded** em string. O preço real vem de `DEFAULT_AGENT_MODULE_PRICE_USD` (=50 hoje) mas o modal de Acesso (`access-table.tsx:183`) permite preço custom por escritório, e `loadEntitlementsGrid`/`loadBilling` usam `monthly_price_usd`. Hoje coincide; muda o preço de um escritório e a UI de criação/badge mente. — fix: `PriceBadge` receber `price` e exibir `${price}` (não literal).

**RISK (intencional, documentar)** — Brand azul **diverge** entre superfícies: hub usa `--primary: #155EEF`; embed usa `--sb-brand: #1675F2` (= `--accent`). São iframes/contextos diferentes (hub no Spark Leads vs painel SparkBot flutuante), e o header do projeto declara a escolha. Não é bug, mas é inconsistência de marca a confirmar com design — idealmente um token único.

**RISK (P2)** — CSS órfão: `.sb__loc*` (switcher de conta), `.sb__foot*` (rodapé de usuário) e `.searchbox`/`kbd` (busca global) seguem em `hub.css` mas o markup foi removido (`sidebar.tsx`/`topbar.tsx` já não os usam — confirmado por grep). Peso morto + risco de confundir manutenção. — fix: remover regras órfãs.

**WORKS** — Densidade/inline-style: uso de inline-style é pragmático e consistente (valores one-off), com a regra correta documentada de que **grids responsivos viram classe** (`hub-row-2col`, `lrow--agent`, `cfg-grid`) porque inline não aceita `@media`. Boa disciplina.

---

## L1.3 — A11y (WCAG 2.1 AA) & Responsivo

### Pontos fortes (WORKS)
- `:focus-visible` global com `box-shadow: var(--ring)` em todo `.hub-root` (`hub.css:122`).
- `--ink-4` foi **escurecido p/ #6B7488** pra passar 4.5:1 em texto pequeno (comentário explícito `hub.css:25`) — sinal de cuidado real com contraste.
- Switches são `<button role="switch" aria-checked aria-label>` — teclado nativo Tab/Enter/Espaço (`hub.css:236-241`, usados em todo o detail-view).
- Modais do **hub** (`test-chat.tsx:38-54`, `access-table.tsx:22-37`) com `role="dialog"`+`aria-modal`+Esc+**focus-trap**+**focus-restore** — implementação modelo.
- Tabelas largas envoltas em `overflow-x:auto` (billing, access) — não estouram em tela estreita.
- `prefers-reduced-motion` desliga animação de página (`hub.css:449`).

### Falhas (BREAKS)
- **P1** `embed/sparkbot/page.tsx:1212-1273` — `SchedulingSettingsModal` SEM `role="dialog"`/`aria-modal`/Escape/focus-trap/focus-restore (só fecha clicando no overlay). Regressão direta vs os modais do hub. Teclado preso, Esc não fecha, foco vaza pro fundo. — fix: portar o `useEffect` de a11y do `test-chat.tsx`.
- **P1** `components/hub/sidebar.tsx:32` + `hub.css:443-446` — em ≤880px (o iframe estreito do Spark Leads, caso de uso explícito no CSS) os labels somem (`display:none`) e o `<Link>` vira icon-only **sem `title`/`aria-label`** → nav inteira sem nome acessível e sem tooltip. — fix: `title={it.label} aria-label={it.label}` no `<Link>`.
- **P1** `agent-detail-view.tsx:445-452` (`Sld`) — `<input type="range">` sem `aria-label`; o nome ("Criatividade"…) está num `<span>` irmão não associado. 4 sliders de tom afetados. — fix: `aria-label={label}` no input.
- **P1** `embed/sparkbot/page.tsx:464-466` e `agent-wizard.tsx:437-440` — listas de mensagens do chat sem container `aria-live="polite"`/`role="log"` → respostas do bot não são anunciadas por leitor de tela (o wizard só tem `aria-live` no status "montando…", não nas bolhas). — fix: envolver `.messages`/bolhas-bot em `role="log" aria-live="polite"`.
- **P1** `embed/sparkbot/page.tsx:535-549` — `<textarea>` da composer sem `aria-label` (depende de placeholder, que some ao digitar e não é nome confiável). — fix: `aria-label="Mensagem para o SparkBot"`.
- **P2** `agent-detail-view.tsx` (7 `<select>`) — dropdowns de targeting/automations/deactivation sem `aria-label`; há eyebrow "Quando"/"Fazer" visual mas não associado. Borderline (contexto visível) → P2. — fix: `aria-label` por select.
- **P2** `embed/sparkbot/page.tsx:447,1056-1058` — dot "online" e tags `proativa`/`WhatsApp` comunicam por cor; têm `title` (hover) mas sem texto pra SR. — fix: `<span className="sr-only">` ou `aria-label`.

### Responsivo (`@media` em hub.css)
**WORKS** — Quebras pensadas: `hub-row-2col`→1col (768px), `lrow--agent` esconde chips de canal e re-grida (860px), `cfg-layout` rail→stack (760px), `cfg-grid`/`fgrid`→1col (720/560px), `builder-split`→1col (900px), sidebar colapsa (880px). O `.hub-app` trava 100dvh e o scroll vai pro `.content` (comentário `hub.css:146-151` explica o porquê — sticky topbar/savebar funcionarem).
**RISK (a confirmar — visual)** — No detail-view, `cfg-hdr` (header sticky do agente) tem ações `Testar`/`Pausar` + back + nome + chips + price num único `row wrap`; em iframe muito estreito pode quebrar feio (quebra em várias linhas). Confirmar via screenshot do orquestrador. `min-width:0`+`ellipsis` no título ajudam, mas os chips/price podem empurrar. Não classifiquei como BREAK sem ver render.
**RISK** — A composer do embed tem 3 botões fixos de 38px + textarea; em largura ínfima (iframe flutuante pequeno) pode apertar. A confirmar.

---

## L1.4 — Fluxos & copy

**WORKS — naming Spark Leads:** ZERO violação user-facing de "GHL"/"GoHighLevel". Grep confirma que todas as ocorrências de "GHL" em hub/embed estão em (a) comentários técnicos (`types.ts:10-11`), (b) `loader/route.ts` (JS injetado no DOM do GHL — técnico, não label). UI usa "Spark Leads"/"Spark" corretamente ("opera o Spark Leads por você", "não escreve no Spark Leads", "Conectado pela agência (Spark Leads)").

**WORKS — fluxos:** Wizard guiado é forte — nós condicionais (`nodeVisible`), skippable com display honesto ("A IA sugere"/"Definir depois"), áudio com confirmação editável, "Ficha" lateral ao vivo, animação de montagem, "Nasce pausado" deixa expectativa clara. Singleton de venda/recrut redireciona pra config existente em vez de tomar 409 (`new/[template]/page.tsx:20-28`). Footgun de canal avisado ("No ar agora: WhatsApp Web/SMS…", `agent-wizard.tsx:488-491`). Breadcrumb dinâmico + "Voltar" presente em detail/new/wizard.

**BREAKS (P1) — copy × dados (feed de atividade):**
- `lib/hub/data.ts:163-187` (`loadHubActivity`) puxa **todo** `execution_log` da location (só exclui `ai_processing`), sem filtrar por audiência/tipo de agente. Mas a copy em `hub/page.tsx:108-109` e `messages-view.tsx:58` diz "atividade dos **agentes de leads**" / "Nenhuma atividade dos agentes de leads ainda". Como o SparkBot (account_assistant) também grava em `execution_log`, o feed mistura ações do SparkBot sob um rótulo "agentes de leads". — fix: filtrar `execution_log` por `agent_id ∈ (agentes lead-facing)` OU ajustar copy pra "dos seus agentes".
- `lib/hub/data.ts:183-184` — cada item de atividade hardcoda `agent:"Agente"` e `channel:"Spark Leads"`. O `ActRow` (`primitives.tsx:124`) renderiza `{item.agent} · {item.channel}` → **sempre** "Agente · Spark Leads", tornando a sub-linha informativamente vazia (não diz QUAL agente nem o canal real). — fix: resolver nome do agente via `agent_id` no `execution_log` (já existe a coluna no schema).

**BREAKS (P2) — copy crua no billing:** `billing/page.tsx:82` exibe `r.model` (ex: `claude-sonnet-4-6-...`) e `r.action` (`send_message`, `ai_processing`) verbatim de `usage_records` (`data.ts:463-464`). Inconsistente com o resto da UI (que humaniza tudo em PT-BR plain). — fix: map `action_type`→PT-BR e nome amigável do modelo.

**BREAKS (P2) — CTA redundante:** `topbar.tsx:45-47` — "Novo agente" é global no shell → aparece **inclusive** no próprio wizard de criação (`/hub/agents/new/[template]`, onde você JÁ está criando) e no detalhe de um agente. Não quebra, mas é ruído contextual (botão "Novo agente" enquanto monta um agente). — fix: ocultar o CTA quando `pathname` começa com `/hub/agents/new`.

**RISK (P2) — locations sumindo:** `data.ts:363` (`loadEntitlementsGrid`) filtra `.not("location_name", "is", null)`. Escritórios sem nome cadastrado **desaparecem** da grade de Acessos sem aviso — admin não consegue liberar/revogar quem não tem nome. — fix: incluir todos e exibir o `location_id` como fallback (a tabela já mostra o id na 2ª linha).

**RISK — dead-ends menores:**
- Aba "Agendamento" do detail-view (`agent-detail-view.tsx:714`) diz "A escolha de calendário entra em breve aqui." — placeholder honesto, sem clique morto. OK.
- `CatScheduling` (lead) e a pref de calendário do SparkBot (embed gear) são fluxos separados — coerente, mas confirmar que o usuário entende onde fica cada um.

---

## Recomendações priorizadas (ordem de ataque)

1. **(P1)** Adicionar `loading.tsx` + `error.tsx` em `src/app/hub/` (skeleton + boundary) — maior ganho de robustez percebida no iframe.
2. **(P1)** Portar a11y de modal (`role`/`aria-modal`/Esc/focus-trap/restore) pro `SchedulingSettingsModal` do embed.
3. **(P1)** Corrigir feed de atividade: nome real do agente + alinhar copy/escopo "agentes de leads".
4. **(P1)** Sidebar colapsada: `title`+`aria-label` nos `<Link>`.
5. **(P1)** `aria-label` em sliders de tom + textarea do embed; `aria-live` nos chats.
6. **(P2)** `--warning-soft` fix; `$50` dinâmico; humanizar billing; remover CSS órfão; locations sem nome na grade; ocultar CTA no wizard.
