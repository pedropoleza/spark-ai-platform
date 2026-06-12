/**
 * Importa leads do quiosque de demonstração (demo_leads) como contatos no Spark Leads.
 *
 * Uso:
 *   npx tsx -r tsconfig-paths/register scripts/import-demo-leads.ts <locationId> [opções]
 *
 * opções:
 *   --company=<id>   companyId GHL (default: resolve da tabela agents pela location)
 *   --tag=<tag>      tag aplicada nos contatos (default: convencao-2026)
 *   --dry-run        só lista o que importaria, sem escrever nada
 *   --list           lista os leads pendentes e sai
 *
 * Comportamento:
 *   - Lê demo_leads com imported_at IS NULL (mais antigos primeiro)
 *   - upsertContact no Spark Leads (dedup por phone fica do lado do CRM)
 *   - Marca imported_at + import_ref (contact_id) — re-rodar é idempotente
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createServerClient } from "../src/lib/supabase/server";
import { GHLClient } from "../src/lib/ghl/client";
import { upsertContact } from "../src/lib/ghl/operations";

interface DemoLead {
  id: string;
  nome: string;
  whatsapp_raw: string;
  whatsapp_e164: string | null;
  agencia: string;
  source: string;
  created_at: string;
}

async function main() {
  const args = process.argv.slice(2);
  const locationId = args.find((a) => !a.startsWith("--"));
  const companyArg = args.find((a) => a.startsWith("--company="))?.split("=")[1];
  const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] || "convencao-2026";
  const dryRun = args.includes("--dry-run");
  const listOnly = args.includes("--list");

  if (!locationId) {
    console.error("Uso: npx tsx -r tsconfig-paths/register scripts/import-demo-leads.ts <locationId> [--company=<id>] [--tag=<tag>] [--dry-run] [--list]");
    process.exit(1);
  }

  const supabase = createServerClient();

  const { data: leads, error } = await supabase
    .from("demo_leads")
    .select("id, nome, whatsapp_raw, whatsapp_e164, agencia, source, created_at")
    .is("imported_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Erro lendo demo_leads:", error.message);
    process.exit(1);
  }

  const pending = (leads || []) as DemoLead[];
  console.log(`\n${pending.length} lead(s) pendente(s) de importação.\n`);
  for (const l of pending) {
    console.log(`  • ${l.nome} — ${l.whatsapp_e164 || l.whatsapp_raw} — ${l.agencia} (${l.created_at})`);
  }
  if (listOnly || pending.length === 0) return;

  // Resolve companyId: flag > tabela agents da location
  let companyId = companyArg;
  if (!companyId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("company_id")
      .eq("location_id", locationId)
      .not("company_id", "is", null)
      .limit(1)
      .maybeSingle();
    companyId = (agent as { company_id?: string } | null)?.company_id;
  }
  if (!companyId) {
    console.error("\nNão achei company_id pra essa location na tabela agents. Passa --company=<id>.");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n[dry-run] Importaria ${pending.length} contato(s) pra location ${locationId} (company ${companyId}) com tag "${tag}". Nada foi escrito.`);
    return;
  }

  const client = new GHLClient(companyId, locationId);
  let ok = 0;
  let fail = 0;

  for (const lead of pending) {
    const parts = lead.nome.trim().split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(" ") || undefined;
    try {
      const res = await upsertContact(client, {
        locationId,
        firstName,
        lastName,
        name: lead.nome,
        phone: lead.whatsapp_e164 || lead.whatsapp_raw,
        companyName: lead.agencia,
        tags: [tag, "demo-quiosque"],
        source: "Demo Convenção (quiosque)",
      });
      const contactId = res.contact?.id || null;
      const { error: upErr } = await supabase
        .from("demo_leads")
        .update({ imported_at: new Date().toISOString(), import_ref: contactId })
        .eq("id", lead.id);
      if (upErr) {
        console.error(`  ✗ ${lead.nome}: contato criado (${contactId}) mas falhou marcar imported_at: ${upErr.message}`);
        fail++;
      } else {
        console.log(`  ✓ ${lead.nome} → contato ${contactId}`);
        ok++;
      }
    } catch (err) {
      console.error(`  ✗ ${lead.nome}: ${err instanceof Error ? err.message : err}`);
      fail++;
    }
  }

  console.log(`\nImportação concluída: ${ok} ok, ${fail} falha(s).`);
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
