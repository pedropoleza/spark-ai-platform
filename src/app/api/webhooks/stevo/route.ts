/**
 * Webhook de RECEBIMENTO do Stevo (canal WhatsApp direto).
 *
 * Pedro 2026-05-20: mudança de fluxo — recebimento passa a vir do Stevo DIRETO
 * (o webhook do GHL vira fallback). Envio também migrará pra API do Stevo.
 *
 * FASE 2 — HANDLER: além de capturar o body cru em `stevo_webhook_samples`
 * (mantido pra diagnóstico/auditoria), este endpoint agora:
 *   1. Valida o `instanceToken` contra STEVO_INSTANCE_TOKEN (se a env estiver
 *      setada; durante o setup, sem env, só loga warn e segue — não bloqueia).
 *   2. Parseia o body via parseStevoWebhook (puro).
 *   3. Se válido, dispara handleStevoInbound em background (waitUntil) — mesmo
 *      padrão do webhook GHL (/api/webhooks/inbound-message).
 *   4. Responde 200 SEMPRE — o Stevo não deve retentar.
 *
 * ⚠️ O envio da resposta via Stevo ainda NÃO está ligado (fase 1 do handler):
 * só processamos + persistimos. Ver TODO em stevo-handler.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseStevoWebhook } from "@/lib/account-assistant/webhook/stevo-parser";
import { reportError } from "@/lib/admin-signals/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let bodyText = "";
  let parsedJson: unknown = null;
  try {
    bodyText = await req.text();
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      parsedJson = { _raw: bodyText };
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      // não captura Authorization/cookies pra não logar secret
      if (!/authorization|cookie/i.test(k)) headers[k] = v;
    });

    // Captura (mantida da fase 1) — diagnóstico/auditoria do formato cru.
    const supabase = createAdminClient();
    await supabase.from("stevo_webhook_samples").insert({
      body: (typeof parsedJson === "object" && parsedJson) ? (parsedJson as Record<string, unknown>) : { _raw: bodyText },
      headers,
    });
    console.log("[stevo-webhook] captured:", bodyText.slice(0, 3000));
  } catch (err) {
    console.error(
      "[stevo-webhook] capture failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  // ===== PARSING + ROTEAMENTO (fase 2) =====
  try {
    const parsed = parseStevoWebhook(parsedJson);
    if (!parsed) {
      // Evento não-processável (status, fromMe, grupo, conteúdo irreconhecível).
      return NextResponse.json({ ok: true, skipped: "not_processable" });
    }

    // Validação do instanceToken. Se STEVO_INSTANCE_TOKEN não estiver setada,
    // NÃO bloqueia (estamos em setup) — só loga warn. Quando setada, exige match.
    const expectedToken = process.env.STEVO_INSTANCE_TOKEN?.trim();
    if (expectedToken) {
      if (parsed.instanceToken !== expectedToken) {
        console.warn(
          `[stevo-webhook] instanceToken inválido (recebido="${parsed.instanceToken.slice(0, 8)}…") — rejeitando.`,
        );
        // Hardening 2026-06-17: rotação/mismatch de token = inbound rejeitado, mas
        // o stevo_webhook_samples acima JÁ gravou → um heartbeat por received_at
        // ficaria VERDE com inbound mudo. Vira signal pra não mascarar. (Só o
        // prefixo do token no metadata, nunca o token cru.)
        reportError({
          title: "SparkBot: webhook Stevo rejeitado por token inválido",
          feature: "sparkbot-inbound-stevo",
          severity: "high",
          description: "O instanceToken do webhook não bate com STEVO_INSTANCE_TOKEN — todo inbound está sendo rejeitado. Rotação de token? Atualizar a env.",
          metadata: { token_prefix: parsed.instanceToken.slice(0, 8) },
        });
        return NextResponse.json({ ok: true, skipped: "invalid_token" });
      }
    } else {
      console.warn(
        "[stevo-webhook] ⚠️ STEVO_INSTANCE_TOKEN não configurado — pulando validação de origem (setup).",
      );
    }

    const { handleStevoInbound } = await import(
      "@/lib/account-assistant/webhook/stevo-handler"
    );
    waitUntil(
      handleStevoInbound(parsed).catch((err) => {
        console.error(
          "[stevo-webhook:bg] handler failed:",
          err instanceof Error ? err.message : err,
        );
        // F49: torna a falha do handler IDENTIFICÁVEL (signal + Sentry). Antes
        // só console.error → bot mudo silencioso (caso "Bora começar" do Sieder
        // 2026-06-04: inbound chegou, handler lançou no waitUntil, ninguém soube).
        reportError({
          title: "SparkBot: handler do inbound falhou (Stevo)",
          error: err,
          feature: "sparkbot-inbound-stevo",
          severity: "critical",
          metadata: {
            phone: parsed.phone,
            push_name: parsed.pushName,
            message_id: parsed.messageId,
          },
        });
      }),
    );
    return NextResponse.json({ ok: true, routed: "sparkbot-stevo" });
  } catch (err) {
    console.error(
      "[stevo-webhook] parse/route failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
    // SEMPRE 200 — não deve fazer o Stevo retentar.
    return NextResponse.json({ ok: true, error: "internal_non_fatal" });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "stevo-inbound" });
}
