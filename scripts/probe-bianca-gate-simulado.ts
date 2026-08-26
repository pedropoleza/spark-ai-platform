/**
 * READ-ONLY — simula o gate da Fase 0 contra os contatos REAIS da Bianca antes
 * de ligar. Usa o avaliador de produção (`evaluateTargetingSet`), então o que
 * sair aqui é o que o runtime vai decidir. Nenhuma mensagem é enviada.
 *
 *   npx tsx scripts/probe-bianca-gate-simulado.ts
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "cRavIlyC52vFYgJATgi7";

type Contact = {
  id: string; contactName?: string; dateAdded?: string; tags?: string[];
  attributionSource?: Record<string, unknown> | null;
  lastAttributionSource?: Record<string, unknown> | null;
};

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const { evaluateTargetingSet } = await import("@/lib/queue/targeting");
  const sb = createAdminClient();

  const { data: cfg } = await sb
    .from("agent_configs")
    .select("targeting_rules")
    .eq("agent_id", "17860a86-ace9-4299-9328-2452151348a0")
    .single();
  const gate = cfg?.targeting_rules as Parameters<typeof evaluateTargetingSet>[0];
  if (!gate?.groups) { console.error("targeting não é set v2 — rode o apply antes"); process.exit(1); }

  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", LOC).single();
  const client = new GHLClient(loc!.company_id, LOC);
  const res = await client.post<{ contacts?: Contact[]; total?: number }>("/contacts/search", {
    locationId: LOC, pageLimit: 100, sort: [{ field: "dateAdded", direction: "desc" }],
  });
  const contatos = res.contacts || [];

  // Mensagem típica do lead — NÃO é a frase do anúncio, pra medir o pior caso
  // (quem entra só pela atribuição/tag, sem ajuda da folha `message`).
  const MSG_GENERICA = "oi tudo bem?";

  let entram = 0, barrados = 0;
  const porMotivo = new Map<string, number>();
  const amostraEntra: string[] = [];
  const amostraBarrado: string[] = [];

  for (const c of contatos) {
    const ok = evaluateTargetingSet(gate, c as never, [], { messageText: MSG_GENERICA });
    const ss = String((c.attributionSource as Record<string, unknown>)?.sessionSource || "(vazio)");
    const tags = (c.tags || []).map((t) => t.toLowerCase());
    const excluida = ["client", "cliente", "contato pessoal", "pessoal bia", "membro da agencia", "ia-desligada"]
      .find((t) => tags.includes(t));
    if (ok) {
      entram++;
      if (amostraEntra.length < 5) amostraEntra.push(`${(c.contactName || "?").slice(0, 20)} · ${ss} · tags[${tags.slice(0, 3)}]`);
    } else {
      barrados++;
      const motivo = excluida ? `EXCLUÍDO por tag "${excluida}"` : `origem "${ss}" não é paga`;
      porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + 1);
      if (amostraBarrado.length < 5) amostraBarrado.push(`${(c.contactName || "?").slice(0, 20)} · ${motivo}`);
    }
  }

  console.log(`=== SIMULAÇÃO DO GATE (${contatos.length} contatos recentes, msg genérica "${MSG_GENERICA}") ===\n`);
  console.log(`  ATENDIDOS: ${entram}  (${((entram / contatos.length) * 100).toFixed(0)}%)`);
  console.log(`  BARRADOS:  ${barrados}  (${((barrados / contatos.length) * 100).toFixed(0)}%)\n`);
  console.log("--- motivos de barrar ---");
  [...porMotivo.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, n]) => console.log(`  ${String(n).padStart(3)}  ${m}`));
  console.log("\n--- amostra ATENDIDOS ---");
  amostraEntra.forEach((s) => console.log(`  ✅ ${s}`));
  console.log("\n--- amostra BARRADOS ---");
  amostraBarrado.forEach((s) => console.log(`  ⛔ ${s}`));

  // Prova de segurança: NENHUM contato com tag de cliente/pessoal pode passar.
  const vazamento = contatos.filter((c) => {
    const tags = (c.tags || []).map((t) => t.toLowerCase());
    const temExcluida = ["client", "cliente", "contato pessoal", "pessoal bia", "membro da agencia"].some((t) => tags.includes(t));
    return temExcluida && evaluateTargetingSet(gate, c as never, [], { messageText: MSG_GENERICA });
  });
  console.log(`\n=== TRAVA DE SEGURANÇA ===`);
  console.log(vazamento.length === 0
    ? "✅ zero contatos de cliente/pessoal/agência passariam o gate"
    : `❌ VAZAMENTO: ${vazamento.length} — ${vazamento.map((c) => c.contactName).join(", ")}`);
  process.exit(vazamento.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
