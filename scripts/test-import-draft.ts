/**
 * Smoke do import-draft (H49 Onda 2, 2026-07-10): save → load → created → preview
 * → load, contra o banco REAL, com rep descartável (deletado no fim; CASCADE limpa
 * o draft). Roda: npx tsx -r tsconfig-paths/register scripts/test-import-draft.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import {
  saveImportDraft,
  loadImportDraft,
  setImportDraftCreated,
  setImportDraftPreview,
} from "../src/lib/account-assistant/import-draft";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .insert({ phone: "+10000000002", display_name: "__test_import_draft__" })
    .select("id")
    .single();
  if (error || !rep) throw new Error("não criou rep de teste: " + error?.message);
  const repId = rep.id as string;

  try {
    // 1. save
    const rows = [
      { Nome: "Barbara Silva", Telefone: "+1 555 000 1111" },
      { Nome: "Edson Souza", Telefone: "+1 555 000 2222" },
    ];
    const draftId = await saveImportDraft(repId, "LOC_TEST", {
      filename: "lista-teste.xlsx", columns: ["Nome", "Telefone"], total_rows: 2, rows,
    });
    ok("save devolve draft_id", !!draftId);

    // 2. load (fallback sem anexo)
    const d1 = await loadImportDraft(repId);
    ok("load acha o draft", !!d1 && d1.filename === "lista-teste.xlsx");
    ok("load traz os rows", !!d1 && d1.rows.length === 2 && (d1.rows[0] as Record<string, unknown>).Nome === "Barbara Silva");
    ok("sem created antes do import", !!d1 && !d1.created?.length);

    // 3. created (pós-import)
    await setImportDraftCreated(draftId!, [
      { id: "ghl_A", name: "Barbara Silva", phone: "+15550001111", email: null },
      { id: "ghl_B", name: "Edson Souza", phone: "+15550002222", email: null },
    ]);
    const d2 = await loadImportDraft(repId);
    ok("created persistido", d2?.created?.length === 2 && d2.created[0].id === "ghl_A");

    // 4. preview guard
    await setImportDraftPreview(draftId!, ["Oi {first_name}, texto aprovado!"]);
    const d3 = await loadImportDraft(repId);
    ok("last_preview persistido", d3?.last_preview?.templates[0] === "Oi {first_name}, texto aprovado!");
    ok("created SOBREVIVE ao patch do preview", d3?.created?.length === 2);

    // 5. re-save (planilha NOVA) zera created/preview
    await saveImportDraft(repId, "LOC_TEST", {
      filename: "lista-v2.xlsx", columns: ["Nome"], total_rows: 1, rows: [{ Nome: "X" }],
    });
    const d4 = await loadImportDraft(repId);
    ok("planilha nova zera created/preview", !!d4 && d4.filename === "lista-v2.xlsx" && !d4.created?.length && !d4.last_preview);
  } finally {
    await supabase.from("rep_identities").delete().eq("id", repId); // CASCADE limpa o draft
  }

  console.log(`\n${pass}/${pass + fail} OK`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
