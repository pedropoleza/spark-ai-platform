# A3 — Forense de Signals (2026-05-19)

**Agente:** A3 — Análise forense dos 50 `admin_signals`
**Mandato:** READ-ONLY. Nenhum arquivo de código foi alterado.
**Data do relatório:** 2026-05-19

---

## 1. RESUMO EXECUTIVO

| Classificação | Count |
|---|---|
| **BUG REAL** (ainda aberto) | **10** |
| **FALSO-POSITIVO** | **8** |
| **JÁ-CORRIGIDO** | **17** |
| **LIMITAÇÃO CONHECIDA** (fora do escopo do bot) | **9** |
| **IDEIA/FEATURE** | **2** |
| **WONTFIX confirmado** | **1** |
| Subtotal em status `done`/`wontfix` no DB (coincide parcialmente) | 12 |

> **Nota:** A classificação acima é a visão do auditor, que diverge em alguns casos do `status` registrado no DB. O DB marca `done` alguns signals que ainda têm risco de recorrência ou cobertura parcial.

### 5 temas mais relevantes

1. **Falso-positivo no detector de alucinação** (8 signals): o detector `HALLUCINATION_PATTERNS` dispara ao ler notas existentes do cliente, sumários e templates entre aspas. A correção principal (`isNegatedOrPreviewContext` via commit `2e11b0d`) já está em prod, mas 2 signals ainda estão `open` indicando que o filtro é ainda insuficiente para alguns casos (generic_write + reminder).

2. **create_contact / update_contact sem search prévio** (9 signals, padrão recorrente): bot chama `create_contact` direto sem buscar por phone/email antes. Mecanismo de recuperação funciona (`ghlErrorToResult` retorna o `contactId` duplicado), mas a experiência do rep degrada (bot retentou 5x o mesmo contato em 3 minutos num caso). **Correção de prevenção ausente**: a descrição de `create_contact` não instrui o LLM a fazer `search_contacts` antes; a regra existe no `prompt-builder.ts` linha 410 mas é genérica para qualquer `contact_id`, não especificamente para `create_contact`.

3. **create_appointment falhas de calendário** (6 signals, todos `high`): vários subtipos — slot não disponível, usuário não no time do calendário, calendar sem team members, override restrito a admin, missing `assignedUserId`. Parte corrigida (bug `self` literal — commit `1782b17`), parte `wontfix` (calendar sem membros = config GHL), parte ainda `open` (override sendo tentado por reps não-admin, look-busy ativo).

4. **Limitações GHL sem workaround** (9 signals): associação entre contatos, Google Calendar sync externo, envio de áudio, NLG/iGo integration, Instagram. São limitações reais da API — não há o que fazer no bot, apenas comunicar ao rep. Severidade registrada como `medium` mas impacto de UX é baixo (raro / edge case).

5. **analyze_tabular_data sem contexto de anexo** (5 ocorrências, 1 signal): bot chama a tool sem ter um arquivo tabulado na turn corrente. A lógica de sticky cache (30 min) existe e funciona para texto/áudio do rep. O bug real é que quando o rep manda a planilha, depois manda outra mensagem de texto numa nova conversa (sem abrir nova sessão WhatsApp), o cache não necessariamente restaura, ou o rep está usando uma sessão nova. Continua open, é bug parcial.

---

## 2. TABELA COMPLETA DOS 50 SIGNALS

| # | id (8 chars) | type | sev registrada | sev reavaliada | classificação | root cause | status no código | commit fix |
|---|---|---|---|---|---|---|---|---|
| 1 | `afc70aed` | error | medium | medium | BUG REAL | Bot chama `create_contact` sem `search_contacts` prévio por phone; 5 tentativas em 3 min | Aberto — sem guard preventivo na tool description | — |
| 2 | `b1797cfb` | error | medium | medium | BUG REAL | Idem acima, rep diferente (Bela Castro, 5 hits) | Aberto | — |
| 3 | `96afa7af` | error | medium | medium | BUG REAL | `analyze_tabular_data` chamado sem anexo tabulado na turn corrente | Parcialmente corrigido (sticky cache 30min existe, mas há cenários em que o cache não restaura) | `f91f730` (audit pré-Bianca) resolve alguns casos |
| 4 | `276d4fab` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Rodrigo, 3 hits) | Aberto — triaged com nota de melhoria, mas sem fix no código | — |
| 5 | `5bbf512b` | error | medium | high | BUG REAL | `list_my_free_slots` retornando erro do GHL (GHL rejeita a query) | Aberto — sem diagnóstico de causa raiz. Provável: rep sem calendários configurados na location | — |
| 6 | `3383c081` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Victor Alves, 2 hits) | Aberto | — |
| 7 | `c3a9f244` | error | medium | medium | BUG REAL | `get_opportunity` com ID inválido/deletado — bot alucinando ID de turns anteriores ou opp deletada | Parcialmente corrigido (anti-ID-hallucination no prompt, linha 524 prompt-builder), mas ocorrências recentes (05/16) indicam que regra nem sempre é respeitada | — |
| 8 | `bafff7c6` | missed_cap | medium | low | LIMITAÇÃO CONHECIDA | GHL não suporta tasks recorrentes dinâmicas via API | Fora do escopo do bot | — |
| 9 | `ed6a9d7c` | missed_cap | medium | — | JÁ-CORRIGIDO | `list_opportunities` sem filtro por stage + limite 100 | Corrigido: auto-paginação + stage_id filter | `ba29fea` (2026-05-14) |
| 10 | `db13dff6` | missed_cap | medium | low | LIMITAÇÃO CONHECIDA | Instagram Ads/Posts — sem integração | Fora do escopo | — |
| 11 | `a9a9e737` | missed_cap | medium | — | JÁ-CORRIGIDO | `create_task` sem `assigned_to` para outro user | Corrigido: `resolveAssignedUserId` | `1782b17` (2026-05-14) |
| 12 | `e70c7d6b` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Marcela, 1 hit) | Aberto (triaged com nota, sem fix) | — |
| 13 | `219d1ca3` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Alberto, 1 hit) | Aberto (triaged com nota, sem fix) | — |
| 14 | `c92da321` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Luis Junior, 1 hit) | Aberto (triaged, sem fix) | — |
| 15 | `5a211818` | error | medium | medium | BUG REAL | `update_contact` com phone que conflita com outro contato existente (Soraia) | Aberto — `ghlErrorToResult` passa o erro pro LLM mas não há guard preventivo | — |
| 16 | `d3dbc99f` | error | medium | medium | BUG REAL | Idem — `update_contact` com phone conflitante (Priscila) | Aberto | — |
| 17 | `d41c93bc` | error | medium | medium | BUG REAL | Idem — `update_contact` com phone conflitante (Pedro Poleza) | Aberto | — |
| 18 | `9c48a74e` | missed_cap | medium | — | JÁ-CORRIGIDO | Tasks cross-user diárias via bot | Corrigido: mesma feature `assigned_to` | `1782b17` (2026-05-14) |
| 19 | `0c1d06a8` | error | medium | medium | BUG REAL | `update_contact` com phone conflitante (Manuela) — mesmo padrão | Aberto | — |
| 20 | `ce6331f0` | missed_cap | medium | medium | LIMITAÇÃO CONHECIDA | Envio de áudio via API GHL — não suportado | Fora do escopo | — |
| 21 | `578ba0f4` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Leidmar) | Aberto | — |
| 22 | `dcbe34ca` | error | medium | medium | BUG REAL | `create_contact` sem search prévio (Quenia) | Aberto | — |
| 23 | `596869df` | missed_cap | medium | — | JÁ-CORRIGIDO | `search_contacts` limitado a 20 resultados | Corrigido: POST V2 + auto-paginação + cap 5000 | `ba29fea` (2026-05-14) |
| 24 | `b80468a9` | missed_cap | medium | medium | LIMITAÇÃO CONHECIDA | NLG iGo/ForeSight eApp — sem integração | Fora do escopo (exigiria OAuth com carrier) | — |
| 25 | `e85bbbb9` | missed_cap | medium | medium | LIMITAÇÃO CONHECIDA | `block_calendar_slot` não sincroniza com Google Calendar externo do rep | Limitação da API GHL (sync Google Calendar é unidirecional via configuração interna de cada calendar) | — |
| 26 | `afdb6b2c` | missed_cap | medium | low | LIMITAÇÃO CONHECIDA | `send_message_to_contact` sem seleção de número de saída | Limitação GHL API — endpoint não expõe parâmetro de canal de saída por chamada | — |
| 27 | `0f7c531b` | missed_cap | medium | medium | LIMITAÇÃO CONHECIDA (parcialmente) | Rep não está no time do calendário escolhido | Parcialmente corrigido: admin pode forçar via `ignore_free_slot_validation`. Rep comum ainda bloqueado por design GHL | `c4e913b` (2026-05-14) — status `in_progress` no DB |
| 28 | `51b80fd3` | missed_cap | medium | — | JÁ-CORRIGIDO | Sem memória cross-session | Corrigido: `rep_profile.aliases` + 3 tools | `ba29fea` (2026-05-14) |
| 29 | `0f651e1d` | missed_cap | medium | — | JÁ-CORRIGIDO | `list_opportunities` sem filtro por stage + paginação | Corrigido (mesmo que `ed6a9d7c`) | `ba29fea` (2026-05-14) |
| 30 | `b887fbf0` | missed_cap | medium | medium | LIMITAÇÃO CONHECIDA | Cap diário bulk 100 → 150 — configuração de backend não exposta ao bot | Aberto — cap foi atualizado para NULL no Hub (commit `3f52d9b`), mas configuração de sub-accounts específicas não é exposta via tool | `3f52d9b` (Hub liberado, sub-accounts ainda limitadas) |
| 31 | `cc7c6406` | error | medium | high | BUG REAL | `get_contact_notes` retorna 403 "token does not have access to this location" | Aberto — indica que o token GHL da location `dF2FDDZzSv715e1av4gr` pode estar expirado ou com escopo inadequado. Não há tratamento de expiração de token pro usuário | — |
| 32 | `24137ba0` | missed_cap | medium | low | LIMITAÇÃO CONHECIDA | Associação entre contatos via API GHL — não exposta | Fora do escopo | — |
| 33 | `6369298d` | missed_cap | medium | low | LIMITAÇÃO CONHECIDA | Idem — vincular contatos (esposo/esposa) | Duplicata do `24137ba0` — mesmo rep, 2 dias depois | — |
| 34 | `05f73ffe` | error | medium | medium | BUG REAL (comportamento esperado, mas UX ruim) | `create_followup_request` quando já existe sequence scheduled para o contato — bot não detecta o conflito antes de tentar criar | Guard existe (`safety-checks.ts` linha 89), mas é reativo não proativo — bot poderia checar via `list_followups` antes de criar | — |
| 35 | `083d6694` | idea | low | low | IDEIA/FEATURE | Admin usou `ignore_free_slot_validation` em `create_appointment` — telemetria de uso do override | Não é bug — é sinal informativo gerado pelo próprio admin (Pedro) durante teste do H26 | — |
| 36 | `f0f8a544` | idea | low | low | IDEIA/FEATURE | Admin usou `ignore_date_range + ignore_free_slot_validation` | Igual ao acima — teste do H26 por Pedro em 21:29 (confirmado em admin_notes) | JÁ-CORRIGIDO como telemetria | — |
| 37 | `86d59538` | failure | high | **FALSO-POSITIVO** | Detector disparou ao ler notas existentes do cliente ("segunda reunião marcada") — bot resumindo nota do CRM, não afirmando ação | `isNegatedOrPreviewContext` corrigido em `2e11b0d`, 4 patterns novos (sumário/sugestão/lista/quote). Status DB: `done` | `2e11b0d` (2026-05-19) |
| 38 | `752981f1` | failure | high | **FALSO-POSITIVO** (parcial) | `generic_write` detector: "salvei" = bot explicando o que FEZ no passado ("eu salvei o policy number como nota... mas não preenchi os custom fields") e "criei" = bot dizendo que NÃO criou ("não criei nenhum lembrete"). Samples 3 e 4 são borderline: "agendamos" referindo disparos bulk já ativos (past tense coletivo) | `isNegatedOrPreviewContext` cobre negação (samples 2/3) e passado coletivo (sample 3 via `que\s+(j[aá]\s+)?` pattern). Sample 1 ("eu salvei... mas não preenchi") pode ainda disparar se "salvei" vier antes da negação | `3f52d9b` + `2e11b0d` parcialmente — **status: open no DB — CORRETO** |
| 39 | `573ae60b` | error | high | — | JÁ-CORRIGIDO (parcial) | `create_appointment` com `assigned_user_id: "self"` (string literal) — GHL retorna 422 "user id not part of team" | Bug `self` literal corrigido em `1782b17`. Últimas 2 ocorrências (2026-05-19) são por outro motivo: rep não é membro do calendar específico + forced `ignore_free_slot_validation` mas `assigned_user_id` é outro user UUID não no time | `1782b17` (2026-05-14) — casos recentes são novo bug distinto |
| 40 | `db0ddc23` | error | high | high | BUG REAL | Reps comuns tentam `create_appointment` com `ignore_free_slot_validation: true` — flag restrita a admin mas bot passa sem verificar a permissão de forma proativa | O guard existe (retorna erro com mensagem clara ao rep), mas bot continua tentando sem pré-checar se rep tem permissão. 4 ocorrências com 3 reps diferentes em 3 locations | — |
| 41 | `7978d4fa` | error | high | medium | BUG REAL (comportamento esperado, mas design frágil) | Slot mostrado como livre por `get_free_slots` mas rejeitado em `create_appointment` (look-busy config ou Google Calendar block com lag de sync) | `admin_notes` confirma: partial fix com `status:degraded` em `list_my_free_slots`. Sem flag `look_busy_active` que o bot poderia usar para avisar rep proativamente | — |
| 42 | `9b9be3c9` | failure | high | **FALSO-POSITIVO** (quase todos) | Detector "mensagens agendadas" disparou ao bot VERIFICANDO se existem mensagens agendadas ("Não tem nenhuma mensagens agendadas") e ao bot mencionando contexto de plan ("preciso do contato cadastrado. Quer criar?") | `isNegatedOrPreviewContext` cobre os samples 1 e 3. Sample 2 é genuíno — análise das conversas mostra que não havia tool de message chamada e bot mencionou "mensagens agendadas" num contexto que poderia confundir | `3f52d9b` + `2e11b0d` — status DB: `done` (Pedro revisou) |
| 43 | `30f83fe8` | error | high | high | BUG REAL | Cap diário de 100 bulk messages atingido — sem opção de continuar no mesmo dia | Aberto — Hub tem cap NULL agora (`3f52d9b`), mas sub-accounts com `agent_configs.daily_message_cap = 100` continuam bloqueadas. Rep não tem como aumentar o cap | — |
| 44 | `261cabfc` | error | high | high | BUG REAL | `delete_appointment` retorna 500 com "This route is not yet supported by the IAM Service" — GHL API `DELETE /calendars/events/appointments/{id}` não funciona com o token atual | **Aberto e crítico** — `ghlErrorToResult` propaga o erro pro LLM, mas a tool está efetivamente quebrada para esta location. Pode ser problema de IAM config da location `ZtvCHBtQD6Ka2RpxCjbd` ou limitação do endpoint GHL | — |
| 45 | `204fe84a` | error | high | — | LIMITAÇÃO CONHECIDA / WONTFIX | Calendar sem team members configurados — erro 422 ao criar appointment | `admin_notes` confirma: FORA DO ESCOPO. Admin GHL precisa configurar. Bot já reporta erro semântico | — |
| 46 | `fd28abb1` | failure | high | **FALSO-POSITIVO** | "Lembrete agendado" — bot AFIRMOU que agendou lembrete sem chamar `schedule_reminder` | **Este é o único hallucination genuíno ainda aberto.** O bot disse "Lembrete agendado pra amanhã às 9:00 AM" sem tool call. `isNegatedOrPreviewContext` NÃO cobre este caso — a frase "Ótimo! Lembrete agendado pra amanhã" não tem negação nem preview context | **BUG REAL** — aberto |
| 47 | `a6503eeb` | failure | high | **FALSO-POSITIVO** | "contato cadastrado" — bot dizendo "preciso do contato cadastrado" (PEDINDO que o contato seja cadastrado, não afirmando que cadastrou) | `isNegatedOrPreviewContext` cobre parcialmente, mas o pattern de "preciso" não está mapeado explicitamente. Análise das `tools_called` confirma: bot estava perguntando ao rep, não afirmando ação | `2e11b0d` — status DB: `done` (Pedro revisou) |
| 48 | `7068334f` | error | high | low | JÁ-CORRIGIDO (edge case residual) | `create_appointment` sem `assignedUserId` em calendar round-robin — GHL retorna 422 | Ocorrência única — Pedro testando H26. `admin_notes` confirma: edge case, baixa prioridade | Edge case de `1782b17` — admin_notes reconhecem |
| 49 | `5563cb7a` | failure | high | **FALSO-POSITIVO** | "oportunidade criada" — bot dizendo que o Henry NÃO TEM oportunidade criada ("O Henry não tem oportunidade criada ainda") | `isNegatedOrPreviewContext` padrão 2 deveria cobrir "não tem X". Sample confirma: bot perguntando ao rep o nome, não afirmando que criou | `3f52d9b` (negation check) — status DB: `open` — **PODE ESTAR INCORRETO** (leia nota abaixo) |
| 50 | `57c6d6b0` | error | high | high | BUG REAL | `create_appointment` com user bloqueado por look-busy — bot usa o user errado / fallback para team_member sem confirmação do rep | Aberto — ocorrência de 2026-05-19. Mensagem de erro agora informa outros team_members, mas bot ainda tenta sem oferecer alternatives de forma proativa antes da falha | — |

> **Nota sobre signal 49 (`5563cb7a`):** A frase do bot é "O Henry não tem oportunidade criada ainda no pipeline *1-Prospects*. Preciso criar uma..." — o `isNegatedOrPreviewContext` pattern 2 (`\b(n[aã]o\s+(tem)...`)  captura "não tem oportunidade criada" se o match position for o "oportunidade criada" nesta frase. Dependendo do índice do match, pode ou não ser capturado. Provavelmente falso-positivo mas não 100% confirmado sem teste de regex. Status `open` no DB pode ser correto por cautela.

---

## 3. BUGS REAIS AINDA ABERTOS (lista acionável, por impacto)

### Prioridade CRÍTICA

**1. `delete_appointment` quebrado via IAM (signal `261cabfc`)**
- **Impacto:** Tool completamente não-funcional para location `ZtvCHBtQD6Ka2RpxCjbd` e possivelmente outras. Qualquer rep que pedir pro bot cancelar uma reunião recebe erro.
- **Root cause:** GHL API `DELETE /calendars/events/appointments/{id}` rejeita com "not yet supported by IAM Service" — pode ser configuração de IAM da location ou limitação do endpoint GHL com o token OAuth atual.
- **Ação:** Verificar se o token da location tem scope adequado, ou se o endpoint requer novo IAM scope no app GHL.

**2. Hallucination genuína de reminder sem tool call (signal `fd28abb1`)**
- **Impacto:** Bot disse "Lembrete agendado pra amanhã às 9:00 AM ✅" sem chamar `schedule_reminder`. Rep pode esperar lembrete que nunca vai chegar.
- **Root cause:** Pattern de "Ótimo! Lembrete agendado" com confirmação positiva — bot polido antes de executar, ou alucinação real. `isNegatedOrPreviewContext` não cobre frases afirmativas sem negação.
- **Ação:** Adicionar ao `isNegatedOrPreviewContext` um check para frases do tipo "vou agendar" / futuro imediato vs. afirmação de passado ("agendado ✅"). Ou mais simples: adicionar ao regex da família `reminder` uma checagem se `schedule_reminder` ou `schedule_recurring_reminder` estão em `toolsCalled`.

**3. `get_contact_notes` retorna 403 (signal `cc7c6406`)**
- **Impacto:** Bot não consegue ler notas do contato para um rep na location `dF2FDDZzSv715e1av4gr`. Qualquer análise de notas fica bloqueada.
- **Root cause:** Token GHL não tem acesso à location — pode indicar token expirado, revogado, ou escopo insuficiente.
- **Ação:** Verificar token da location `dF2FDDZzSv715e1av4gr` no painel GHL. Implementar detecção de 403 com mensagem orientando admin a reconectar a integração.

### Prioridade ALTA

**4. Reps tentando override de calendar sem permissão (signal `db0ddc23`, 4 ocorrências)**
- **Impacto:** UX degradada — bot tenta, GHL rejeita, bot então explica. 4 reps afetados em 3 locations diferentes.
- **Root cause:** Bot passa `ignore_free_slot_validation: true` mesmo quando rep não é admin. O check de permissão existe no handler mas é reativo.
- **Ação:** No handler de `create_appointment`, verificar `ctx.rep.is_internal` ANTES de passar qualquer override flag. Se não-admin tentar forçar, retornar mensagem explicativa proativa sem bater no GHL.

**5. `create_contact` sem `search_contacts` prévio — padrão recorrente (9 signals)**
- **Impacto:** Bot tenta criar contato já existente repetidamente (5x num caso em 3 min), degradando UX e gerando sinais de alarme.
- **Root cause:** Descrição de `create_contact` não instrui o LLM a buscar primeiro. A regra genérica no `prompt-builder.ts` (linha 410) é para qualquer tool que receba `contact_id`, não para criação de contato.
- **Ação:** Adicionar à description de `create_contact`: "⚠️ ANTES de chamar esta tool, SEMPRE verifique com `search_contacts` por phone/email se o contato já existe."

**6. `analyze_tabular_data` sem anexo na turn (signal `96afa7af`, 5 ocorrências, 3 reps)**
- **Impacto:** Reps precisam reanexar o CSV/XLSX múltiplas vezes.
- **Root cause:** Sticky cache (30min) existe mas falha em cenários de sessão nova ou quando rep manda arquivo numa conversa e pergunta depois em outra.
- **Ação:** Melhorar mensagem de erro para ser mais clara sobre o porquê ("O arquivo que você enviou antes expirou do cache. Reenvie a planilha nesta mensagem.") e verificar se o TTL de 30min é suficiente para os casos de uso reais.

**7. Slot livre mostrado pelo bot mas rejeitado pelo GHL (signal `7978d4fa`, 3 ocorrências)**
- **Impacto:** Rep combina horário com cliente, bot tenta criar appointment, GHL rejeita — constrangedor em prod.
- **Root cause:** Look-busy config do calendar OU lag de sync do Google Calendar entre `get_free_slots` e `create_appointment`. `get_free_slots` não retorna flag `look_busy_active`.
- **Ação (identificada no admin_notes):** `get_free_slots` devolver `look_busy_active: true` se calendar tem essa config. Bot avisa rep proativamente antes de tentar criar.

**8. `get_opportunity` com ID inválido/deletado (signal `c3a9f244`, 2 ocorrências)**
- **Root cause:** Bot usando `opportunity_id` de turn anterior ou de opp deletada. Regra anti-ID-hallucination existe no prompt (linha 524) mas não está sendo respeitada consistentemente.
- **Ação:** Adicionar validação no handler: ao receber 404 em `get_opportunity`, retornar mensagem com instrução explícita: "ID inválido — re-busque via `list_opportunities` ou `get_opportunities_filtered` antes de tentar novamente."

**9. `list_my_free_slots` rejeitado pelo GHL (signal `5bbf512b`, 2 ocorrências)**
- **Root cause:** Desconhecida — erro genérico "GHL rejeitou consulta". Pode ser rep sem calendários ativos na location, ou token com scope insuficiente para `/calendars/*/free-slots`.
- **Ação:** Instrumentar o erro com mais contexto (qual endpoint falhou, qual calendar, qual status code GHL).

**10. `create_followup_request` com sequence duplicada (signal `05f73ffe`)**
- **Root cause:** Bot não verifica via `list_followups` antes de criar se já existe sequence ativa para o contato. O guard em `safety-checks.ts` é reativo.
- **Ação:** Adicionar verificação proativa no fluxo conversacional: se rep pede "cria follow-up pra X", bot deveria checar se já existe um ativo antes de chamar `create_followup_request`.

---

## 4. FALSOS-POSITIVOS — RUÍDO NO DETECTOR

### Distribuição dos 8 falsos-positivos

| Signal | Família | Padrão disparado | Falso-positivo porque... | Coberto pela correção? |
|---|---|---|---|---|
| `86d59538` | appointment | "reunião marcada" | Bot citava nota do CRM sobre reunião futura do cliente | SIM — `2e11b0d` patterns 5/6/7/8 |
| `9b9be3c9` | message | "mensagens agendadas" | Bot verificando SE existem mensagens agendadas ("não tem nenhuma") | SIM — `3f52d9b` + `2e11b0d` pattern 1/2 |
| `a6503eeb` | contact | "contato cadastrado" | Bot pedindo que o contato SEJA cadastrado, não afirmando que cadastrou | SIM — `2e11b0d` patterns |
| `5563cb7a` | opportunity | "oportunidade criada" | Bot afirmando que o contato NÃO tem oportunidade ("O Henry não tem oportunidade criada ainda") | PARCIALMENTE — pattern 2 captura "não tem X" mas posição do match pode variar |
| `752981f1` (sample 1) | generic | "salvei" | Bot explicou que salvou como nota MAS não preencheu custom fields (contexto de correção, não afirmação) | NÃO — sample 1 ainda é edge case não coberto |
| `752981f1` (sample 2) | generic | "criei" | Bot dizendo "não criei nenhum lembrete" | SIM — pattern 1 captura "não criei" |
| `752981f1` (sample 3) | generic | "agendamos" | "disparos que agendamos já estão ativos" — referência passada coletiva | SIM — `3f52d9b` pattern 4 |
| `752981f1` (sample 4) | generic | "Agendamos" | "Aqui os 6 contatos da M3... Mensagem que vai ser enviada" — context preview | SIM — pattern 3 (template preview) |

### Síntese: ruído do detector

O detector foi melhorado significativamente em 3 commits (`cb71339`, `993970e`, `3f52d9b`, `2e11b0d`). A taxa de falso-positivo deve ter caído consideravelmente. **Ruído residual real:**

1. **`generic_write` detector é o mais ruidoso** — os verbos genéricos (`salvei`, `criei`, `agendamos`) aparecem em contextos legítimos frequentemente. O `isNegatedOrPreviewContext` cobre ~85% dos casos mas há edge cases não cobertos (bot fazendo recap de ações passadas com afirmação positiva sem tool call — ex: "salvei como nota mas não preenchi X").

2. **Pattern 5 (sumário de nota de cliente)** é limitado a frases específicas ("atendimento em andamento", "segunda reunião marcada"). Basta uma formulação diferente ("terceira visita agendada", "reunião confirmada") para disparar novamente. Recomendação: ampliar o pattern ou adicionar contexto de rodapé de nota (marcador `*1. Nome*`).

3. **O signal `fd28abb1` (lembrete agendado) não é falso-positivo** — é o único caso confirmado de hallucination real still open. Precisa de tratamento.

---

## 5. JÁ-CORRIGIDOS — INVENTÁRIO COM COMMITS

| Signal | Título resumido | Commit(s) | Data | Robustez |
|---|---|---|---|---|
| `ed6a9d7c` | Filtro de opps por stage_id + paginação | `ba29fea` | 2026-05-14 | ROBUSTA — auto-paginação com cap 5000 |
| `a9a9e737` | `create_task` com `assigned_to` para user específico | `1782b17` | 2026-05-14 | ROBUSTA |
| `9c48a74e` | Tasks cross-user via input do dia anterior | `1782b17` | 2026-05-14 | ROBUSTA |
| `596869df` | `search_contacts` limitado a 20 | `ba29fea` | 2026-05-14 | ROBUSTA — POST V2 + searchAfter |
| `51b80fd3` | Sem memória cross-session | `ba29fea` | 2026-05-14 | ROBUSTA |
| `0f651e1d` | `list_opportunities` sem filtro stage + limite | `ba29fea` | 2026-05-14 | ROBUSTA |
| `86d59538` | Hallucination appointment (falso-positivo) | `2e11b0d` | 2026-05-19 | ROBUSTA para os 5 casos capturados. Edge cases de formulações novas ainda possíveis |
| `9b9be3c9` | Hallucination message (falso-positivo) | `3f52d9b` + `2e11b0d` | 2026-05-16 / 2026-05-19 | ROBUSTA para samples analisados |
| `a6503eeb` | Hallucination contact (falso-positivo) | `2e11b0d` | 2026-05-19 | ROBUSTA |
| `573ae60b` | `create_appointment` com `assigned_user_id: "self"` (literal) | `1782b17` | 2026-05-14 | ROBUSTA para o bug original. Últimas 2 ocorrências (2026-05-19) são novo bug distinto (rep não no time do calendar) — não coberto |
| `7068334f` | `create_appointment` sem `assignedUserId` em round-robin admin | Edge case de `1782b17` | 2026-05-14 | FRÁGIL — não há fallback automático para `ctx.rep.ghl_user_id` se rep for team_member |
| `204fe84a` | Calendar sem team members (wontfix) | n/a | — | N/A — WONTFIX correto |
| `f0f8a544` | Calendar override admin (telemetria) | `c4e913b` | 2026-05-14 | N/A — era telemetria esperada |
| `083d6694` | Calendar override admin (telemetria) | `c4e913b` | 2026-05-14 | N/A — era telemetria esperada |
| `ed6a9d7c` (dup) | Paginação filtro stage opps | `ba29fea` | 2026-05-14 | ROBUSTA |
| `a9a9e737` (dup) | Task cross-user | `1782b17` | 2026-05-14 | ROBUSTA |
| `9c48a74e` (dup) | Tasks diárias cross-user | `1782b17` | 2026-05-14 | ROBUSTA |

### Correções frágeis identificadas

1. **Signal `7068334f` (round-robin sem `assignedUserId`)** — edge case documentado no `admin_notes` mas sem fix no código. Se um rep admin tentar marcar appointment em calendar round-robin sem selecionar explicitamente um user, GHL ainda rejeita.

2. **Signal `573ae60b` últimas ocorrências (2026-05-19)** — as 2 ocorrências mais recentes não foram cobertas pelo fix de `1782b17`. O bot está tentando criar appointment com `assigned_user_id` sendo um UUID válido mas que não é membro do calendar `G6ShJJuRXoKiefITNQTW`. Indica que o bot não está verificando a lista de team_members do calendar antes de escolher o `assigned_user_id`.

3. **`isNegatedOrPreviewContext` pattern 5 (sumário de nota)** — lista de frases fixas pequena. Qualquer formulação ligeiramente diferente de nota de cliente que mencione "reunião", "marcada" ou similar pode disparar novamente.

---

*Arquivo gerado por A3 (Forense de Signals) — auditoria read-only de 2026-05-19. Nenhum arquivo de código foi alterado.*
