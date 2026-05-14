# Calendar Override — Plano de Implementação

> **Data:** 2026-05-14
> **Decision code:** H26 (a registrar em `docs/DECISIONS.md` no merge)
> **Origem:** conversa Pedro 2026-05-14 (cliente perguntou se SparkBot fura horário bloqueado + bug silencioso de meeting location ignorada)
> **Escopo:** 4 override flags do endpoint `POST/PUT /calendars/events/appointments`.
> **Status:** APROVADO 2026-05-14 — implementar agora.

---

## 0. TL;DR

Hoje `create_appointment` e `update_appointment` SEMPRE respeitam blocks e configs do calendar — não há caminho pra forçar agendamento em slot bloqueado, fora de min notice, ou trocar meeting location (link/endereço da reunião). Pior: hoje o create já aceita os params `meeting_location_type` + `meeting_location` mas **NÃO** envia `overrideLocationConfig` — GHL descarta silenciosamente.

**Solução:** expor 4 override flags com gates diferentes:

| Flag | Gate | Trigger |
|---|---|---|
| `ignoreFreeSlotValidation` | **Admin-only** (H17 `is_internal`) + confirm + prompt explícito | rep pede explicitamente ("força", "mesmo bloqueado") |
| `ignoreDateRange` | **Admin-only** + confirm + prompt explícito | rep pede explicitamente ("marca pra agora" quando date range rejeita) |
| `toNotify=false` | **Admin-only** + confirm + prompt explícito | rep pede explicitamente ("sem mandar aviso") |
| `overrideLocationConfig` | **Qualquer rep**, **implícito** | rep especifica meeting_location_type ou meeting_location |

**Audit:** registra signal `idea` em `/admin/signals` por uso das 3 flags admin (fingerprint estável → dedupa, vira counter).

**Sem mudança de DB.** Sem migration.

**Effort:** 3.5-4h (helper + 2 tools + meeting location + prompt + smoke test).

---

## 1. Estado atual

### 1.1 `create_appointment` (`tools/calendar.ts`, função `createAppointment`)

Schema já aceita `meeting_location_type` e `meeting_location` mas handler NÃO envia `overrideLocationConfig: true` → GHL ignora. Body montado sem nenhuma das 4 flags. Erro de slot bloqueado capturado com fallback "outros team_members" (esse fallback **continua útil** mesmo com override — rep pode preferir trocar de user).

### 1.2 `update_appointment` (`tools/calendar.ts`, função `updateAppointment`)

Schema atual: `appointment_id`, `start_time`, `end_time`, `appointment_status`. **Não tem** params de meeting location, **não tem** override. Body é puro reagendamento. Sem fallback smart de team_members (caso à parte — não cobrir aqui).

### 1.3 `block_calendar_slot` (`tools/calendar.ts`, função `blockCalendarSlot`)

Usa endpoint **diferente** `/calendars/events/block-slots` que **não aceita** nenhuma das override flags (ver `_planning/ghl-api-reference.md:444-453`). **Fora do escopo.**

### 1.4 Admin detection (H17)

`ctx.rep.is_internal: boolean` populado por `identity.ts → detectIsInternal()` (camadas: env `INTERNAL_TEAM_PHONES` → role `agency`/`agency_owner` → heurística "5+ ghl_users"). **Reuso direto** — sem mudança em identity.ts.

### 1.5 Spec do endpoint GHL (`_planning/ghl-api-reference.md`)

`POST /calendars/events/appointments` e `PUT /calendars/events/appointments/{eventId}` aceitam:

| Flag GHL | Default | Efeito |
|----------|---------|--------|
| `ignoreFreeSlotValidation` | `false` | Pula validação de slot livre — marca em cima de block/conflict |
| `ignoreDateRange` | `false` | Pula `allowBookingAfter` (min notice) e `allowBookingFor` (max horizon) |
| `overrideLocationConfig` | `false` | GHL respeita `meetingLocationType`+`address` do body (senão usa default do calendar) |
| `toNotify` | `true` | Se `false`, não dispara automations/notifications |

---

## 2. Mudanças

### 2.1 Helper compartilhado (top de `calendar.ts`, perto dos imports)

```ts
/**
 * H26 (review 2026-05-14): valida override flags ADMIN-ONLY pra appointments.
 * Restrito a admin/internal team (ctx.rep.is_internal === true).
 *
 * NOTA: NÃO inclui overrideLocationConfig — esse é auto-ativado quando rep
 * passa meeting_location_type/meeting_location (gate diferente, qualquer rep
 * pode).
 *
 * Retorna:
 *   - { ok: false, error } se rep tentou usar override sem ser admin
 *   - { ok: true, body, used } com campos GHL prontos pra mergear no body
 *   - { ok: true, body: {}, used: [] } se nenhuma flag foi passada
 */
function buildOverridePayload(
  ctx: ToolContext,
  args: Record<string, unknown>,
): { ok: true; body: Record<string, unknown>; used: string[] } | { ok: false; error: ToolResult } {
  const requestedOverride =
    args.ignore_free_slot_validation === true ||
    args.ignore_date_range === true ||
    args.to_notify === false;

  if (requestedOverride && !ctx.rep.is_internal) {
    return {
      ok: false,
      error: {
        status: "error",
        message:
          "Override de calendar (forçar slot bloqueado / ignorar min notice / desativar notification) " +
          "é restrito a admin/internal team. Rep comum não tem permissão. " +
          "Avise o rep: 'Não consigo forçar esse bloqueio — só admin tem essa permissão. " +
          "Quer que eu tente outro horário?' e use get_free_slots pra alternativa.",
        retryable: false,
      },
    };
  }

  const body: Record<string, unknown> = {};
  const used: string[] = [];
  if (args.ignore_free_slot_validation === true) {
    body.ignoreFreeSlotValidation = true;
    used.push("ignore_free_slot_validation");
  }
  if (args.ignore_date_range === true) {
    body.ignoreDateRange = true;
    used.push("ignore_date_range");
  }
  if (args.to_notify === false) {
    body.toNotify = false;
    used.push("to_notify_false");
  }
  return { ok: true, body, used };
}
```

### 2.2 `create_appointment` — schema (função `createAppointment`)

Description estendida com bloco override + meeting location. Schema adiciona 3 admin flags (`ignore_*` + `to_notify`). Params `meeting_location_type` + `meeting_location` já existem.

```ts
description:
  "⚠️ AGENDA reunião pra um contato no calendário. AFETA o lead — sempre confirma com o rep ANTES. Use get_free_slots pra escolher horário válido.\n\n" +
  "Observação importante: pra calendars **round-robin/collective/group** (com vários team members), NÃO passe `assigned_user_id` — deixe o Spark Leads escolher automaticamente. Pra calendars **personal/service** (1 user só), opcional. Default: não passar (mais seguro pra qualquer tipo de calendar).\n\n" +
  "⚙️ MEETING LOCATION (qualquer rep): se rep especificar onde/como — 'Zoom', 'Google Meet', 'presencial em [endereço]', 'telefone [num]', 'link [url]' — passe `meeting_location_type` E `meeting_location`. Sem isso, GHL ignora silenciosamente e usa default do calendar (bug histórico pré-H26).\n\n" +
  "⚙️ OVERRIDE ADMIN (apenas internal team): se rep admin pedir pra forçar slot bloqueado " +
  "(`ignore_free_slot_validation`), ignorar minimum notice (`ignore_date_range`), " +
  "ou marcar sem notificação (`to_notify=false`), SEMPRE explicite o override " +
  "na frase de confirmação: 'Vou marcar X mesmo com slot bloqueado — confirma?'. " +
  "NUNCA use silenciosamente. Rep não-admin recebe erro do gate.",
risk: "high",
parameters: {
  type: "object",
  properties: {
    calendar_id: { type: "string" },
    contact_id: { type: "string" },
    start_time: { type: "string", description: "ISO 8601" },
    end_time: { type: "string", description: "ISO 8601" },
    title: { type: "string" },
    meeting_location_type: {
      type: "string",
      description:
        "OPCIONAL. Tipo de local da reunião. Valores: 'zoom' | 'gmeet' | 'phone' | 'address' | 'custom'. " +
        "Passar este param ativa overrideLocationConfig automaticamente (GHL respeita o que você manda).",
    },
    meeting_location: {
      type: "string",
      description:
        "OPCIONAL. Link/endereço/telefone literal (ex: 'https://zoom.us/j/abc', 'Av. Brasil 100', '+5511987654321'). " +
        "Use quando rep especifica link próprio. Pra 'zoom'/'gmeet' SEM link específico, omita — GHL gera automático.",
    },
    assigned_user_id: { ... existente ... },
    // H26 (admin-only):
    ignore_free_slot_validation: {
      type: "boolean",
      description:
        "OPCIONAL (admin only). Força marcação EM CIMA de slot bloqueado/conflict. " +
        "Use APENAS quando rep admin pedir explicitamente ('força', 'mesmo bloqueado', 'ignora bloqueio'). " +
        "Na confirmação verbal, deixe claro que está IGNORANDO um bloqueio.",
    },
    ignore_date_range: {
      type: "boolean",
      description:
        "OPCIONAL (admin only). Pula 'minimum scheduling notice' do calendar " +
        "(ex: calendar exige 2h+ no futuro). Use quando rep admin diz 'marca pra agora' / 'marca pra hoje'.",
    },
    to_notify: {
      type: "boolean",
      description:
        "OPCIONAL (admin only, default true). Passe `false` quando rep admin pedir " +
        "'marca sem mandar notificação' ou 'sem disparar automation'. ⚠️ DRÁSTICO — cliente NÃO recebe lembrete.",
    },
  },
  required: ["calendar_id", "contact_id", "start_time", "end_time"],
},
```

### 2.3 `create_appointment` — handler

```ts
handler: async (ctx, args) => {
  const calendarId = String(args.calendar_id || "");
  const contactId = String(args.contact_id || "");
  const invalid = validateGhlId(calendarId, "calendar") || validateGhlId(contactId, "contact");
  if (invalid) return invalid;
  const startInvalid = validateIso8601(String(args.start_time || ""), "start_time");
  if (startInvalid) return startInvalid;
  const endInvalid = validateIso8601(String(args.end_time || ""), "end_time");
  if (endInvalid) return endInvalid;

  // H26 (review 2026-05-14): gate admin pras 3 flags destrutivas
  const overrideResult = buildOverridePayload(ctx, args);
  if (!overrideResult.ok) return overrideResult.error;

  // H26 (review 2026-05-14): auto-ativa overrideLocationConfig quando rep
  // especifica meeting location — sem isso GHL ignora silenciosamente.
  const hasCustomMeetingLocation =
    args.meeting_location_type !== undefined ||
    args.meeting_location !== undefined;

  try {
    const body: Record<string, unknown> = {
      calendarId,
      contactId,
      locationId: ctx.locationId,
      startTime: new Date(String(args.start_time)).toISOString(),
      endTime: new Date(String(args.end_time)).toISOString(),
      ...(args.title ? { title: String(args.title) } : {}),
      ...(args.meeting_location_type ? { meetingLocationType: String(args.meeting_location_type) } : {}),
      ...(args.meeting_location ? { address: String(args.meeting_location) } : {}),
      ...(hasCustomMeetingLocation ? { overrideLocationConfig: true } : {}),
      ...(args.assigned_user_id ? { assignedUserId: String(args.assigned_user_id) } : {}),
      ...overrideResult.body, // H26 admin flags (spread no fim pra garantir prioridade)
    };

    const res = await ctx.ghlClient.post<{...}>("/calendars/events/appointments", body);
    const apptId = res.id || res.appointment?.id;

    // H26 audit: signal só pras flags admin (não pro meeting location override).
    // Fingerprint ESTÁVEL (sem apptId no title) → recorder dedupa, vira counter.
    if (overrideResult.used.length > 0) {
      recordSignalAsync({
        type: "idea",
        title: `Calendar override admin (${overrideResult.used.sort().join("+")})`,
        description: `Admin usou override flags: ${overrideResult.used.join(", ")}`,
        severity: "low",
        source: "bot_auto",
        metadata: {
          tool: "create_appointment",
          appointment_id: apptId,
          rep_id: ctx.rep.id,
          rep_phone: ctx.rep.phone,
          location_id: ctx.locationId,
          calendar_id: calendarId,
          contact_id: contactId,
          override_flags_used: overrideResult.used,
        },
      });
    }

    return { status: "ok", data: { appointment_id: apptId, assigned_to: res.assignedUserId || null } };
  } catch (err) {
    // ... fallback de slot bloqueado existente (NÃO alterar)
  }
}
```

Imports: `import { recordSignalAsync } from "@/lib/admin-signals/recorder";` (adicionar no top).

### 2.4 `update_appointment` — schema

Schema atual NÃO tem `meeting_location_type`/`meeting_location`. Adicionamos. Mais as 3 flags admin.

```ts
description:
  "⚠️ Reagendar um appointment existente (mudar horário, status, OU meeting location). Confirma antes.\n\n" +
  "⚙️ MEETING LOCATION (qualquer rep): se rep pedir pra TROCAR o local de reunião ('agora vai ser presencial', 'muda pra Google Meet'), passe `meeting_location_type` + `meeting_location`.\n\n" +
  "⚙️ OVERRIDE ADMIN (apenas internal team): se rep admin pedir pra REagendar em cima de bloqueio " +
  "(`ignore_free_slot_validation`) ou pra horário fora do min notice (`ignore_date_range`), " +
  "SEMPRE explicite na confirmação: 'Vou mover pra X mesmo bloqueado — confirma?'. NUNCA silencioso.",
risk: "high",
parameters: {
  type: "object",
  properties: {
    appointment_id: { type: "string" },
    start_time: { type: "string", description: "ISO 8601 novo horário." },
    end_time: { type: "string", description: "ISO 8601 novo fim." },
    appointment_status: {
      type: "string",
      enum: ["confirmed", "showed", "noshow", "cancelled", "invalid"],
      description: "Status do appointment. Use APENAS valores enumerados.",
    },
    // H26b: meeting location override
    meeting_location_type: {
      type: "string",
      description: "OPCIONAL. 'zoom' | 'gmeet' | 'phone' | 'address' | 'custom'. Ativa overrideLocationConfig auto.",
    },
    meeting_location: {
      type: "string",
      description: "OPCIONAL. Link/endereço/telefone literal pro novo meeting location.",
    },
    // H26 admin flags
    ignore_free_slot_validation: { type: "boolean", description: "OPCIONAL (admin only). Força reagendamento em slot bloqueado." },
    ignore_date_range: { type: "boolean", description: "OPCIONAL (admin only). Pula min notice ao reagendar." },
    to_notify: { type: "boolean", description: "OPCIONAL (admin only). `false` = sem notificação do reagendamento." },
  },
  required: ["appointment_id"],
},
```

### 2.5 `update_appointment` — handler

```ts
handler: async (ctx, args) => {
  const appointmentId = String(args.appointment_id || "");
  const invalid = validateGhlId(appointmentId, "appointment");
  if (invalid) return invalid;

  // H26 admin gate
  const overrideResult = buildOverridePayload(ctx, args);
  if (!overrideResult.ok) return overrideResult.error;

  const body: Record<string, unknown> = {};
  if (args.start_time) {
    const startInvalid = validateIso8601(String(args.start_time), "start_time");
    if (startInvalid) return startInvalid;
    body.startTime = new Date(String(args.start_time)).toISOString();
  }
  if (args.end_time) {
    const endInvalid = validateIso8601(String(args.end_time), "end_time");
    if (endInvalid) return endInvalid;
    body.endTime = new Date(String(args.end_time)).toISOString();
  }
  if (args.appointment_status) {
    const VALID_APPT_STATUS = ["confirmed", "showed", "noshow", "cancelled", "invalid"];
    const status = String(args.appointment_status);
    if (!VALID_APPT_STATUS.includes(status)) {
      return { status: "error", message: `appointment_status inválido. Use ${VALID_APPT_STATUS.join("|")}.`, retryable: false };
    }
    body.appointmentStatus = status;
  }

  // H26: meeting location override (auto-ativa flag)
  if (args.meeting_location_type !== undefined) body.meetingLocationType = String(args.meeting_location_type);
  if (args.meeting_location !== undefined) body.address = String(args.meeting_location);
  if (args.meeting_location_type !== undefined || args.meeting_location !== undefined) {
    body.overrideLocationConfig = true;
  }

  // H26: admin override flags
  Object.assign(body, overrideResult.body);

  if (Object.keys(body).length === 0) {
    return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
  }

  try {
    await ctx.ghlClient.put(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, body);

    if (overrideResult.used.length > 0) {
      recordSignalAsync({
        type: "idea",
        title: `Calendar override admin (${overrideResult.used.sort().join("+")})`,
        description: `Admin usou override flags ao reagendar: ${overrideResult.used.join(", ")}`,
        severity: "low",
        source: "bot_auto",
        metadata: {
          tool: "update_appointment",
          appointment_id: appointmentId,
          rep_id: ctx.rep.id,
          rep_phone: ctx.rep.phone,
          location_id: ctx.locationId,
          override_flags_used: overrideResult.used,
        },
      });
    }

    return { status: "ok", data: { appointment_id: appointmentId, updated: Object.keys(body) } };
  } catch (err) {
    return ghlErrorToResult(err, "atualização de appointment");
  }
}
```

### 2.6 System prompt (`prompt-builder.ts`)

Adicionar 2 sub-regras após a seção `# AGENDAMENTO vs BLOQUEIO DE AGENDA`:

```
# MEETING LOCATION — link/endereço da reunião
Calendars têm meeting location DEFAULT (Zoom auto-gerado, telefone, etc) configurado pelo admin. Por padrão, create_appointment/update_appointment respeitam esse default.

QUANDO ESPECIFICAR (pra QUALQUER rep — não precisa ser admin):
- "agenda no MEU Zoom: [link]" → meeting_location_type='custom', meeting_location='[link]'
- "agenda no Google Meet" SEM link → meeting_location_type='gmeet', omite meeting_location (GHL gera)
- "agenda no Zoom" SEM link → meeting_location_type='zoom', omite meeting_location (GHL gera)
- "marca presencial no Coworking X — Av Paulista 100" → meeting_location_type='address', meeting_location='Av Paulista 100, Coworking X'
- "será por telefone, número +55 11 98765-4321" → meeting_location_type='phone', meeting_location='+5511987654321'
- "manda link do Teams: [url]" → meeting_location_type='custom', meeting_location='[url Teams]'

Tipos válidos: 'zoom' | 'gmeet' | 'phone' | 'address' | 'custom'

⚠️ NUNCA invente link/endereço. Se rep só falar tipo (sem link específico), use só o type — GHL gera automaticamente pra zoom/gmeet.
⚠️ Resposta ao rep deve ser linguagem natural: "Marquei quinta 14h com João no Google Meet — link vai pelo invite." NUNCA mencione "override de location" ou jargão técnico.

# OVERRIDE DE CALENDAR — admin only, NUNCA silencioso
3 flags permitem forçar agendamento/reagendamento bypassando validações do Spark Leads. RESTRITAS A ADMIN/INTERNAL TEAM (gate code-level — rep não-admin recebe erro automático).

Quando rep pede ("força", "mesmo bloqueado", "ignora", "marca assim mesmo", "pra agora" quando date range rejeita, "sem mandar aviso"):

1. NUNCA passe override flags na PRIMEIRA chamada — gate H8 vai bloquear sem confirmação.
2. Na confirmação verbal, SEJA EXPLÍCITO sobre o que está ignorando:
   ❌ "Vou marcar quinta 14h, confirma?"  (rep não sabe que tá forçando)
   ✅ "Quinta 14h tá bloqueado no seu calendar (compromisso pessoal ou conflito) — quer forçar mesmo assim? Confirma?"
3. Só após "sim/força/pode" do rep, rechame com `confirmed_by_rep:true` E a flag de override apropriada.
4. Depois do sucesso, mencione que foi forçado: "Marcado quinta 14h (forçando em cima do bloqueio existente)."
5. ⚠️ `to_notify=false` é DRÁSTICO — só quando rep admin disser EXPLICITAMENTE "sem mandar aviso"/"sem notificar". Confirme separadamente.
6. Se rep não-admin pedir override: tool retorna erro explicando que é admin-only. Repasse SEM detalhes técnicos: "Não consigo forçar esse bloqueio — quer tentar outro horário?".
```

### 2.7 docs/DECISIONS.md — entry H26

Adicionar à tabela (logo após H25):

```
| **H26** | `account-assistant/tools/calendar.ts` (createAppointment, updateAppointment) + helper `buildOverridePayload` | 2026-05-14 | 4 override flags em appointments: 3 destrutivas admin-only via H17 is_internal (`ignoreFreeSlotValidation`/`ignoreDateRange`/`toNotify=false`) + `overrideLocationConfig` auto-ativado pra qualquer rep quando passa meeting_location_type/meeting_location (conserta bug silencioso onde GHL descartava esses params). Audit signal `idea` com fingerprint estável (recorder dedupa → counter). `overrideLocationConfig` standalone NÃO exposto — sempre derivado dos params de meeting location. `block_calendar_slot` fora do escopo (endpoint /block-slots não aceita flags). | conversa Pedro 2026-05-14 |
```

---

## 3. Anti-patterns / guardrails

### ❌ NÃO fazer

- **Override implícito das flags admin**: passar `ignoreFreeSlotValidation` sem o rep ter pedido. Bot tem que perguntar "Quer forçar?" antes.
- **Default `to_notify=false`**: quebra automations existentes. Só com pedido explícito.
- **Expor `overrideLocationConfig` como param standalone**: muito ambíguo. Mantém implícito — derivado de meeting_location_type/meeting_location.
- **Bypass do gate H8**: as 4 flags continuam passando por `confirmed_by_rep`. Override **não** é exception.
- **Admin gate por env apenas**: usa `ctx.rep.is_internal` completo (H17). Não duplicar lógica.
- **Fingerprint do signal com appt_id**: gera 1 signal por uso → painel polui. Fingerprint estável (só flags) → dedupa em counter.

### ✅ Garantias

- Confirmation gate H8 já cobre — sem mudança em `tools/index.ts`.
- Admin gate em `buildOverridePayload` antes de qualquer side-effect.
- Audit em `sparkbot_signals` permite Pedro ver padrões com counter natural.
- Erro "slot not available" continua sendo capturado no fallback existente (caso GHL rejeite mesmo com override — edge case).
- Meeting location override é safe pra qualquer rep — não fura validação, só troca link/endereço.

---

## 4. Testes manuais (smoke)

Pedro roda em prod com conta dele (admin = `is_internal=true`):

### Cenários ADMIN (override de horário)

| # | Cenário | Quem | Comando WhatsApp | Esperado |
|---|---|---|---|---|
| 1 | Sem override | qualquer | "Marca reunião com João quinta 14h" | Normal — se slot livre, marca; se bloqueado, oferece alternativas |
| 2 | Override slot bloqueado | admin | "Marca quinta 14h mesmo bloqueado" | Bot: "tá bloqueado, quer forçar?" → "sim" → marca + audit signal |
| 3 | Override min notice | admin | "Marca pra daqui 30min com João" (calendar 2h min) | Bot: "ignora o min notice?" → "sim" → marca |
| 4 | Sem notification | admin | "Marca quinta 14h sem mandar aviso" | Bot confirma → marca com `toNotify=false` |
| 5 | Reagendamento override | admin | "Move o appointment X pra quinta 14h mesmo bloqueado" | Bot: "tá bloqueado, força?" → "sim" → PUT com flag |
| 6 | Override rejeitado | **não-admin** | "Marca quinta 14h mesmo bloqueado" | Tool retorna erro → bot: "Não consigo forçar — quer outro horário?" |
| 7 | Confirmação ambígua | admin | "Marca quinta 14h, força tudo" | Bot deve listar: "vou forçar slot E ignorar min notice — confirma?" |
| 8 | **Mid-flow escalation** | admin | "Marca quinta 14h" → bot pergunta → admin: "sim, mas força mesmo bloqueado" | Bot interpreta override no "sim, mas força" e rechama com flag |

### Cenários MEETING LOCATION (qualquer rep)

| # | Cenário | Quem | Comando WhatsApp | Esperado |
|---|---|---|---|---|
| 9 | Zoom custom link | qualquer rep | "Marca quinta 14h com João no meu Zoom: zoom.us/j/abc123" | Bot confirma → marca com link Zoom do rep, não default do calendar |
| 10 | Google Meet auto-gerado | qualquer rep | "Marca quinta 14h com João no Google Meet" | Bot confirma → GHL gera link Meet automaticamente |
| 11 | Endereço presencial | qualquer rep | "Marca quinta 14h presencial Av Paulista 100" | Bot confirma → appointment criado com address override |
| 12 | Update meeting location | qualquer rep | "Muda a reunião do João pra Google Meet" | Bot confirma → PUT com meeting_location_type=gmeet + override |

Validar no `/admin/signals`: 1 row `idea` por combinação de flags admin (dedupa via fingerprint), counter incrementa. Validar que cenários 9-12 NÃO criam signal (meeting location não audita).

---

## 5. Effort breakdown

| Tarefa | Tempo |
|--------|-------|
| Helper `buildOverridePayload` + import | 30min |
| Schema + handler em `create_appointment` (override + meeting location) | 50min |
| Schema + handler em `update_appointment` (mesma coisa + extending schema) | 40min |
| Audit signal hooks (fingerprint estável, 2 lugares) | 20min |
| System prompt — 2 sub-regras dedicadas | 35min |
| Comment `// H26` inline + entry em `docs/DECISIONS.md` | 15min |
| Typecheck + lint | 5min |
| Commit + push | 5min |
| Smoke test 12 cenários em prod | 60-90min |
| **Total** | **3.5-4h** |

---

## 6. Resolução de open questions

1. ✅ **Restrição por role?** → **3 flags admin-only** via `ctx.rep.is_internal === true`. Meeting location: **qualquer rep**.
2. ✅ **`update_appointment` existe?** → **Sim.** Plano estende, não cria. Adiciona meeting location params (não existiam).
3. ✅ **`overrideLocationConfig` standalone?** → **Não exposto como param.** Auto-ativado quando meeting_location_type/meeting_location passados.
4. ✅ **Fingerprint do signal?** → **Estável** (só flags, sem appt_id). Recorder dedupa naturalmente. Counter cresce conforme uso.
5. ✅ **block_calendar_slot precisa override?** → **Não.** Endpoint diferente (`/block-slots`) não aceita as flags.
