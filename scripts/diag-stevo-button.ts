// Diagnóstico: por que o sendStevoButton falhou em prod (caiu pro texto)?
// Testa a função REAL com e sem `title` pra ver a resposta do Stevo.
// Roda: npx tsx -r tsconfig-paths/register scripts/diag-stevo-button.ts
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { sendStevoButton } from "@/lib/account-assistant/webhook/stevo-send";

async function main() {
  const sb = createAdminClient();
  const inst = await sb
    .from("stevo_instances")
    .select("server_url, instance_token")
    .limit(1)
    .maybeSingle();
  const sample = await sb
    .from("stevo_webhook_samples")
    .select("body")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const serverUrl = String(inst.data?.server_url || "");
  const apiKey = String(inst.data?.instance_token || "");
  const sender = String(
    (((sample.data?.body as Record<string, unknown>)?.data as Record<string, unknown>)
      ?.Info as Record<string, unknown>)?.Sender || "",
  );
  const number = sender.split("@")[0] || "";

  console.log("base:", serverUrl, "| number:", number, "| key:", apiKey ? "ok" : "FALTA", "\n");

  // Variante A — SEM title (exatamente o que o handler montou no turno do Victor)
  const a = await sendStevoButton({
    serverUrl, apiKey, number,
    body: 'Vou mandar pro Victor Alves: "Oi Victor, tudo bem?" — confirma?',
    buttons: [
      { id: "confirm", label: "Confirmar ✅" },
      { id: "cancel", label: "Cancelar ❌" },
    ],
  });
  console.log("A) SEM title →", JSON.stringify(a));

  await new Promise((r) => setTimeout(r, 1500));

  // Variante B — COM title (como o probe que funcionou)
  const b = await sendStevoButton({
    serverUrl, apiKey, number,
    title: "Confirmação",
    body: 'Vou mandar pro Victor Alves: "Oi Victor, tudo bem?" — confirma?',
    buttons: [
      { id: "confirm", label: "Confirmar ✅" },
      { id: "cancel", label: "Cancelar ❌" },
    ],
  });
  console.log("B) COM title →", JSON.stringify(b));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
