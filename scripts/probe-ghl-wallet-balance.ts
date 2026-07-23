/**
 * Probe (2026-07-23): o GHL expõe o SALDO da wallet pra leitura? Hoje a gente só
 * REAGE ao erro "insufficient funds" da cobrança — nunca lê o saldo. Se existir um
 * endpoint, dá pra (a) avisar saldo baixo ANTES de zerar (fecha o gap "GHL espera
 * zerar pra recarregar") e (b) auto-limpar bloqueio falso. Testa candidatos
 * read-only numa location recarregada (Marina) e numa bloqueada (Jussara).
 *
 * Rodar: npx tsx scripts/probe-ghl-wallet-balance.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";

const TARGETS = [
  { name: "Marina (recarregada)", loc: "A62s5EQj1hldOuvBEowv" },
  { name: "Jussara (bloqueada)", loc: "pGl5pqLLG0QDixANpFnP" },
];

async function main() {
  const supabase = createAdminClient();
  const appId = process.env.GHL_MARKETPLACE_APP_ID;
  const meterId = process.env.GHL_BILLING_METER_ID;
  console.log(`appId=${appId ? "set" : "MISSING"} meterId=${meterId ? "set" : "MISSING"}\n`);

  for (const t of TARGETS) {
    const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", t.loc).maybeSingle();
    if (!loc?.company_id) { console.log(`${t.name}: sem company_id`); continue; }
    const client = new GHLClient(loc.company_id, t.loc);
    console.log(`\n=== ${t.name} (${t.loc}) ===`);
    // Candidatos de endpoint de saldo (GHL Marketplace/SaaS wallet)
    const candidates: Array<[string, Record<string, string>?]> = [
      [`/marketplace/billing/balance`, { locationId: t.loc, appId: appId || "" }],
      [`/payments/wallet`, { locationId: t.loc }],
      [`/locations/${t.loc}/wallet`],
      [`/saas-api/public-api/locations/${t.loc}/wallet`],
      [`/marketplace/billing/wallet`, { locationId: t.loc, appId: appId || "" }],
    ];
    for (const [path, q] of candidates) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await (client as any).get(path, q);
        console.log(`  ✅ ${path} → ${JSON.stringify(r).slice(0, 200)}`);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.log(`  ✗ ${path} → ${m.slice(0, 90)}`);
      }
    }
  }
}

main().then(() => process.exit(0));
