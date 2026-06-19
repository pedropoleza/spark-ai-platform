/**
 * Provisiona uma instância Stevo DEDICADA pra uma location (group campaigns, H40).
 *
 * Campanha em grupo SÓ roda em instância `kind='dedicated'` — NUNCA na compartilhada
 * do SparkBot (ban derrubaria o DM de todos os reps). Não há UI pra isso: este
 * script faz o upsert da row em `stevo_instances` com as credenciais do número
 * dedicado que a agência provisionou. NÃO imprime o token.
 *
 * Pré-requisito: ter o número dedicado conectado no painel Stevo (sessão ativa +
 * "enable group view" ligado) e ter em mãos o server_url + instance_token dele.
 *
 * Uso (caso Matheus — location RkFnbOYKJvJfBEaU1ycO):
 *   STEVO_LOCATION_ID=RkFnbOYKJvJfBEaU1ycO \
 *   STEVO_SERVER_URL=https://smv2-3.stevo.chat \
 *   STEVO_INSTANCE_TOKEN=<token do número dedicado> \
 *   STEVO_INSTANCE_NAME="Matheus Curty (dedicado)" \
 *   npx tsx -r tsconfig-paths/register scripts/provision-dedicated-stevo.ts
 *
 * Depois: virar GROUP_CAMPAIGNS_ENABLED=1 (e RECURRING_CAMPAIGNS_ENABLED=1 pro
 * caso recorrente) na Vercel, e o Matheus cria a campanha pelo próprio SparkBot
 * (os gates de termos/spam/dedicada rodam no fluxo do DM).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const locationId = process.env.STEVO_LOCATION_ID?.trim();
  const serverUrl = process.env.STEVO_SERVER_URL?.trim();
  const instanceToken = process.env.STEVO_INSTANCE_TOKEN?.trim();
  const instanceName = process.env.STEVO_INSTANCE_NAME?.trim() || null;

  if (!locationId || !serverUrl || !instanceToken) {
    throw new Error(
      "Faltam env vars: STEVO_LOCATION_ID, STEVO_SERVER_URL, STEVO_INSTANCE_TOKEN (e opcional STEVO_INSTANCE_NAME).",
    );
  }

  const supabase = createAdminClient();

  // Guard: NÃO sobrescrever a instância COMPARTILHADA do SparkBot por engano.
  // Se já existe uma row 'shared' nessa location (= é o hub do SparkBot), aborta.
  const { data: existing } = await supabase
    .from("stevo_instances")
    .select("hub_location_id, kind, instance_name")
    .eq("hub_location_id", locationId)
    .maybeSingle();
  if (existing && existing.kind === "shared") {
    throw new Error(
      `ABORTADO: a location ${locationId} já tem uma instância COMPARTILHADA (${existing.instance_name ?? "?"}). ` +
        `Provisionar dedicada por cima dela derrubaria o canal compartilhado. Use uma location dedicada do rep.`,
    );
  }

  const { error } = await supabase.from("stevo_instances").upsert(
    {
      hub_location_id: locationId,
      server_url: serverUrl,
      instance_token: instanceToken,
      instance_name: instanceName,
      kind: "dedicated",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "hub_location_id" },
  );
  if (error) throw new Error(`upsert falhou: ${error.message}`);

  // Confirma sem imprimir o token (lê a coluna e só reporta presença).
  const { data: confirm } = await supabase
    .from("stevo_instances")
    .select("hub_location_id, kind, instance_name, server_url, instance_token")
    .eq("hub_location_id", locationId)
    .maybeSingle();
  console.log("✅ instância dedicada provisionada:", {
    location: confirm?.hub_location_id,
    kind: confirm?.kind,
    name: confirm?.instance_name,
    server: confirm?.server_url,
    has_token: !!confirm?.instance_token,
  });
  console.log(
    "Próximo: GROUP_CAMPAIGNS_ENABLED=1 (+ RECURRING_CAMPAIGNS_ENABLED=1) na Vercel; depois o rep cria a campanha pelo SparkBot.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
