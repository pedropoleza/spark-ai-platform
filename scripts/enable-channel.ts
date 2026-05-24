/**
 * Liga/desliga um CANAL nos agentes lead-facing de uma location (Plataforma
 * Modular — piloto multicanal). Idempotente: preserva os canais existentes,
 * só adiciona/remove o pedido. Seguro: só mexe na location dada.
 *
 * Uso:
 *   npx tsx -r tsconfig-paths/register scripts/enable-channel.ts <locationId> <Channel> [--off]
 *
 * Channel: SMS | WhatsApp | Instagram | Email
 *   --off   remove o canal (em vez de adicionar)
 *
 * Exemplos (Alves Cury):
 *   ... scripts/enable-channel.ts YuR0LCZomFzrfkDK2ezo Instagram
 *   ... scripts/enable-channel.ts YuR0LCZomFzrfkDK2ezo Instagram --off
 *
 * ⚠️ Ligar IG faz os agentes responderem DMs reais de IG autonomamente
 * (igual já fazem no WhatsApp/SMS). Rode quando estiver pronto pra observar.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";

const VALID = ["SMS", "WhatsApp", "Instagram", "Email"];

async function main() {
  const [, , locationId, channelArg] = process.argv;
  const off = process.argv.includes("--off");
  if (!locationId || !channelArg) {
    console.error("Uso: enable-channel.ts <locationId> <Channel> [--off]");
    process.exit(1);
  }
  // normaliza pro casing canônico
  const channel = VALID.find((c) => c.toLowerCase() === channelArg.toLowerCase());
  if (!channel) {
    console.error(`Canal inválido: "${channelArg}". Use: ${VALID.join(" | ")}`);
    process.exit(1);
  }

  const supabase = createAdminClient();
  const { data: agents } = await supabase
    .from("agents")
    .select("id, type, agent_configs(enabled_channels)")
    .eq("location_id", locationId)
    .in("type", ["sales_agent", "recruitment_agent"]);

  if (!agents || agents.length === 0) {
    console.log(`(nenhum agente lead-facing na location ${locationId})`);
    process.exit(0);
  }

  for (const a of agents as Array<{ id: string; type: string; agent_configs: { enabled_channels: string[] | null }[] | { enabled_channels: string[] | null } | null }>) {
    const cfg = Array.isArray(a.agent_configs) ? a.agent_configs[0] : a.agent_configs;
    const current: string[] = cfg?.enabled_channels || ["SMS", "WhatsApp"];
    let next: string[];
    if (off) {
      next = current.filter((c) => c !== channel);
    } else {
      next = current.includes(channel) ? current : [...current, channel];
    }
    if (JSON.stringify(next) === JSON.stringify(current)) {
      console.log(`= ${a.type}: já estava [${current.join(", ")}] (no-op)`);
      continue;
    }
    const { error } = await supabase
      .from("agent_configs")
      .update({ enabled_channels: next, updated_at: new Date().toISOString() })
      .eq("agent_id", a.id);
    if (error) {
      console.error(`❌ ${a.type}: falhou — ${error.message}`);
      continue;
    }
    console.log(`✅ ${a.type}: [${current.join(", ")}] → [${next.join(", ")}]`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
