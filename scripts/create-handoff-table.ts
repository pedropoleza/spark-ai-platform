/**
 * Tenta criar handoff_notifications via Supabase Management API.
 * Se falhar, instrui Pedro a rodar manualmente.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const SQL = `
CREATE TABLE IF NOT EXISTS handoff_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  rep_id UUID REFERENCES rep_identities(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  trigger_message TEXT,
  sparkbot_message_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handoff_notif_recent ON handoff_notifications (location_id, contact_id, reason, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_notif_rep ON handoff_notifications (rep_id, created_at DESC);
COMMENT ON TABLE handoff_notifications IS 'F37: notificações que o bot lead-facing manda pro rep humano via SparkBot.';
`;

async function main() {
  // Tentativa 1: pgmeta endpoint (precisa Management API token, não service key)
  const pat = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_MGMT_TOKEN;
  if (pat) {
    const projectRef = "jqhoetjsrhpfvbusxqnv";
    const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: SQL }),
      });
      console.log(`pgmeta status: ${res.status}`);
      console.log(`pgmeta resp: ${(await res.text()).slice(0, 500)}`);
      if (res.ok) {
        console.log("✅ Tabela criada via Management API");
        return;
      }
    } catch (e) {
      console.log(`pgmeta erro: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    console.log("Sem SUPABASE_ACCESS_TOKEN/SUPABASE_MGMT_TOKEN.");
  }

  console.log("\n❌ Não posso criar via API. Cola isso no SQL Editor do Supabase:");
  console.log("   https://supabase.com/dashboard/project/jqhoetjsrhpfvbusxqnv/sql/new\n");
  console.log(SQL);
}
main();
