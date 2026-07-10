# Blocked Slots do Spark Leads — agenda completa (Google Calendar) no SparkBot (H48)

> Estudo + plano de implementação · 2026-07-10 · pedido do Pedro ("usar o get blocked slots pra ter contexto dos agendamentos do Google Calendar no resumo e nos horários").
> Base: probe REAL em prod (4 locations, 2026-07-10, `scripts/probe-blocked-slots.ts` — criado no estudo, untracked) + OpenAPI oficial GHL + mapa do código de agenda + crítico adversarial.
> Markers: 🤖 Claude · 👤 Pedro · 🤝 híbrido.

---

## 1. TL;DR — o que o probe provou

1. **`GET /calendars/blocked-slots` existe, funciona HOJE com o token atual** (scope `calendars/events.readonly` já concedido — probe rodou sem mudar nada) **e devolve os eventos do Google Calendar COM TÍTULO REAL** ("reunião Boss", "Cafe Manha com Joice unhas", "Oração") — não "Busy". A dúvida do Pedro sobre título privado: nos 4 locations o título veio completo; evento marcado "Private" no Google **não foi observado** → tratar `title` como possivelmente vazio e cair pra "(ocupado)".
2. **O `/calendars/events` (que o briefing usa hoje) NÃO vê nada disso**: probe achou rep com `events=0` e `blocked=8` — **o resumo matinal diria "agenda livre" pra alguém com 8 compromissos no Google**. Zero interseção observada entre os dois endpoints.
3. **O `free-slots` JÁ desconta os bloqueios Google** ao propor horário (por isso o INTERSECT-heurístico do `list_my_free_slots` tem sinal). ⚠️ Ressalva do crítico: isso vale **só pra calendars com Google conectado + conflict-calendar configurado**; e o caminho de **override** (`ignoreFreeSlotValidation` + `auto_force_slot`, que aprende e força SOZINHO após 5 forças) **pula tudo** — double-booking contra evento do Google segue possível aí.
4. Conclusão: o gap principal é de **VISIBILIDADE** (briefing/list_appointments cegos ao Google), mais um gap real de **conflito no caminho de override**.

## 2. A API (fatos verificados)

### GET `/calendars/blocked-slots`
- Params (iguais ao /events): `locationId` [req], `startTime`/`endTime` [req, **millis** string], e **exatamente um** de `userId` | `calendarId` | `groupId`.
- ⚠️ **Bloco Google é USER-level**: vem **sem `calendarId`** — query por calendarId NÃO acha; **tem que ser por `userId`** (o eixo que o briefing já usa).
- Wrapper de resposta: `{ events: [...] }` (mesmo DTO do /events). Shape real observado:
```json
{ "id": "kRw…_1783947600000_3600", "masterEventId": "kRw…",
  "title": "09:00 Treinamento Revolution", "assignedUserId": "OLx…",
  "startTime": "2026-07-13T09:00:00-04:00", "endTime": "…T10:00:00-04:00",
  "isRecurring": true, "rrule": ["EXDATE:…","RRULE:FREQ=WEEKLY"],
  "createdBy": { "source": "google_calendar" }, "deleted": false }
```
- **`createdBy.source: "google_calendar"`** = discriminador confiável (Google vs block nativo).
- **Recorrência vem EXPANDIDA por instância** na janela (não precisa computar RRULE) — mas infla volume: Marina = 69 instâncias/16d. Dedup por `masterEventId` quando contar "compromissos".
- Sem `contactId`/`appointmentStatus`. Filtrar `deleted===true`. Alguns trazem `notes`/`address` com **invite Zoom inteiro (link+passcode)** — ok pro rep (dono da agenda), **nunca ecoar pra lead** e **não injetar cru no prompt** (custo pós-H44).
- Só busy: evento Google marcado FREE é ignorado pelo sync (docs oficiais).

### Mapa semântico
| Endpoint | Conteúdo | contactId | Google? |
|---|---|---|---|
| `/calendars/events` | appointments do CRM | ✅ | ❌ |
| `/calendars/blocked-slots` | blocks nativos + eventos busy do Google | ❌ | ✅ |
| `/calendars/{id}/free-slots` | slots livres (já descontando Google busy do calendar) | — | (embutido) |

### 🔴 Pendência que TRAVA o design de dedup (contradição C2 do crítico)
O probe só observou blocks **Google**. Ninguém testou um **block NATIVO** (criado via `block_calendar_slot`/`POST block-slots`) contra os dois endpoints. Se block nativo aparecer em AMBOS, o merge duplica; se só em blocked-slots, então (a) o risco de post_meeting perguntar "como foi o Almoço?" é menor que o mapeado, e (b) `list_my_free_slots` **nunca viu blocks nativos como conflito** (gap real). **F0 resolve isso com 1 probe de 15min.**

## 3. Onde encaixa no código (mapa)

| Ponto | Hoje | Com blocked-slots |
|---|---|---|
| **Resumo matinal** `daily-briefing.ts:196-256` | `/events?userId` → cego ao Google (caso real: "agenda livre" com 8 compromissos) | +1 call na MESMA janela/eixo; merge ordenado; rótulo "🔒 09:00–10:00 Treinamento (Google)"; skip-empty: block sozinho NÃO dispara briefing |
| **`list_appointments`** `calendar.ts:158-232` | só appointments; nem o block que o PRÓPRIO bot criou aparece nomeado | itens `kind:'appointment'|'block'`; "sua agenda hoje" completa |
| **Confirm de slot ocupado** `scheduling.ts:29` | "4 PM tá bloqueado. Forçar?" — sem MOTIVO | "4 PM você tem *'Alinhamento com Victoria'* (Google). Forçar?" — muda a decisão do rep |
| **`list_my_free_slots`** `calendar.ts:494-970` | INTERSECT-heurístico (≥50% dos calendars, falso-positivo histórico caso Marcos) | blocked-slots como fonte DETERMINÍSTICA de conflito; INTERSECT vira fallback |
| **Caminho override** (`ignoreFreeSlotValidation`/`auto_force_slot`) | pula validação — double-booking possível | check determinístico barato contra blocked-slots ANTES de forçar (avisa, não bloqueia) |
| **post_meeting polling** `route.ts:672-686` | filtro só por status — block com endTime na janela PODE disparar "como foi a reunião?" | filtra `kind:'block'`/sem contactId de graça |

### Design recomendado: `getCalendarContext()` (função compartilhada, NÃO tool nova)
```
src/lib/account-assistant/calendar-context.ts
getCalendarContext(ghl, {locationId, repUserId, tz, window}) →
  { appointments[], blocks[], window, partial }
```
- Wrapper novo `listBlockedSlots` em `operations.ts` (cópia quase literal de `listCalendarEvents:560-575`).
- Dedup interno: por `id` → depois `(start,end,assignedUserId)` com prioridade appointment>block (cobre two-way sync: appointment GHL sincado PRO Google reaparece como block Google — o "suspect" do INTERSECT; e evento Google que virou appointment no two-way).
- **Reusar `computeWindowInTz`** (exportar do calendar.ts e DELETAR a cópia do daily-briefing — 3 implementações da mesma janela hoje; bug histórico de offset negativo).
- Consumidores na ordem: briefing → list_appointments → post_meeting → free-slots conflicts. Free-slots FICA FORA da função ("o que ocupa o dia" ≠ "o que está livre").
- Fail-soft POR SEÇÃO **com signal** (admin_signals) — briefing parcial > mudo, mas falha silenciosa de wrapper novo é a classe de apagão já vivida (migrations).

## 4. Cuidados (crítico adversarial)
1. **Custo de tokens (pós-H44)**: injetar só `title + hora` (strip notes/address), dedup por `masterEventId`, cap ~10 blocks/briefing com "+N outros". Nunca invite Zoom cru no prompt.
2. **Contrato de vazio**: `list_appointments` devolve `not_found` — dia com SÓ blocks não pode virar "agenda livre" nem quebrar o contrato. Definir: `ok` + lista mista quando houver blocks.
3. **Generalização**: probe = 4 locations/16 dias/títulos visíveis/sem paginação observada. Validar erro-shape (422/403 por location sem scope) no wrapper; F0 amplia o probe.
4. **Timezone**: labels via `formatTimezoneHumanFriendly` (terms.ts:234); confirm weekday↔data validado (lição Manuela).
5. **Rate/latência**: +1 call por rep no briefing é irrelevante; no turno, entrar no fan-out batchado existente (cap 8) — sem N+1 novo.

## 5. Plano de execução (H48)

### F0 — Probes que destravam o design 🤖 (rápido, read-only + 1 write de teste)
1. Block NATIVO: criar via API num calendar de teste → GET /events E /blocked-slots → documenta onde aparece (resolve C2) → deletar.
2. Evento Google "Private" num calendar de teste 👤 (Pedro marca 1 evento privado) → ver se title vem vazio/"Busy".
3. Ampliar probe pra +2 locations e janela 31d (paginação?).

### F1 — Fundação 🤖
`listBlockedSlots` em operations.ts + `getCalendarContext` (dedup, kind, partial, computeWindowInTz exportado/unificado) + testes unit (`scripts/test-calendar-context.ts`) + flag **`BLOCKED_SLOTS_CONTEXT_ENABLED` (default OFF, log-first)**.

### F2 — Resumo matinal 🤖
`loadDailyContext` consome `getCalendarContext` (mata a cópia dayWindowInTz + o fetch inline): seção "🔒 Compromissos (Google/bloqueios)" com title+hora, dedup master, cap 10. Skip-empty preservado. Validar 1 briefing real 🤝.

### F3 — `list_appointments` com blocks 🤖
Itens `kind`-anotados; prompt: 1 linha ensinando a ler o kind ("bloqueio ≠ reunião com cliente"). post_meeting filtra blocks (mesma passada).

### F4 — Motivo do conflito + override protegido 🤖
No confirm de slot ocupado: buscar blocked-slots/events da janela e DIZER o motivo. No caminho `ignoreFreeSlotValidation`/`auto_force_slot`: check determinístico → "⚠️ você tem 'X' nesse horário — força mesmo assim?" (avisa; não vira gate novo).

### F5 — free-slots conflicts determinísticos 🤖 (opcional, ganho de qualidade)
`list_my_free_slots` consome blocks como fonte primária de conflito; INTERSECT-heurístico vira fallback + telemetria comparativa (quantas vezes divergem) antes de aposentar.

### Pra ligar em prod 👤
`BLOCKED_SLOTS_CONTEXT_ENABLED=1` na Vercel após F0-F2 validados com 1 briefing real. Rollback = flag OFF (paths legados intactos).

## 6. Resposta direta às dúvidas do Pedro
- **"Consegue pegar os agendamentos do Google?"** Sim — hoje, com o token atual, título real incluído.
- **"Talvez não venha o nome se for privado"** — provável, mas não observado; F0.2 confirma. Fallback: "(ocupado — evento privado do Google)" + dica de como destravar nas configurações do Google Calendar (visibilidade do evento), como você sugeriu.
- **"Falar no resumo de manhã"** — F2, é o caso mais valioso: já achamos rep com 8 compromissos Google e briefing "livre".
- **"Contexto ao ver horários disponíveis"** — o free-slots já EVITA o conflito (quando o Google tá conectado); o que falta é o bot DIZER o motivo (F4) e proteger o caminho de override (F4).
