/**
 * Bianca / Five Rings — liga o aviso do H83 nos DOIS agentes, apontando pro
 * WhatsApp da Sofia (+1 754 971-5189), que é quem cuida do atendimento.
 *
 * Avisa quando: o turno estoura (lead sem resposta), o envio falha (a IA
 * respondeu e não chegou) ou a IA se pausa sozinha por erro.
 * NÃO avisa em handed_off (é do H85) nem em auto-pause por humano (já tem
 * aviso próprio) — sairia em dobro.
 *
 *   npx tsx scripts/apply-bianca-alertas.ts [--revert] [--dry]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const AGENTES = [
  { id: "17860a86-ace9-4299-9328-2452151348a0", nome: "Tráfego Pago" },
  { id: "47cdcb0d-5840-4ae4-bc8b-b60e70870b50", nome: "Novos Seguidores" },
];
const FONE_SOFIA = "+17549715189";
const REVERT = process.argv.includes("--revert");
const DRY = process.argv.includes("--dry");

async function main() {
  const sb = createAdminClient();

  // O destinatário TEM que existir em rep_identities — é como o SparkBot endereça.
  const { data: rep } = await sb
    .from("rep_identities")
    .select("id, display_name, phone, last_inbound_at")
    .eq("phone", FONE_SOFIA)
    .maybeSingle();
  console.log(`destinatário: ${rep ? `${rep.display_name} (${rep.id})` : "❌ NÃO CADASTRADO"}`);
  if (!rep) { console.error("sem rep pra esse telefone — abortando"); process.exit(1); }

  // Opt-in de WhatsApp: sem 1 inbound com channel='whatsapp', o aviso fica só no painel.
  const { count: optin } = await sb
    .from("sparkbot_messages")
    .select("id", { count: "exact", head: true })
    .eq("rep_id", rep.id).eq("role", "user").eq("channel", "whatsapp");
  const temOptIn = (optin ?? 0) > 0;
  console.log(`opt-in de WhatsApp: ${temOptIn ? "✅ tem" : "⚠️  NÃO tem — aviso cai só no painel até ela mandar um 'oi' pro SparkBot"}`);

  for (const ag of AGENTES) {
    const { data: cfg } = await sb.from("agent_configs").select("notifications").eq("agent_id", ag.id).single();
    const atual = (cfg?.notifications || {}) as Record<string, unknown>;
    const novo = REVERT
      ? { ...atual, alerta_whatsapp: undefined }
      : { ...atual, alerta_whatsapp: { enabled: true, phone: FONE_SOFIA, motivos: ["turno_falhou", "envio_falhou", "ia_pausada"] } };
    if (DRY) { console.log(`(dry) ${ag.nome}: ${JSON.stringify(novo.alerta_whatsapp)}`); continue; }
    const { error } = await sb.from("agent_configs")
      .update({ notifications: novo, updated_at: new Date().toISOString() }).eq("agent_id", ag.id);
    if (error) { console.error(`❌ ${ag.nome}:`, error.message); process.exit(1); }
    const { data: check } = await sb.from("agent_configs").select("notifications").eq("agent_id", ag.id).single();
    const a = (check?.notifications as { alerta_whatsapp?: { enabled?: boolean; phone?: string } })?.alerta_whatsapp;
    console.log(`${REVERT ? (a ? "❌" : "↩️ ") : (a?.enabled && a.phone === FONE_SOFIA ? "✅" : "❌")} ${ag.nome}: ${JSON.stringify(a) || "removido"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
