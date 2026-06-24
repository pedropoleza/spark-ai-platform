// Smoke do create_appointments_batch (fix caso Manuela 2026-06-23).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-appointments-batch.ts
//
// Cobre o comportamento NOVO do batch (a resolução de override/assignee single
// já é coberta por test-override-gate.ts). Foca em:
//  - cap (>30) e lista vazia rejeitados
//  - admin marcando em calendário de OUTRA pessoa → assignee vira o DONO
//  - rep que JÁ é membro → assignee NÃO muda
//  - resultado parcial: item que falha vai pra failed, resto pra created
//  - 1 única chamada (loop server-side), não N round-trips

import { CALENDAR_TOOLS } from "@/lib/account-assistant/tools/calendar";
import type { ToolContext } from "@/lib/account-assistant/tools/types";

const tool = CALENDAR_TOOLS.find((t) => t.def.name === "create_appointments_batch");
if (!tool) {
  console.error("❌ create_appointments_batch não registrado em CALENDAR_TOOLS");
  process.exit(1);
}

interface CtxOpts {
  isAdmin?: boolean;
  repUser?: string;
  calMembers?: string[];
  failContacts?: string[];
}
function makeCtx(opts: CtxOpts): { ctx: ToolContext; posts: Array<Record<string, unknown>> } {
  const posts: Array<Record<string, unknown>> = [];
  const repUser = opts.repUser ?? "RepUser1";
  const ctx = {
    rep: {
      id: "rep1",
      phone: "+15550001111",
      is_internal: false,
      ghl_users: [{ location_id: "LOC1", ghl_user_id: repUser, role: opts.isAdmin ? "admin" : null }],
      profile: {},
    },
    locationId: "LOC1",
    companyId: "COMP1",
    ghlClient: {
      get: async () => ({
        calendar: { name: "Carreira", teamMembers: (opts.calMembers ?? []).map((u) => ({ userId: u })) },
      }),
      post: async (_url: string, body: Record<string, unknown>) => {
        posts.push(body);
        if ((opts.failContacts ?? []).includes(String(body.contactId))) throw new Error("slot blocked");
        return { id: "appt_" + body.contactId };
      },
    },
  } as unknown as ToolContext;
  return { ctx, posts };
}

const items = (ids: string[]) =>
  ids.map((c) => ({ contact_id: c, start_time: "2026-06-30T14:00:00-04:00", end_time: "2026-06-30T14:30:00-04:00" }));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // 1) lista vazia → erro
  {
    const { ctx } = makeCtx({});
    const r = await tool!.handler(ctx, { calendar_id: "CalXXXXXXXXXXXXXXXXX", appointments: [] });
    check("lista vazia → erro", r.status === "error");
  }

  // 2) >30 → erro
  {
    const { ctx } = makeCtx({});
    const r = await tool!.handler(ctx, {
      calendar_id: "CalXXXXXXXXXXXXXXXXX",
      appointments: items(Array.from({ length: 31 }, (_, i) => `Contact${i}XXXXXXXXXXX`)),
    });
    check(">30 → erro", r.status === "error");
  }

  // 3) ADMIN no calendário da Ana (não é membro) + override → assignee vira o DONO (caso Manuela)
  {
    const { ctx, posts } = makeCtx({ isAdmin: true, repUser: "ManuUser", calMembers: ["AnaOwner"] });
    const r = await tool!.handler(ctx, {
      calendar_id: "CalXXXXXXXXXXXXXXXXX",
      appointments: items(["ContatoAXXXXXXXXXXXX", "ContatoBXXXXXXXXXXXX"]),
      ignore_free_slot_validation: true,
    });
    const ok = r.status === "ok";
    const data = (ok ? r.data : {}) as Record<string, unknown>;
    check("admin: 2/2 criadas", ok && data.created_count === 2, JSON.stringify(data.summary));
    check("admin: assignee resolvido pro DONO (AnaOwner)", data.assigned_to === "AnaOwner", String(data.assigned_to));
    check("admin: TODOS os posts foram pro dono", posts.length === 2 && posts.every((p) => p.assignedUserId === "AnaOwner"));
    check("admin: override aplicado em todos", posts.every((p) => p.ignoreFreeSlotValidation === true));
  }

  // 4) admin que JÁ é membro → assignee NÃO muda (continua o próprio rep, via override self)
  {
    const { ctx, posts } = makeCtx({ isAdmin: true, repUser: "ManuUser", calMembers: ["ManuUser", "Outro"] });
    const r = await tool!.handler(ctx, {
      calendar_id: "CalXXXXXXXXXXXXXXXXX",
      appointments: items(["ContatoCXXXXXXXXXXXX"]),
      ignore_free_slot_validation: true,
    });
    const data = (r.status === "ok" ? r.data : {}) as Record<string, unknown>;
    check("admin membro: assignee continua o próprio rep", data.assigned_to === "ManuUser" && posts[0]?.assignedUserId === "ManuUser");
  }

  // 5) parcial: 1 contato falha → failed=1, created=2
  {
    const { ctx } = makeCtx({ isAdmin: true, repUser: "ManuUser", calMembers: ["AnaOwner"], failContacts: ["ContatoFalhaXXXXXXXX"] });
    const r = await tool!.handler(ctx, {
      calendar_id: "CalXXXXXXXXXXXXXXXXX",
      appointments: items(["ContatoDXXXXXXXXXXXX", "ContatoFalhaXXXXXXXX", "ContatoEXXXXXXXXXXXX"]),
      ignore_free_slot_validation: true,
    });
    const data = (r.status === "ok" ? r.data : {}) as Record<string, unknown>;
    check("parcial: created=2", data.created_count === 2, JSON.stringify(data.summary));
    check("parcial: failed=1", data.failed_count === 1);
    check("parcial: o contato que falhou está em failed", Array.isArray(data.failed) && (data.failed as Array<{ contact_id: string }>)[0]?.contact_id === "ContatoFalhaXXXXXXXX");
  }

  // 6) item com ISO inválido → vai pra failed (não derruba o lote)
  {
    const { ctx } = makeCtx({ isAdmin: true, calMembers: ["AnaOwner"] });
    const r = await tool!.handler(ctx, {
      calendar_id: "CalXXXXXXXXXXXXXXXXX",
      appointments: [
        { contact_id: "ContatoGXXXXXXXXXXXX", start_time: "amanhã 2pm", end_time: "amanhã 2:30pm" },
        { contact_id: "ContatoHXXXXXXXXXXXX", start_time: "2026-06-30T15:00:00-04:00", end_time: "2026-06-30T15:30:00-04:00" },
      ],
    });
    const data = (r.status === "ok" ? r.data : {}) as Record<string, unknown>;
    check("ISO inválido vai pra failed, válido cria", data.created_count === 1 && data.failed_count === 1);
  }

  console.log(`\nTOTAL: ${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : " ✅"}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
