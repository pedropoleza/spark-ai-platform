import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { extractMediaAttachments } from "@/lib/ai/media-extractor";
import { validateExternalUrl } from "@/lib/utils/url-allowlist";

const REAL_BODY = {
  type: "InboundMessage",
  messageType: "Custom",
  messageTypeId: 20,
  messageTypeString: "TYPE_CUSTOM_SMS",
  body: "",
  contentType: "text/plain",
  attachments: [
    "https://hel1.your-objectstorage.com/stevo/whatsapp/media/document/sparkbot/1779238378396-Untitled%20spreadsheet%20-%20Sheet1%20(2)_1779238378395.csv",
  ],
  contactId: "61ZDGmCxZW0V2OODGcHo",
  locationId: "RBFxlEQZobaDjlF2i5px",
};

async function main() {
  console.log("=== 1. extractMediaAttachments ===");
  const atts = extractMediaAttachments(REAL_BODY as Record<string, unknown>);
  console.log("Result:", JSON.stringify(atts, null, 2));

  if (atts.length === 0) {
    console.log("❌ FALHOU AQUI: extractMediaAttachments retornou vazio");
    return;
  }

  console.log("\n=== 2. validateExternalUrl (SSRF) ===");
  const v = validateExternalUrl(atts[0].url);
  console.log("Result:", JSON.stringify(v));
  if (!v.ok) {
    console.log("❌ FALHOU AQUI: SSRF guard rejeitou");
    return;
  }

  console.log("\n=== 3. fetch ===");
  try {
    const res = await fetch(atts[0].url, { signal: AbortSignal.timeout(20000) });
    console.log("HTTP", res.status, res.headers.get("content-type"));
    if (!res.ok) {
      console.log("❌ FALHOU AQUI: fetch não-ok");
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log("Buffer size:", buf.length, "bytes");
    console.log("Preview:", buf.toString("utf8").slice(0, 200));

    console.log("\n=== 4. processFile ===");
    const { processFile } = await import("@/lib/account-assistant/file-processor");
    const result = await processFile({ buffer: buf, mime: atts[0].contentType, filename: atts[0].fileName || "arquivo.csv" });
    console.log("repInput.kind:", result.repInput.kind);
    if (result.repInput.kind === "tabular") {
      console.log("✅ tabular rows:", result.repInput.tabular.total_rows);
      console.log("headers:", JSON.stringify(result.repInput.tabular.rows?.[0] || result.repInput.tabular));
    }
  } catch (e) {
    console.log("❌ FALHOU AQUI (fetch/process):", e instanceof Error ? e.message : e);
  }
}
main();
