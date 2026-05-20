// PROBE de viabilidade: manda 1 BOTÃO + 1 LISTA reais pro WhatsApp do Pedro,
// pra confirmar que o Stevo (base Baileys) renderiza interativo e capturar o
// formato do retorno do tap (que vai pro stevo_webhook_samples). Autorizado
// pelo Pedro ("Roda o teste agora") 2026-05-20. NÃO faz parte do build — é
// diagnóstico one-off. Roda:
//   npx tsx -r tsconfig-paths/register scripts/probe-stevo-interactive.ts
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";

async function post(base: string, apiKey: string, path: string, payload: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, body: text.slice(0, 600) };
}

async function main() {
  const sb = createAdminClient();
  // serverUrl + token do hub seedado; number do último sample (Pedro).
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

  const base = String(inst.data?.server_url || "");
  const apiKey = String(inst.data?.instance_token || "");
  const sender = String(
    (((sample.data?.body as Record<string, unknown>)?.data as Record<string, unknown>)
      ?.Info as Record<string, unknown>)?.Sender || "",
  );
  const number = sender.split("@")[0] || "";

  console.log("=== PROBE interativo Stevo ===");
  console.log("base:", base, "| number:", number, "| apikey:", apiKey ? "ok" : "FALTA");
  if (!base || !apiKey || !number) {
    console.error("❌ falta base/apikey/number");
    process.exit(1);
  }

  // 1) BOTÃO (quick-reply). type:"reply" é o palpite padrão Baileys.
  const buttonPayload = {
    number,
    title: "SparkBot — teste de botão",
    description: "Isso é um teste de viabilidade dos botões. Toca numa opção 👇",
    footer: "SparkBot",
    buttons: [
      { displayText: "Confirmar ✅", id: "probe_confirm", type: "reply" },
      { displayText: "Cancelar ❌", id: "probe_cancel", type: "reply" },
    ],
  };
  console.log("\n--- POST /send/button ---");
  console.log(JSON.stringify(await post(base, apiKey, "/send/button", buttonPayload), null, 2));

  await new Promise((r) => setTimeout(r, 1500));

  // 2) LISTA
  const listPayload = {
    number,
    title: "SparkBot — teste de lista",
    description: "Isso é um teste de viabilidade das listas. Abre e seleciona 👇",
    footerText: "SparkBot",
    buttonText: "Ver opções",
    sections: [
      {
        title: "Exemplo",
        rows: [
          { rowId: "opt_1", title: "Opção 1", description: "primeira opção" },
          { rowId: "opt_2", title: "Opção 2", description: "segunda opção" },
          { rowId: "opt_3", title: "Opção 3", description: "terceira opção" },
        ],
      },
    ],
  };
  console.log("\n--- POST /send/list ---");
  console.log(JSON.stringify(await post(base, apiKey, "/send/list", listPayload), null, 2));

  console.log(
    "\n✅ enviados. Pedro: toca no BOTÃO e seleciona uma opção da LISTA — o retorno cai em stevo_webhook_samples e eu leio o formato.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
