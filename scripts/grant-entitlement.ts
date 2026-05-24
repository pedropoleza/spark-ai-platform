/**
 * Liberação MANUAL de módulo pago pra uma location (Plataforma Modular, D6).
 * UI admin vem na Fase 3 — por ora é por aqui.
 *
 * Uso:
 *   npx tsx -r tsconfig-paths/register scripts/grant-entitlement.ts <locationId> <capability> [opções]
 *
 * capability: sales_agent | recruitment_agent | custom_agent
 * opções:
 *   --revoke           revoga (em vez de liberar)
 *   --expires=<ISO>    expira em (ex: 2026-12-31T00:00:00Z) — agente temporário/trial
 *   --by=<nome>        quem liberou (default: "cli")
 *   --notes="..."      observação
 *   --list             só lista os entitlements da location e sai
 *
 * Exemplos:
 *   ... scripts/grant-entitlement.ts efZEjK6P... sales_agent --by=pedro
 *   ... scripts/grant-entitlement.ts efZEjK6P... custom_agent --expires=2026-07-01T00:00:00Z
 *   ... scripts/grant-entitlement.ts efZEjK6P... sales_agent --revoke
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import {
  grantEntitlement,
  revokeEntitlement,
  listEntitlements,
} from "../src/lib/repositories/agent-platform.repo";
import type { AgentCapability } from "../src/types/agent-platform";

const VALID: AgentCapability[] = ["sales_agent", "recruitment_agent", "custom_agent"];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const [, , locationId, capabilityArg] = process.argv;
  if (!locationId) {
    console.error("Faltou <locationId>. Veja o cabeçalho do script pra uso.");
    process.exit(1);
  }

  if (flag("list")) {
    const ents = await listEntitlements(locationId);
    console.log(`Entitlements da location ${locationId}:`);
    if (ents.length === 0) console.log("  (nenhum)");
    for (const e of ents) {
      console.log(
        `  - ${e.capability} [${e.status}] source=${e.source} by=${e.granted_by || "?"}` +
          `${e.expires_at ? ` expira=${e.expires_at}` : ""}`,
      );
    }
    process.exit(0);
  }

  const capability = capabilityArg as AgentCapability;
  if (!VALID.includes(capability)) {
    console.error(`capability inválida: "${capabilityArg}". Use: ${VALID.join(" | ")}`);
    process.exit(1);
  }

  const by = arg("by") || "cli";

  if (flag("revoke")) {
    const ok = await revokeEntitlement(locationId, capability, by);
    console.log(ok ? `✅ Revogado ${capability} de ${locationId}.` : `(nada ativo pra revogar)`);
    process.exit(0);
  }

  const ent = await grantEntitlement({
    locationId,
    capability,
    grantedBy: by,
    expiresAt: arg("expires") || null,
    notes: arg("notes") || null,
  });
  console.log(
    `✅ Liberado ${capability} pra ${locationId} (por ${by})` +
      `${ent.expires_at ? `, expira ${ent.expires_at}` : ""}.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
