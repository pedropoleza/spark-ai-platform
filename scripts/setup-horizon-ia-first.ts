/**
 * Setup IA-first da Horizon (Five Star Ricos, jA6uzx6tONyTeocxw4Cj) — reunião 2026-08-03.
 *
 * Fase 1 (probe+upload):
 *  - sobe o áudio de abertura da Marcia pro bucket agent-media + media_library
 *  - lista o calendário (campos de minimum notice pro buffer de 1h)
 *  - lista pipelines/etapas (IDs pro funil Em Contato/Qualified)
 *
 * Rodar: npx tsx scripts/setup-horizon-ia-first.ts [--set-buffer]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOC = "jA6uzx6tONyTeocxw4Cj";
const AGENT_ID = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const CALENDAR_ID = "14aj8DKXZnaj8GRMdmDy";
const AUDIO_PATH =
  "/private/tmp/claude-501/-Users-pedropoleza-SPARK-APPS-AI-platform/fb444e91-ba75-4ad5-a50e-6fe4e65495be/scratchpad/abertura-marcia.ogg";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // 1. Upload do áudio (idempotente: upsert no storage + na tabela)
  const bytes = readFileSync(AUDIO_PATH);
  const storagePath = `${AGENT_ID}/abertura-marcia.ogg`;
  const up = await supabase.storage
    .from("agent-media")
    .upload(storagePath, bytes, { contentType: "audio/ogg", upsert: true });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  console.log(`✅ áudio no bucket: agent-media/${storagePath} (${bytes.length} bytes)`);

  const { data: existing } = await supabase
    .from("media_library")
    .select("id")
    .eq("agent_id", AGENT_ID)
    .eq("storage_path", storagePath)
    .maybeSingle();
  let mediaId = existing?.id as string | undefined;
  if (!mediaId) {
    const ins = await supabase
      .from("media_library")
      .insert({
        agent_id: AGENT_ID,
        location_id: LOC,
        name: "Áudio de abertura — Marcia (benefício em vida)",
        storage_path: storagePath,
        mime_type: "audio/ogg",
        size_bytes: bytes.length,
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(`media_library: ${ins.error.message}`);
    mediaId = ins.data.id;
  }
  console.log(`✅ media_library id: ${mediaId}`);

  // sanity: URL assinada gera?
  const signed = await supabase.storage.from("agent-media").createSignedUrl(storagePath, 600);
  console.log(`✅ signed URL ok: ${signed.data?.signedUrl ? "sim" : "NÃO — " + signed.error?.message}`);

  // 2. Calendário — campos de notice
  const client = new GHLClient(COMPANY, LOC);
  const cal = await client.get<{ calendar?: Record<string, unknown> }>(`/calendars/${CALENDAR_ID}`);
  const c = (cal.calendar ?? cal) as Record<string, unknown>;
  const keys = Object.keys(c).filter((k) => /allow|notice|buffer|slot/i.test(k));
  console.log(`\n📅 calendário ${CALENDAR_ID} (${String(c.name ?? "?")}) — campos de janela:`);
  for (const k of keys) console.log(`   ${k} = ${JSON.stringify(c[k])}`);

  if (process.argv.includes("--set-buffer")) {
    // minimum scheduling notice = 1 hora (buffer pedido na reunião 03/08)
    const body: Record<string, unknown> = { allowBookingAfter: 1, allowBookingAfterUnit: "hours" };
    await client.put(`/calendars/${CALENDAR_ID}`, body);
    const cal2 = await client.get<{ calendar?: Record<string, unknown> }>(`/calendars/${CALENDAR_ID}`);
    const c2 = (cal2.calendar ?? cal2) as Record<string, unknown>;
    console.log(
      `✅ buffer aplicado: allowBookingAfter=${JSON.stringify(c2.allowBookingAfter)} ${JSON.stringify(c2.allowBookingAfterUnit)}`,
    );
  }

  // 3. Pipelines/etapas
  const pipes = await client.get<{ pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> }>(
    "/opportunities/pipelines",
    { locationId: LOC },
  );
  console.log("\n🧭 pipelines:");
  for (const p of pipes.pipelines ?? []) {
    console.log(`  ${p.name} (${p.id})`);
    for (const s of p.stages ?? []) console.log(`     - ${s.name} (${s.id})`);
  }
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
