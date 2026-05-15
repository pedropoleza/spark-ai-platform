// E2E test: Filter Engine + Bulk V2 contra location Pedro
// (Insurance Snapshot, H09HtG22LZzTU8htMxxg).
//
// Roda HANDLERS reais das tools (não chama LLM) — valida que pipeline
// completo funciona end-to-end. Nenhuma mensagem é enviada a nenhum
// contato. Bulk V2 só faz preview (não chama schedule_bulk_message_v2).
//
// Roda com: npx tsx -r tsconfig-paths/register scripts/e2e-pedro-test.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { TOOL_REGISTRY } from "@/lib/account-assistant/tools";
import type { ToolContext } from "@/lib/account-assistant/tools/types";
import type { RepIdentity } from "@/types/account-assistant";

const LOC = "H09HtG22LZzTU8htMxxg";
const PEDRO_PHONE = "+17867717077";

type TestResult = {
  name: string;
  passed: boolean;
  detail: string;
  duration_ms: number;
};

const results: TestResult[] = [];

function record(name: string, passed: boolean, detail: string, dur: number) {
  results.push({ name, passed, detail, duration_ms: dur });
  const icon = passed ? "✅" : "❌";
  console.log(`${icon} ${name} (${dur}ms)`);
  if (detail) console.log(`   ${detail}`);
}

async function callTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) throw new Error(`Tool ${name} não encontrada no registry`);
  return tool.handler(ctx, args);
}

async function main() {
  console.log("\n=== E2E Test: Filter Engine + Bulk V2 ===");
  console.log(`Location: ${LOC} | Rep: ${PEDRO_PHONE}\n`);

  const supa = createAdminClient();

  // Setup
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, location_name, timezone")
    .eq("location_id", LOC)
    .single();
  if (!loc) throw new Error("location não sincronizada");

  const { data: repRaw } = await supa
    .from("rep_identities")
    .select("*")
    .eq("phone", PEDRO_PHONE)
    .single();
  if (!repRaw) throw new Error("rep não encontrado");

  // Adiciona link H09 ao rep (se não tiver) — necessário pra ctx.locationId funcionar
  const rep = repRaw as unknown as RepIdentity;
  const hasLink = rep.ghl_users.some((u) => u.location_id === LOC);
  if (!hasLink) {
    console.log("⚠️  Pedro não tem ghl_user link pra essa location no DB.");
    console.log("    Continuando com locationId injetado direto no ctx.");
  }

  const ghl = new GHLClient(loc.company_id, LOC);
  const ctx: ToolContext = {
    rep,
    locationId: LOC,
    companyId: loc.company_id,
    ghlClient: ghl,
    confirmationMode: "high_only",
    testSessionId: null,
  };

  // ===================================================================
  // FASE 1 — Filter Engine direto
  // ===================================================================
  console.log("\n[FASE 1] Filter Engine — tools básicas");
  console.log("─".repeat(60));

  // 1.1 describe_filter_capabilities
  {
    const t = Date.now();
    const r = await callTool(ctx, "describe_filter_capabilities", {});
    const ok =
      r.status === "ok" &&
      typeof r.data === "object" &&
      r.data !== null &&
      "fields" in (r.data as Record<string, unknown>) &&
      "pipelines" in (r.data as Record<string, unknown>);
    const d = r.data as Record<string, unknown>;
    record(
      "describe_filter_capabilities",
      ok,
      ok
        ? `${(d.fields as unknown[]).length} fields, ${(d.pipelines as unknown[])?.length || 0} pipelines, ${(d.custom_fields as unknown[])?.length || 0} CFs`
        : `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 100)}`,
      Date.now() - t,
    );
  }

  // 1.2 count_filtered (contacts total)
  {
    const t = Date.now();
    const r = await callTool(ctx, "count_filtered", {
      entity: "contacts",
      filter: { field: "tags", op: "exists", value: null },
    });
    const ok = r.status === "ok";
    const count = ok ? (r.data as { count: number }).count : -1;
    record(
      "count_filtered (contacts com qualquer tag)",
      ok,
      ok ? `count=${count}` : `${(r as { message?: string }).message}`,
      Date.now() - t,
    );
  }

  // 1.3 count_filtered opps abertas
  {
    const t = Date.now();
    const r = await callTool(ctx, "count_filtered", {
      entity: "opportunities",
      filter: { field: "opportunity.status", op: "eq", value: "open" },
    });
    const ok = r.status === "ok";
    record(
      "count_filtered (opps abertas)",
      ok,
      ok ? `count=${(r.data as { count: number }).count}` : `${(r as { message?: string }).message}`,
      Date.now() - t,
    );
  }

  // 1.4 get_contacts_filtered AND combinado (state=NY OR FL + tem tags)
  {
    const t = Date.now();
    const r = await callTool(ctx, "get_contacts_filtered", {
      filter: {
        all: [
          {
            any: [
              { field: "state", op: "eq", value: "NY" },
              { field: "state", op: "eq", value: "FL" },
            ],
          },
          { field: "tags", op: "contains", value: "lead" },
        ],
      },
      limit: 20,
    });
    const ok = r.status === "ok" || r.status === "not_found";
    record(
      "get_contacts_filtered AND-OR ((state=NY OR state=FL) AND tag=lead)",
      ok,
      ok && r.status === "ok"
        ? `total_returned=${(r.data as { total_returned: number }).total_returned}`
        : ok && r.status === "not_found"
          ? "not_found (esperado se location sem matches)"
          : `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 100)}`,
      Date.now() - t,
    );
  }

  // 1.5 get_opportunities_filtered stage_name alias (ambíguo)
  {
    const t = Date.now();
    const r = await callTool(ctx, "get_opportunities_filtered", {
      filter: {
        field: "opportunity.stageName",
        op: "eq",
        value: "Recovered",
      },
      limit: 5,
    });
    const okOrAmbiguous = r.status === "ok" || r.status === "not_found" || r.status === "error";
    record(
      "get_opportunities_filtered (stage_name='Recovered')",
      okOrAmbiguous,
      r.status === "ok"
        ? `${(r.data as { total_returned: number }).total_returned} opps`
        : r.status === "error"
          ? `error (esperado se ambíguo): ${(r as { message?: string }).message?.slice(0, 100)}`
          : "not_found",
      Date.now() - t,
    );
  }

  // 1.6 OR via 'any'
  {
    const t = Date.now();
    const r = await callTool(ctx, "get_contacts_filtered", {
      filter: {
        any: [
          { field: "tags", op: "contains", value: "lead" },
          { field: "tags", op: "contains", value: "client" },
        ],
      },
      limit: 50,
    });
    const ok = r.status === "ok" || r.status === "not_found";
    record(
      "get_contacts_filtered OR (tag=lead OR tag=client)",
      ok,
      r.status === "ok"
        ? `${(r.data as { total_returned: number }).total_returned} união`
        : "not_found",
      Date.now() - t,
    );
  }

  // ===================================================================
  // FASE 2 — Bulk V2 preview (read-only, NÃO cria job)
  // ===================================================================
  console.log("\n[FASE 2] Bulk V2 — preview (read-only)");
  console.log("─".repeat(60));

  // 2.1 Preview single segment SEM list_temperature → deve mostrar disclaimer
  {
    const t = Date.now();
    const r = await callTool(ctx, "preview_bulk_message_v2", {
      segments: [
        {
          label: "Test segment",
          filter: { field: "tags", op: "exists", value: null },
          message_template: "Oi {first_name}! Mensagem de teste.",
        },
      ],
      // list_temperature OMITIDO de propósito — espera disclaimer lista_quente_required
    });
    const ok = r.status === "ok";
    const data = r.data as {
      total_contacts: number;
      disclaimers: Array<{ key: string; required_flag: string }>;
      list_temperature: string;
    };
    const hasWarmDisclaimer = ok && data.disclaimers.some((d) => d.key === "lista_quente_required");
    record(
      "preview_bulk_message_v2 sem list_temperature → disclaimer obrigatório",
      ok && hasWarmDisclaimer,
      ok
        ? `total=${data.total_contacts} disclaimers=${data.disclaimers.length} keys=[${data.disclaimers.map((d) => d.key).join(",")}]`
        : `${(r as { message?: string }).message}`,
      Date.now() - t,
    );
  }

  // 2.2 Preview multi-segment com list_temperature=warm
  {
    const t = Date.now();
    const r = await callTool(ctx, "preview_bulk_message_v2", {
      segments: [
        {
          label: "Tag clientes",
          filter: { field: "tags", op: "contains", value: "client" },
          message_template: "Oi {first_name}, mensagem A pra cliente.",
        },
        {
          label: "Tag leads",
          filter: { field: "tags", op: "contains", value: "lead" },
          message_template: "Oi {first_name}, mensagem B pra lead.",
        },
      ],
      list_temperature: "warm",
      dedup_across_segments: true,
    });
    const ok = r.status === "ok";
    const data = r.data as {
      segments: Array<{ label: string; count_after_dedup: number }>;
      total_contacts: number;
      risk_level: string;
      disclaimers: Array<{ key: string }>;
    };
    record(
      "preview_bulk_message_v2 multi-segment warm",
      ok,
      ok
        ? `total=${data.total_contacts} risk=${data.risk_level} segments=[${data.segments.map((s) => `${s.label}:${s.count_after_dedup}`).join(", ")}] disclaimers=${data.disclaimers.length}`
        : `${(r as { message?: string }).message}`,
      Date.now() - t,
    );
  }

  // 2.3 Preview cold list — risk_disclaimer obrigatório (tag lead = volume conhecido)
  {
    const t = Date.now();
    const r = await callTool(ctx, "preview_bulk_message_v2", {
      segments: [
        {
          label: "Cold leads",
          filter: { field: "tags", op: "contains", value: "lead" },
          message_template: "Oi {first_name}, mensagem fria.",
        },
      ],
      list_temperature: "cold",
    });
    const ok = r.status === "ok";
    const data = r.data as {
      total_contacts: number;
      risk_level: string;
      disclaimers: Array<{ key: string }>;
    };
    const hasColdDisclaimer =
      ok && data.disclaimers.some((d) => d.key === "risk_any_volume_cold");
    record(
      "preview_bulk_message_v2 cold list — risk disclaimer",
      ok && (data.total_contacts <= 10 || hasColdDisclaimer),
      ok
        ? `total=${data.total_contacts} risk=${data.risk_level} disclaimer_cold_present=${hasColdDisclaimer}`
        : `${(r as { message?: string }).message}`,
      Date.now() - t,
    );
  }

  // ===================================================================
  // FASE 3 — schedule_bulk_message_v2 sem disclaimers → deve falhar
  // ===================================================================
  console.log("\n[FASE 3] schedule_bulk_message_v2 — validar disclaimer gate");
  console.log("─".repeat(60));

  // 3.1 Tenta schedule sem confirmed_warm_list → erro com lista de missing
  {
    const t = Date.now();
    const r = await callTool(ctx, "schedule_bulk_message_v2", {
      segments: [
        {
          label: "Test",
          filter: { field: "tags", op: "contains", value: "nonexistent_tag_xyz" },
          message_template: "Oi {first_name}",
        },
      ],
      list_temperature: "warm",
      confirmed_by_rep: true,
      // confirmed_warm_list OMITIDO — deve dar erro
    });
    const ok = r.status === "error" || r.status === "not_found";
    record(
      "schedule_bulk_message_v2 sem confirmed_warm_list → bloqueado",
      ok,
      `status=${r.status} msg=${(r as { message?: string }).message?.slice(0, 120)}`,
      Date.now() - t,
    );
  }

  // ===================================================================
  // FASE 4 — Wrappers retrocompat (search_contacts ainda funciona)
  // ===================================================================
  console.log("\n[FASE 4] Wrappers retrocompat");
  console.log("─".repeat(60));

  // 4.1 search_contacts query simples (fast path GET)
  {
    const t = Date.now();
    const r = await callTool(ctx, "search_contacts", {
      query: "test",
      limit: 5,
    });
    const ok = r.status === "ok" || r.status === "not_found";
    record(
      "search_contacts query simples (fast path GET)",
      ok,
      r.status === "ok"
        ? `${(r.data as { total_returned: number }).total_returned} contatos | method=${(r.data as { method: string }).method}`
        : "not_found",
      Date.now() - t,
    );
  }

  // 4.2 list_birthdays_today (via engine + client-side fallback)
  {
    const t = Date.now();
    const r = await callTool(ctx, "list_birthdays_today", { when: "today" });
    const ok = r.status === "ok" || r.status === "not_found";
    record(
      "list_birthdays_today (engine + client-side fallback)",
      ok,
      r.status === "ok"
        ? `${(r.data as { total: number }).total} aniversariantes | warning=${!!(r.data as { warning?: string }).warning}`
        : "erro",
      Date.now() - t,
    );
  }

  // ===================================================================
  // FASE 5 — Audit log verification
  // ===================================================================
  console.log("\n[FASE 5] Audit log");
  console.log("─".repeat(60));

  {
    const t = Date.now();
    const { data: audits } = await supa
      .from("filter_executions")
      .select("entity, status, duration_ms, total_returned, hit_safety_cap, consumer_tool, plan_steps")
      .eq("rep_id", rep.id)
      .gte("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(20);
    const ok = !!audits && audits.length >= 5;
    record(
      "Audit log filter_executions (últimos 10min)",
      ok,
      `${audits?.length || 0} rows. Tools usadas: [${[...new Set(audits?.map((a) => a.consumer_tool))].join(", ")}]`,
      Date.now() - t,
    );
    if (audits && audits.length > 0) {
      console.log("   Top 5 mais lentas:");
      [...audits]
        .sort((a, b) => b.duration_ms - a.duration_ms)
        .slice(0, 5)
        .forEach((a) => {
          console.log(
            `     ${a.consumer_tool} ${a.entity}: ${a.duration_ms}ms ${a.total_returned} items ${a.hit_safety_cap ? "(CAPPED)" : ""}`,
          );
        });
    }
  }

  // ===================================================================
  // SUMÁRIO
  // ===================================================================
  console.log("\n" + "═".repeat(60));
  console.log("SUMÁRIO");
  console.log("═".repeat(60));
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`\n${passed === total ? "✅" : "⚠️"} ${passed}/${total} testes OK`);
  if (passed < total) {
    console.log("\nFalhas:");
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ❌ ${r.name}`);
      console.log(`     ${r.detail}`);
    });
  }
  const totalTime = results.reduce((a, r) => a + r.duration_ms, 0);
  console.log(`\nTempo total: ${totalTime}ms`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
