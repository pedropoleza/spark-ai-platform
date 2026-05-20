// Prova LOCAL do recebimento Stevo: pega os samples REAIS capturados em
// stevo_webhook_samples, roda parseStevoWebhook + file-processor, e mostra o
// que o bot "lê". Não envia nada, não gasta token (pula transcrição de áudio).
// Roda: npx tsx -r tsconfig-paths/register scripts/prove-stevo-recebimento.ts
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { parseStevoWebhook } from "@/lib/account-assistant/webhook/stevo-parser";
import { processFile } from "@/lib/account-assistant/file-processor";

async function main() {
  const sb = createAdminClient();
  const { data } = await sb
    .from("stevo_webhook_samples")
    .select("body, received_at")
    .order("received_at", { ascending: false })
    .limit(12);

  console.log("=== PROVA — recebimento Stevo lendo os samples reais ===\n");
  for (const row of (data ?? []).reverse()) {
    const parsed = parseStevoWebhook((row as { body: unknown }).body);
    if (!parsed) {
      console.log("· (sample ignorado pelo parser — fromMe/grupo/status)\n");
      continue;
    }
    console.log(`▸ ${parsed.kind.toUpperCase()} — de ${parsed.pushName || "?"} (${parsed.phone}) — msgId ${parsed.messageId.slice(0, 12)}`);
    if (parsed.kind === "text") {
      console.log(`  texto: "${parsed.text}"`);
    } else if (parsed.kind === "document" || parsed.kind === "image") {
      const buf = Buffer.from(parsed.base64, "base64");
      const fileName = parsed.kind === "document" ? parsed.fileName : "(imagem)";
      try {
        const res = await processFile({ buffer: buf, mime: parsed.mimetype, filename: fileName || "arquivo" });
        const ri = res.repInput as Record<string, unknown>;
        console.log(`  arquivo: "${fileName}" ${parsed.mimetype} ${buf.length}B → repInput.kind=${ri.kind}`);
        if (ri.kind === "tabular") {
          const tab = (ri.tabular as Record<string, unknown>) || {};
          const rows = (tab.rows as unknown[]) || [];
          console.log(`  → ${tab.total_rows ?? rows.length} linhas | colunas: ${JSON.stringify(tab.columns ?? [])}`);
          console.log(`  → amostra: ${JSON.stringify(rows.slice(0, 1))}`);
        } else if (ri.kind === "image") {
          console.log(`  → imagem decodificada, pronta pro Claude vision`);
        } else if (ri.kind === "document") {
          console.log(`  → texto extraído (150 chars): ${String(ri.extracted_text || "").slice(0, 150)}`);
        }
      } catch (e) {
        console.log(`  ❌ processFile falhou: ${e instanceof Error ? e.message : e}`);
      }
    } else if (parsed.kind === "audio") {
      const buf = Buffer.from(parsed.base64, "base64");
      console.log(`  áudio: ${parsed.mimetype} ${parsed.seconds}s ${buf.length}B (transcrição via Whisper no handler — pulada aqui)`);
    }
    console.log("");
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
