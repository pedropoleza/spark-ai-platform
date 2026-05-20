// Teste de envio REAL via Stevo (fase 2). Manda UMA mensagem de verdade pro
// número que aparece no último sample capturado (o Pedro). Puxa serverUrl +
// instanceToken do próprio sample (mesma fonte que o handler usa) — não
// hardcoda segredo. Autorizado pelo Pedro ("Sim, confirmo") 2026-05-20.
// Roda: npx tsx -r tsconfig-paths/register scripts/test-stevo-send-live.ts
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { sendStevoText } from "@/lib/account-assistant/webhook/stevo-send";

function mask(s: string): string {
  if (!s) return "(vazio)";
  return s.length <= 8 ? "****" : `${s.slice(0, 6)}…${s.slice(-2)} (${s.length} chars)`;
}

async function main() {
  const sb = createAdminClient();
  const { data } = await sb
    .from("stevo_webhook_samples")
    .select("body")
    .order("received_at", { ascending: false })
    .limit(1);

  const body = (data?.[0]?.body ?? {}) as Record<string, unknown>;
  const serverUrl = String(body.serverUrl || "");
  const apiKey = String(body.instanceToken || "");
  const sender = String(
    ((body.data as Record<string, unknown>)?.Info as Record<string, unknown>)?.Sender || "",
  );
  const number = sender.split("@")[0] || "";

  console.log("=== TESTE DE ENVIO REAL — Stevo /send/text ===");
  console.log("serverUrl:", serverUrl || "(não achei)");
  console.log("apikey:   ", mask(apiKey));
  console.log("número:   ", number || "(não achei)");
  console.log("");

  if (!serverUrl || !apiKey || !number) {
    console.error("❌ faltando serverUrl/apikey/número no sample — abortando.");
    process.exit(1);
  }

  const text =
    "✅ Teste do SparkBot via Stevo (envio fase 2). Se você recebeu isso, o /send/text tá funcionando. Pode ignorar 🙂";

  console.log(`Enviando: "${text}"\n`);
  const r = await sendStevoText({ serverUrl, apiKey, number, text });
  console.log("RESULTADO:", JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
