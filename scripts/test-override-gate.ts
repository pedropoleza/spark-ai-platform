// Golden test do gate de override de appointment (Agendamento V2 — Etapa 1).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-override-gate.ts
//
// Cobre a decisão D1 (Pedro 2026-05-22):
//  - rep PODE forçar slot bloqueado / min-notice na PRÓPRIA agenda
//    (assignee self / não-setado / round-robin / == próprio ghl_user)
//  - na agenda de OUTRO user, override segue admin-only
//  - to_notify:false (não notificar o CLIENTE) segue admin-only SEMPRE

import {
  buildOverridePayload,
  resolveCalendarChoice,
  checkBlockSlotPermission,
} from "@/lib/account-assistant/tools/calendar";
import { resolveAssignedUserId, getRepGhlUserId } from "@/lib/account-assistant/tools/types";
import type { ToolContext } from "@/lib/account-assistant/tools/types";
import type { ToolResult } from "@/types/account-assistant";

const REP_USER = "RepGhlUser0000000001"; // ghl_user_id do rep na location ativa
const LOC = "Loc00000000000000001";

function ctxFor(isInternal: boolean): ToolContext {
  return {
    rep: {
      is_internal: isInternal,
      ghl_users: [{ location_id: LOC, ghl_user_id: REP_USER }],
    },
    locationId: LOC,
    companyId: "Comp0000000000000001",
    // ghlClient não é tocado por buildOverridePayload (gate puro).
    ghlClient: {} as ToolContext["ghlClient"],
  } as unknown as ToolContext;
}

interface Case {
  name: string;
  internal: boolean;
  args: Record<string, unknown>;
  expectOk: boolean; // true = override liberado; false = bloqueado
  expectUsed?: string[]; // flags esperadas no body (quando ok)
  why: string;
}

const cases: Case[] = [
  // ── Própria agenda (não-admin) → liberado ──
  {
    name: "self implícito (sem assignee) força slot",
    internal: false,
    args: { ignore_free_slot_validation: true },
    expectOk: true,
    expectUsed: ["ignore_free_slot_validation"],
    why: "assignee não-setado = self → override liberado na própria agenda",
  },
  {
    name: "assignee='self' força slot",
    internal: false,
    args: { assigned_user_id: "self", ignore_free_slot_validation: true },
    expectOk: true,
    expectUsed: ["ignore_free_slot_validation"],
    why: "palavra 'self' → própria agenda",
  },
  {
    name: "assignee='eu' (PT) pula min notice",
    internal: false,
    args: { assigned_user_id: "eu", ignore_date_range: true },
    expectOk: true,
    expectUsed: ["ignore_date_range"],
    why: "palavra 'eu' → própria agenda",
  },
  {
    name: "assignee = próprio ghl_user_id força slot",
    internal: false,
    args: { assigned_user_id: REP_USER, ignore_free_slot_validation: true },
    expectOk: true,
    expectUsed: ["ignore_free_slot_validation"],
    why: "id explícito == rep → própria agenda",
  },
  {
    name: "self + ambos overrides juntos",
    internal: false,
    args: { ignore_free_slot_validation: true, ignore_date_range: true },
    expectOk: true,
    expectUsed: ["ignore_free_slot_validation", "ignore_date_range"],
    why: "self pode usar as duas flags de slot",
  },

  // ── Agenda de OUTRO (não-admin) → bloqueado ──
  {
    name: "outro user força slot (não-admin)",
    internal: false,
    args: { assigned_user_id: "OtherGhlUser000000002", ignore_free_slot_validation: true },
    expectOk: false,
    why: "agenda de outra pessoa → admin-only",
  },
  {
    name: "outro user pula min notice (não-admin)",
    internal: false,
    args: { assigned_user_id: "OtherGhlUser000000002", ignore_date_range: true },
    expectOk: false,
    why: "agenda de outra pessoa → admin-only",
  },

  // ── Admin → liberado em qualquer agenda ──
  {
    name: "admin força slot na agenda de outro",
    internal: true,
    args: { assigned_user_id: "OtherGhlUser000000002", ignore_free_slot_validation: true },
    expectOk: true,
    expectUsed: ["ignore_free_slot_validation"],
    why: "is_internal → override liberado mesmo em agenda alheia",
  },

  // ── to_notify:false (client-facing) → admin-only SEMPRE ──
  {
    name: "não notificar cliente na PRÓPRIA agenda (não-admin)",
    internal: false,
    args: { to_notify: false },
    expectOk: false,
    why: "to_notify:false é client-facing → admin-only mesmo na própria agenda",
  },
  {
    name: "admin pode não notificar cliente",
    internal: true,
    args: { to_notify: false },
    expectOk: true,
    expectUsed: ["to_notify_false"],
    why: "is_internal → pode suprimir notificação ao cliente",
  },

  // ── Sem flags → no-op liberado ──
  {
    name: "nenhuma flag de override",
    internal: false,
    args: { assigned_user_id: "self" },
    expectOk: true,
    expectUsed: [],
    why: "sem override = body vazio, sempre ok",
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const res = buildOverridePayload(ctxFor(c.internal), c.args);
  const gotOk = res.ok;
  let ok = gotOk === c.expectOk;

  if (ok && gotOk && c.expectUsed) {
    const used = res.used.slice().sort();
    const want = c.expectUsed.slice().sort();
    ok = JSON.stringify(used) === JSON.stringify(want);
  }

  if (ok) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    console.log(`   esperado ok=${c.expectOk}${c.expectUsed ? ` used=${JSON.stringify(c.expectUsed)}` : ""}`);
    console.log(`   recebido ok=${gotOk}${gotOk ? ` used=${JSON.stringify((res as { used: string[] }).used)}` : ` (${(res as { error: { message: string } }).error.message.slice(0, 60)}...)`}`);
    console.log(`   why: ${c.why}`);
  }
}

console.log(`\n${pass}/${cases.length} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);

// ── Resolução de calendário (Agendamento V2 — E2) ──
console.log("\n— resolveCalendarChoice —");
interface RCase {
  name: string;
  ids: string[];
  pref?: string;
  expectResolved?: string;
  expectResolution: "default_pref" | "only_calendar" | "ambiguous" | "none";
}
const rcases: RCase[] = [
  { name: "pref salva existe → usa ela", ids: ["A", "B", "C"], pref: "B", expectResolved: "B", expectResolution: "default_pref" },
  { name: "pref salva sumiu (calendário deletado) → cai pra ambíguo", ids: ["A", "B"], pref: "Z", expectResolution: "ambiguous" },
  { name: "pref salva sumiu mas só sobrou 1 → only", ids: ["A"], pref: "Z", expectResolved: "A", expectResolution: "only_calendar" },
  { name: "sem pref, 1 calendário → usa ele", ids: ["A"], expectResolved: "A", expectResolution: "only_calendar" },
  { name: "sem pref, vários → ambíguo (LLM resolve)", ids: ["A", "B", "C"], expectResolution: "ambiguous" },
  { name: "nenhum calendário → none", ids: [], expectResolution: "none" },
];
for (const c of rcases) {
  const r = resolveCalendarChoice(c.ids, c.pref);
  const ok = r.resolution === c.expectResolution && r.resolved_calendar_id === c.expectResolved;
  if (ok) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    console.log(`   esperado resolution=${c.expectResolution} resolved=${c.expectResolved ?? "—"}`);
    console.log(`   recebido resolution=${r.resolution} resolved=${r.resolved_calendar_id ?? "—"}`);
  }
}

// ── block_calendar_slot: gate self/admin (D1 paridade 2026-06-10) ──
// Espelha o fluxo do handler: resolve assignee → fallback pro rep → gate.
// null = bloqueio permitido; ToolResult de erro = barrado pelo gate self/admin.
console.log("\n— block_calendar_slot (gate self/admin) —");
function blockSlotGate(internal: boolean, assignedUserId: unknown): ToolResult | null {
  const ctx = ctxFor(internal);
  const resolved = resolveAssignedUserId(ctx, assignedUserId);
  if (!resolved.ok) return resolved.error;
  const targetUser = resolved.user_id || getRepGhlUserId(ctx);
  if (!targetUser) {
    return { status: "error", message: "sem targetUser", retryable: false };
  }
  return checkBlockSlotPermission(ctx, targetUser);
}
interface BCase {
  name: string;
  internal: boolean;
  assigned?: unknown;
  expectAllowed: boolean; // true = bloqueio permitido (gate retorna null)
  why: string;
}
const bcases: BCase[] = [
  {
    name: "não-admin bloqueia a PRÓPRIA agenda (sem assignee)",
    internal: false,
    expectAllowed: true,
    why: "default = self → liberado pra qualquer rep",
  },
  {
    name: "não-admin bloqueia a PRÓPRIA agenda ('self')",
    internal: false,
    assigned: "self",
    expectAllowed: true,
    why: "'self' resolve pro ghl_user do rep → liberado",
  },
  {
    name: "não-admin bloqueia a PRÓPRIA agenda (próprio ghl_user_id)",
    internal: false,
    assigned: REP_USER,
    expectAllowed: true,
    why: "id explícito == rep → liberado",
  },
  {
    name: "não-admin bloqueia agenda de OUTRO user",
    internal: false,
    assigned: "OtherGhlUser000000002",
    expectAllowed: false,
    why: "agenda alheia → admin-only (paridade D1)",
  },
  {
    name: "admin bloqueia agenda de OUTRO user",
    internal: true,
    assigned: "OtherGhlUser000000002",
    expectAllowed: true,
    why: "is_internal → liberado em qualquer agenda",
  },
];
for (const c of bcases) {
  const res = blockSlotGate(c.internal, c.assigned);
  const allowed = res === null;
  if (allowed === c.expectAllowed) {
    pass++;
    console.log(`✅ ${c.name}`);
  } else {
    fail++;
    console.log(`❌ ${c.name}`);
    console.log(`   esperado allowed=${c.expectAllowed}, recebido allowed=${allowed}${res ? ` (${res.message.slice(0, 60)}...)` : ""}`);
    console.log(`   why: ${c.why}`);
  }
}

const total = cases.length + rcases.length + bcases.length;
console.log(`\nTOTAL: ${pass}/${total} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
