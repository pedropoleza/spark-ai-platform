/**
 * Webhook de RECEBIMENTO do Stevo (canal WhatsApp direto).
 *
 * Pedro 2026-05-20: mudança de fluxo — recebimento passa a vir do Stevo DIRETO
 * (o webhook do GHL vira fallback). Envio também migrará pra API do Stevo.
 *
 * ⚠️ FASE 1 — CAPTURA: por enquanto este endpoint SÓ registra o body cru de
 * cada webhook na tabela `stevo_webhook_samples`, pra a gente ver o formato
 * exato (texto / arquivo / áudio / imagem) ANTES de implementar o parsing e o
 * roteamento pro `handleAssistantInbound`. Responde 200 na hora pro Stevo não
 * retentar. NÃO processa nem responde mensagens ainda.
 *
 * FASE 2 (próxima): adaptar o body do Stevo → args do handler + validar secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let bodyText = "";
  try {
    bodyText = await req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = { _raw: bodyText };
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      // não captura Authorization/cookies pra não logar secret
      if (!/authorization|cookie/i.test(k)) headers[k] = v;
    });

    const supabase = createAdminClient();
    await supabase.from("stevo_webhook_samples").insert({
      body: (typeof parsed === "object" && parsed) ? (parsed as Record<string, unknown>) : { _raw: bodyText },
      headers,
    });
    console.log("[stevo-webhook] captured:", bodyText.slice(0, 3000));
  } catch (err) {
    console.error(
      "[stevo-webhook] capture failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
  // SEMPRE 200 — fase de captura não deve fazer o Stevo retentar.
  return NextResponse.json({ ok: true, phase: "capture" });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "stevo-inbound-capture" });
}
