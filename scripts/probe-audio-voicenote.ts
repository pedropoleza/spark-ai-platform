/**
 * PROBE Fase 0 do opener de áudio (MC-G, review Marcia 2026-07-28).
 *
 * ⚠️ ENVIA MENSAGENS REAIS via Spark Leads /conversations/messages — rode SÓ
 * com um contato de TESTE seu (ex: seu próprio número cadastrado na location).
 *
 * O que valida (bloqueante pra feature de áudio automático): a location da
 * Marcia usa um conversation provider CUSTOM de marketplace — o rendering de
 * um attachment de áudio como VOICE NOTE (waveform/play inline) é
 * INDETERMINÁVEL por código. Este probe envia:
 *   (a) um .ogg (opus)  — formato nativo de voice note
 *   (b) um .mp3         — formato comum de export
 * e você confere NO APARELHO: virou voice note com waveform? abre e toca?
 * tem selo "encaminhada"? (não deve ter — envio fresh via API não carrega o selo)
 *
 * Uso:
 *   npx tsx scripts/probe-audio-voicenote.ts <LOCATION_ID> <CONTACT_ID> <URL_OGG> [URL_MP3] --yes
 *
 * As URLs devem ser públicas ou assinadas (ex: upload prévio no bucket
 * agent-media via POST /api/media e usar a signed URL).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const [locationId, contactId, oggUrl, maybeMp3] = process.argv.slice(2);
  const confirmed = process.argv.includes("--yes");
  const mp3Url = maybeMp3 && maybeMp3 !== "--yes" ? maybeMp3 : null;
  if (!locationId || !contactId || !oggUrl || !confirmed) {
    console.error("Uso: npx tsx scripts/probe-audio-voicenote.ts <LOCATION_ID> <CONTACT_ID> <URL_OGG> [URL_MP3] --yes");
    console.error("⚠️  Envia mensagens REAIS — use um contato de teste SEU.");
    process.exit(1);
  }

  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", locationId)
    .maybeSingle();
  if (!loc?.company_id) {
    console.error(`Location ${locationId} sem company_id.`);
    process.exit(1);
  }
  const client = new GHLClient(loc.company_id as string, locationId);

  console.log(`\n[1/2] Enviando .ogg (opus) como attachment...`);
  const r1 = await client.post<{ messageId?: string }>("/conversations/messages", {
    type: "SMS",
    contactId,
    message: "",
    attachments: [oggUrl],
  });
  console.log(`  → messageId=${r1?.messageId || "?"}`);

  if (mp3Url) {
    console.log(`[2/2] Enviando .mp3 como attachment...`);
    const r2 = await client.post<{ messageId?: string }>("/conversations/messages", {
      type: "SMS",
      contactId,
      message: "",
      attachments: [mp3Url],
    });
    console.log(`  → messageId=${r2?.messageId || "?"}`);
  }

  console.log(`\n=== AGORA CONFIRA NO APARELHO (WhatsApp do contato de teste) ===`);
  console.log(`1. O .ogg chegou como VOICE NOTE (bolinha com waveform/play)?`);
  console.log(`2. Toca normalmente?`);
  console.log(`3. Tem selo "Encaminhada"? (não deveria)`);
  console.log(`4. O .mp3 (se enviado): chegou como arquivo? toca?`);
  console.log(`\nSe (1)+(2) OK → a feature do opener de áudio pode usar .ogg direto (sem transcode).`);
  console.log(`Se chegou como ARQUIVO comum → decidir: aceitar assim, ou fase 2 (rota direta com ptt=true no provider).`);
  process.exit(0);
}

main();
