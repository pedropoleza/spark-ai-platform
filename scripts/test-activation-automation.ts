/**
 * Testes do trigger "agente ativado pro contato" (H62, 2026-08-03).
 *
 * Cobre: (1) o filtro puro das regras (kind + dedup + regra vazia); (2) o zod
 * do config aceita o trigger novo e rejeita lixo; (3) o runner MANUAL com deps
 * fake — dispara, faz merge no triggered_automations, não re-dispara, no-op
 * barato sem regra, e erro no executor não escapa (fail-soft).
 *
 * READ-ONLY (supabase fake; zero rede). Rodar:
 *   npx tsx scripts/test-activation-automation.ts
 */
import { pickAgentActivatedRules, runAgentActivatedAutomations } from "../src/lib/queue/agent-activated-automation";
import { updateAgentConfigSchema } from "../src/lib/utils/validation";
import type { AutomationRule } from "../src/types/agent";
import type { SupabaseClient } from "@supabase/supabase-js";

let pass = 0,
  fail = 0;
function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const rAtivado = (id: string): AutomationRule => ({
  id,
  trigger: { kind: "agent_activated" },
  actions: [{ type: "add_tag", tag: "atendido-pela-ia" }],
});

async function main() {
  // -------------------------------------------------------------------------
  console.log("\n1. pickAgentActivatedRules — filtro puro");
  // -------------------------------------------------------------------------
  const regras: AutomationRule[] = [
    rAtivado("a1"),
    { id: "e1", trigger: { kind: "event", event: "qualified" }, actions: [{ type: "add_tag", tag: "q" }] },
    { id: "f1", trigger: { kind: "on_data_field_set", field_key: "x", operator: "any_value" }, actions: [{ type: "add_tag", tag: "f" }] },
    rAtivado("a2"),
    { id: "a3", trigger: { kind: "agent_activated" }, actions: [] }, // sem ação = ignorada
  ];
  const semDedup = pickAgentActivatedRules(regras, new Set());
  check("pega só as agent_activated com ação", semDedup.map((r) => r.id).join(",") === "a1,a2");
  check("dedup remove já disparada", pickAgentActivatedRules(regras, new Set(["a1"])).map((r) => r.id).join(",") === "a2");
  check("lista null → []", pickAgentActivatedRules(null, new Set()).length === 0);
  check("lista undefined → []", pickAgentActivatedRules(undefined, new Set()).length === 0);
  check("evento legado (sem trigger) não entra", pickAgentActivatedRules([{ id: "l", event: "qualified", actions: [{ type: "add_tag", tag: "x" }] }], new Set()).length === 0);

  // -------------------------------------------------------------------------
  console.log("\n2. Zod aceita o trigger novo (e rejeita lixo)");
  // -------------------------------------------------------------------------
  const okBody = updateAgentConfigSchema.safeParse({
    automations: [{ id: "a1", trigger: { kind: "agent_activated" }, actions: [{ type: "move_pipeline", pipeline_id: "p1", stage_id: "s1" }] }],
  });
  check("trigger agent_activated passa no PUT do config", okBody.success, JSON.stringify(okBody.success ? "" : okBody.error.issues[0]));
  const badBody = updateAgentConfigSchema.safeParse({
    automations: [{ id: "a1", trigger: { kind: "agent_activated", event: 123 }, actions: [{ type: "add_tag", tag: "x" }] }],
  });
  // union estrita? zod object não é strict por default — campo extra é ignorado.
  check("campo extra no trigger é tolerado (zod non-strict)", badBody.success);
  const badKind = updateAgentConfigSchema.safeParse({
    automations: [{ id: "a1", trigger: { kind: "banana" }, actions: [{ type: "add_tag", tag: "x" }] }],
  });
  check("kind inválido é rejeitado", !badKind.success);

  // -------------------------------------------------------------------------
  console.log("\n3. runAgentActivatedAutomations — runner manual com deps fake");
  // -------------------------------------------------------------------------
  type Row = Record<string, unknown> | null;
  function makeFakeSupabase(data: {
    automations?: unknown;
    state?: Row;
    companyId?: string | null;
    /** location REAL do agente (review H62: o runner revalida). Default = "loc-1". */
    agentLocation?: string | null;
    /** channel do último message_queue (review H62). Default = null. */
    channel?: string | null;
  }) {
    const writes: Array<{ table: string; op: string; payload: unknown }> = [];
    function query(table: string) {
      const calls: Record<string, unknown[]> = {};
      const target = () => {};
      const self: unknown = new Proxy(target, {
        get(_t, prop: string) {
          if (prop === "then") {
            const resolveRow = (): Row => {
              if (table === "agent_configs") return { automations: data.automations };
              if (table === "conversation_state") return data.state ?? null;
              if (table === "locations") return { company_id: data.companyId === undefined ? "comp-1" : data.companyId };
              if (table === "agents") {
                const loc = data.agentLocation === undefined ? "loc-1" : data.agentLocation;
                return loc === null ? null : { location_id: loc };
              }
              if (table === "message_queue") return data.channel ? { channel: data.channel } : null;
              return null;
            };
            return (resolve: (v: { data: Row; error: null }) => void) => resolve({ data: resolveRow(), error: null });
          }
          return (...args: unknown[]) => {
            calls[prop] = args;
            if (prop === "update" || prop === "insert") writes.push({ table, op: prop, payload: args[0] });
            return self;
          };
        },
      });
      return self;
    }
    return { supabase: { from: (t: string) => query(t) } as unknown as SupabaseClient, writes };
  }

  // CASO FELIZ: 1 regra, dispara, merge persiste, audit gravado.
  {
    const executed: string[][] = [];
    const { supabase, writes } = makeFakeSupabase({
      automations: [rAtivado("a1")],
      state: { triggered_automations: [], conversation_id: "conv-1" },
    });
    const r = await runAgentActivatedAutomations({
      agentId: "ag-1",
      locationId: "loc-1",
      contactId: "ct-1",
      source: "manual_resume",
      deps: {
        supabase,
        execute: async (rules) => {
          executed.push(rules.map((x) => x.id));
          return { executedRuleIds: rules.map((x) => x.id) };
        },
      },
    });
    check("dispara a regra", r.fired === 1 && executed[0]?.join(",") === "a1");
    const merge = writes.find((w) => w.table === "conversation_state" && w.op === "update");
    check("merge no triggered_automations", JSON.stringify((merge?.payload as { triggered_automations?: string[] })?.triggered_automations) === '["a1"]');
    const audit = writes.find((w) => w.table === "execution_log");
    check("audit agent_activated_automation", (audit?.payload as { action_type?: string })?.action_type === "agent_activated_automation");
    check("audit carrega o source", (audit?.payload as { action_payload?: { source?: string } })?.action_payload?.source === "manual_resume");
  }

  // DEDUP: regra já disparada → no-op, sem executor, sem writes.
  {
    let called = 0;
    const { supabase, writes } = makeFakeSupabase({
      automations: [rAtivado("a1")],
      state: { triggered_automations: ["a1"], conversation_id: "" },
    });
    const r = await runAgentActivatedAutomations({
      agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_switch",
      deps: { supabase, execute: async () => { called++; return { executedRuleIds: [] }; } },
    });
    check("já disparada → não re-dispara", r.fired === 0 && called === 0);
    check("já disparada → zero writes", writes.length === 0);
  }

  // SEM regra agent_activated → no-op barato (nem lê estado).
  {
    let called = 0;
    const { supabase, writes } = makeFakeSupabase({
      automations: [{ id: "e1", trigger: { kind: "event", event: "booked" }, actions: [{ type: "add_tag", tag: "x" }] }],
    });
    const r = await runAgentActivatedAutomations({
      agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_resume",
      deps: { supabase, execute: async () => { called++; return { executedRuleIds: [] }; } },
    });
    check("config sem trigger → no-op", r.fired === 0 && called === 0 && writes.length === 0);
  }

  // SEM company_id → pula com aviso, sem executor.
  {
    let called = 0;
    const { supabase } = makeFakeSupabase({
      automations: [rAtivado("a1")],
      state: { triggered_automations: [], conversation_id: "" },
      companyId: null,
    });
    const r = await runAgentActivatedAutomations({
      agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_resume",
      deps: { supabase, execute: async () => { called++; return { executedRuleIds: [] }; } },
    });
    check("sem company_id → pulada", r.fired === 0 && called === 0);
  }

  // ANTI CROSS-TENANT (review H62): agente de OUTRA location → pula sem executar.
  {
    let called = 0;
    const { supabase, writes } = makeFakeSupabase({
      automations: [rAtivado("a1")],
      state: { triggered_automations: [], conversation_id: "" },
      agentLocation: "loc-OUTRA",
    });
    const r = await runAgentActivatedAutomations({
      agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_resume",
      deps: { supabase, execute: async () => { called++; return { executedRuleIds: [] }; } },
    });
    check("agente de outra location → pulada", r.fired === 0 && called === 0 && writes.length === 0);
  }

  // CANAL (review H62): channel do último message_queue chega no ctx do executor.
  {
    let seenChannel: string | undefined = "nao-setado";
    const { supabase } = makeFakeSupabase({
      automations: [rAtivado("a1")],
      state: { triggered_automations: [], conversation_id: "" },
      channel: "IG",
    });
    await runAgentActivatedAutomations({
      agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_resume",
      deps: {
        supabase,
        execute: async (_rules, ctx) => {
          seenChannel = (ctx as { channel?: string }).channel;
          return { executedRuleIds: ["a1"] };
        },
      },
    });
    check("channel da conversa chega no executor", seenChannel === "IG", String(seenChannel));
  }

  // FAIL-SOFT: executor explode → não lança, fired 0.
  {
    const { supabase } = makeFakeSupabase({
      automations: [rAtivado("a1")],
      state: { triggered_automations: [], conversation_id: "" },
    });
    let threw = false;
    let r = { fired: -1 };
    try {
      r = await runAgentActivatedAutomations({
        agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_resume",
        deps: { supabase, execute: async () => { throw new Error("boom GHL"); } },
      });
    } catch {
      threw = true;
    }
    check("erro no executor não escapa (fail-soft)", !threw && r.fired === 0);
  }

  // EXECUÇÃO PARCIAL: 2 regras, 1 falha → só a OK entra no merge (re-tenta a outra
  // na próxima ativação manual; comportamento herdado do executeReactionRules).
  {
    const { supabase, writes } = makeFakeSupabase({
      automations: [rAtivado("a1"), rAtivado("a2")],
      state: { triggered_automations: [], conversation_id: "" },
    });
    const r = await runAgentActivatedAutomations({
      agentId: "ag-1", locationId: "loc-1", contactId: "ct-1", source: "manual_switch",
      deps: { supabase, execute: async () => ({ executedRuleIds: ["a2"] }) },
    });
    const merge = writes.find((w) => w.table === "conversation_state" && w.op === "update");
    check("parcial: só a executada entra no dedup", r.fired === 1 && JSON.stringify((merge?.payload as { triggered_automations?: string[] })?.triggered_automations) === '["a2"]');
    const audit = writes.find((w) => w.table === "execution_log");
    check("parcial: audit marca success=false", (audit?.payload as { success?: boolean })?.success === false);
  }

  console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}\n`);
  process.exit(fail ? 1 : 0);
}

main();
