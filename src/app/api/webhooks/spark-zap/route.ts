/**
 * Webhook de RECEBIMENTO do SparkZap — a engine de WhatsApp própria da Spark.
 * H57 (2026-07-28) — plano em `_planning/sparkzap-transporte/PLANO.md`.
 *
 * Gêmea de `/api/webhooks/stevo`: captura o corpo cru pra diagnóstico, parseia,
 * dispara `handleStevoInbound` em background (waitUntil) e responde 200 sempre.
 * O que muda é só a PORTA DE ENTRADA — o miolo (idempotência de 7 camadas,
 * gates H8/test-mode, billing) é literalmente o mesmo código.
 *
 * AUTH: bearer `SPARKZAP_INBOUND_TOKEN`, comparado em tempo constante.
 * FAIL-CLOSED: sem a env, a rota recusa TUDO (503) — deployar não abre porta.
 *
 * Quem chama: a ponte no Spark OS (`/api/webhooks/wa-sparkbot`), que recebe o
 * evento da sessão do engine, resolve LID→telefone com o `wa_lid_map` (tabela
 * que só o OS tem) e encaminha. A rota também aceita o envelope CRU do engine,
 * caso um dia a sessão aponte direto pra cá.
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSparkZapWebhook } from "@/lib/account-assistant/webhook/sparkzap-parser";
import { reportError } from "@/lib/admin-signals/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function bearerOf(req: NextRequest): string {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

export async function POST(req: NextRequest) {
  const expected = process.env.SPARKZAP_INBOUND_TOKEN?.trim();
  if (!expected) {
    console.error("[sparkzap-webhook] SPARKZAP_INBOUND_TOKEN não configurado — recusando");
    return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 503 });
  }
  if (!timingSafeEq(bearerOf(req), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let bodyText = "";
  let parsedJson: unknown = null;
  try {
    bodyText = await req.text();
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      parsedJson = { _raw: bodyText };
    }
  } catch (err) {
    console.error(
      "[sparkzap-webhook] leitura do corpo falhou:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  // Captura pra diagnóstico — MESMA tabela do Stevo (`stevo_webhook_samples`), com
  // marca de origem: os monitores de silêncio de inbound (checkInboundSilence /
  // /api/health) medem essa tabela. Gravar aqui mantém a detecção de apagão viva
  // no transporte novo em vez de criar um ponto cego. O binário de mídia é
  // REMOVIDO da amostra (o base64 de um áudio incharia a linha à toa).
  try {
    const sample =
      typeof parsedJson === "object" && parsedJson
        ? stripHeavy(parsedJson as Record<string, unknown>)
        : { _raw: bodyText.slice(0, 2000) };
    const supabase = createAdminClient();
    await supabase.from("stevo_webhook_samples").insert({
      body: { ...sample, _source: "sparkzap" },
      headers: { "x-transport": "sparkzap" },
    });
  } catch (err) {
    console.error(
      "[sparkzap-webhook] captura falhou (não-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const result = parseSparkZapWebhook(parsedJson);
    if (!result.ok) {
      if (result.reason === "unresolved_lid") {
        // Mensagem REAL que não vira telefone → o rep ficaria sem resposta sem
        // ninguém saber. Vira signal (é o descarte silencioso que a ponte existe
        // pra evitar; se aparecer, a sessão está apontando direto pra cá).
        reportError({
          title: "SparkBot: inbound do SparkZap com LID não resolvido",
          feature: "sparkbot-inbound-sparkzap",
          severity: "high",
          description:
            "Chegou mensagem em endereçamento LID sem telefone no payload. A tradução LID→telefone mora na ponte do Spark OS — conferir se a sessão do engine aponta pra /api/webhooks/wa-sparkbot.",
        });
      }
      return NextResponse.json({ ok: true, skipped: result.reason });
    }

    const parsed = result.parsed;
    const { handleStevoInbound } = await import(
      "@/lib/account-assistant/webhook/stevo-handler"
    );
    waitUntil(
      handleStevoInbound(parsed).catch((err) => {
        console.error(
          "[sparkzap-webhook:bg] handler falhou:",
          err instanceof Error ? err.message : err,
        );
        reportError({
          title: "SparkBot: handler do inbound falhou (SparkZap)",
          error: err,
          feature: "sparkbot-inbound-sparkzap",
          severity: "critical",
          metadata: {
            phone: parsed.phone,
            push_name: parsed.pushName,
            message_id: parsed.messageId,
          },
        });
      }),
    );
    return NextResponse.json({ ok: true, routed: "sparkbot-sparkzap" });
  } catch (err) {
    console.error(
      "[sparkzap-webhook] parse/route falhou (não-fatal):",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ ok: true, error: "internal_non_fatal" });
  }
}

/** Remove binários pesados da AMOSTRA (o parser recebe o corpo íntegro). */
function stripHeavy(body: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...body };
  const data = clone.data ?? clone.event;
  if (data && typeof data === "object") {
    const d = { ...(data as Record<string, unknown>) };
    const msg = d.Message;
    if (msg && typeof msg === "object") {
      const m = { ...(msg as Record<string, unknown>) };
      for (const k of ["base64", "Base64", "RawMessage", "SourceWebMsg"]) delete m[k];
      d.Message = m;
    }
    if (clone.data) clone.data = d;
    else clone.event = d;
  }
  return clone;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "sparkzap-inbound",
    armed: !!process.env.SPARKZAP_INBOUND_TOKEN,
  });
}
