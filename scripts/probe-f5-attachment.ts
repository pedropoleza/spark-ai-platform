/**
 * PROBE F5 — anexo nativo no WhatsApp (Pedro 2026-06-21, alvo: o próprio número dele).
 *
 * Responde a pergunta empírica que NÃO dá pra resolver lendo código: quando o
 * SparkBot manda /conversations/messages com attachments:[signedUrl] (type SMS →
 * Stevo roteia pro WhatsApp), o PDF chega como ARQUIVO NATIVO ou só como link/texto?
 *
 * Desenho corrigido pós verificação adversarial (workflow f5-probe-preflight):
 *  - contato HARDCODED da hub + assert de identidade/telefone ANTES de enviar
 *  - curl/fetch externo na signed URL (isola "bucket privado não-buscável" de
 *    "WhatsApp não suporta anexo")
 *  - TTL 24h (tira expiração da jogada)
 *  - 2 mensagens DISCRIMINANTES:
 *      A = caption-marcador SEM link, PDF só no attachments → isola o anexo nativo
 *      B = réplica fiel do F5 (link no corpo + attachments) → realidade de produção
 *  - loga a resposta crua do GHL
 *
 * Uso:
 *   DRY-RUN (não envia):  npx tsx -r tsconfig-paths/register scripts/probe-f5-attachment.ts
 *   ENVIA de verdade:     CONFIRM_SEND=1 npx tsx -r tsconfig-paths/register scripts/probe-f5-attachment.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "../src/lib/ghl/client";
import { renderFlowPdf } from "../src/lib/account-assistant/task-orchestrator/flow-pdf";
import { createAdminClient } from "../src/lib/supabase/admin";
import { sendMediaToContact } from "../src/lib/ghl/operations";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const HUB_LOC = "RBFxlEQZobaDjlF2i5px"; // Sparkbot WhatsApp Hub (account_assistant ativo + instância Stevo)
const CONTACT = "61ZDGmCxZW0V2OODGcHo"; // "pedro poleza" +17867717077 NA hub
const TARGET_DIGITS = "7867717077"; // sufixo esperado do telefone (assert anti contato-errado)

function digits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

async function send(client: GHLClient, label: string, caption: string, url: string) {
  try {
    const r = await sendMediaToContact(client, CONTACT, url, caption, "SMS");
    console.log(`  ${label} → ENVIADO. resposta GHL:`, JSON.stringify(r));
    return true;
  } catch (e: unknown) {
    const err = e as { message?: string; response?: { status?: number; data?: unknown } };
    console.error(`  ${label} → FALHOU:`, err?.message, "| status:", err?.response?.status, "| body:", JSON.stringify(err?.response?.data));
    return false;
  }
}

async function main() {
  const willSend = process.env.CONFIRM_SEND === "1";
  console.log(`=== PROBE F5 — anexo nativo (${willSend ? "ENVIO REAL" : "DRY-RUN"}) ===\n`);

  const client = new GHLClient(COMPANY, HUB_LOC);

  // 1) Identidade do contato ANTES de qualquer envio (anti contato-errado / sem-phone)
  const raw = await client.get<{ contact?: Record<string, unknown> }>(`/contacts/${CONTACT}`);
  const c = (raw?.contact || raw) as Record<string, unknown>;
  const phone = c?.phone as string | undefined;
  console.log("Contato resolvido:", c?.id, "|", c?.firstName, c?.lastName, "| phone:", phone, "| loc:", c?.locationId);
  if (!phone) { console.error("ABORTA: contato sem telefone — SMS/WhatsApp não teria destino."); process.exit(1); }
  if (!digits(phone).endsWith(TARGET_DIGITS)) { console.error("ABORTA: telefone do contato não bate com o alvo:", phone); process.exit(1); }

  // 2) Gera o PDF de teste (mesma renderização do F4)
  const snapshot = {
    draft_id: "probe-f5",
    kind: "file_export",
    status: "ready_for_review",
    title: "SparkBot — Teste de envio de arquivo (PDF)",
    target: { contact_id: CONTACT, contact_name: "Pedro (teste)", contact_phone: "+1" + TARGET_DIGITS },
    step_count: 2,
    cap: 60,
    steps: [
      { n: 1, day_label: "Dia 0", offset_days: 0, send_time: "09:00", intra_day_delay_s: 0, message_text: "Este e um PDF de teste gerado pelo SparkBot para validar o envio de arquivos no WhatsApp.", has_media: false, media_url: null, media_type: null, condition: null },
      { n: 2, day_label: "Dia 2", offset_days: 2, send_time: "09:00", intra_day_delay_s: 0, message_text: "Se voce esta lendo isto DENTRO de um arquivo PDF anexado, o anexo nativo funciona. Acentuacao PT-BR: ção, ã, é, ô.", has_media: false, media_url: null, media_type: null, condition: null },
    ],
    whats_missing: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const bytes = await renderFlowPdf(snapshot);
  console.log("PDF gerado:", bytes.length, "bytes");

  // 3) Upload no bucket agent-media + signed URL TTL 24h
  const supabase = createAdminClient();
  const path = `${HUB_LOC}/probe-f5/${crypto.randomUUID()}.pdf`;
  const up = await supabase.storage.from("agent-media").upload(path, Buffer.from(bytes), { contentType: "application/pdf", upsert: false });
  if (up.error) { console.error("ABORTA upload:", up.error.message); process.exit(1); }
  const TTL = 86400; // 24h — remove expiração como variável confusora
  const signed = await supabase.storage.from("agent-media").createSignedUrl(path, TTL);
  if (signed.error || !signed.data?.signedUrl) { console.error("ABORTA signed url:", signed.error?.message); process.exit(1); }
  const url = signed.data.signedUrl;
  console.log("Signed URL (TTL 24h):", url.slice(0, 90) + "...");

  // 4) Fetchability (must-fix): o servidor do GHL precisa CONSEGUIR baixar essa URL.
  //    Signed URL do Supabase é bearer-na-URL (não exige auth header), então um GET
  //    simples prova que qualquer fetcher externo consegue baixar.
  const res = await fetch(url);
  const fetched = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type");
  console.log("Fetch externo da URL:", res.status, "| content-type:", ct, "| bytes:", fetched.length, "| bate com upload:", fetched.length === bytes.length);
  if (res.status !== 200 || fetched.length !== bytes.length) { console.error("ABORTA: signed URL não é buscável corretamente — anexo nativo falharia por fetchabilidade."); process.exit(1); }

  // 5) Envio (gated por CONFIRM_SEND pra não disparar por acidente)
  if (!willSend) {
    await supabase.storage.from("agent-media").remove([path]); // dry-run não deixa lixo
    console.log("\n[DRY-RUN OK] cadeia inteira validada (gera PDF → upload → URL buscável). Nada foi enviado.");
    console.log("Rode com CONFIRM_SEND=1 pra disparar as 2 mensagens de teste pro WhatsApp.");
    return;
  }

  console.log("\nEnviando as 2 mensagens discriminantes...");
  // A — caption marcador SEM link; PDF SÓ no attachments → isola o anexo nativo
  const okA = await send(client, "Probe A (so anexo)", "TESTE SPARK A: voce recebeu este PDF como ARQUIVO anexado? (de proposito NAO coloquei link nesta mensagem)", url);
  // B — réplica fiel do F5: link no corpo + attachments → realidade de producao
  const okB = await send(client, "Probe B (replica F5)", "TESTE SPARK B: replica do envio real do SparkBot (link no texto como fallback):\n" + url, url);

  console.log(`\n=== Probe disparado (A=${okA ? "ok" : "falha"}, B=${okB ? "ok" : "falha"}) ===`);
  console.log("Confira no WhatsApp e me diga:");
  console.log("  • A chegou como ARQUIVO PDF abrível? (sem link na msg)");
  console.log("  • B chegou como arquivo + link, só link, ou só texto?");
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
