/**
 * Callback de NÃO-ENTREGA do SparkZap (H57, item 2 do scan 2026-07-28).
 *
 * A porta de envio do Spark OS responde no ENQUEUE — `{ok, outboxId}` quer
 * dizer "aceita na fila", não "entregue". Quando a fila desiste depois (3
 * tentativas → 'dead', ou erro permanente), o turno aqui já está gravado com
 * `not_sent: false`, que vira mentira. Aconteceu no 1º dia: um proativo morreu
 * com `error 479` do WhatsApp e ninguém soube.
 *
 * O vigia do OS (`cron/sparkbot-delivery`) chama esta rota com a lista de
 * falhas. Aqui a gente CORRIGE o registro do turno e emite o sinal — a verdade
 * volta pra casa onde a conversa mora, que é o único lugar onde dá pra decidir
 * "reenviar?" com contexto.
 *
 * AUTH: mesmo bearer do inbound (`SPARKZAP_INBOUND_TOKEN`), fail-closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function bearerOf(req: NextRequest): string {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim());
  return m ? m[1].trim() : "";
}

interface Falha {
  dedupe_key?: unknown;
  phone?: unknown;
  status?: unknown;
  attempts?: unknown;
  error?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function POST(req: NextRequest) {
  const expected = process.env.SPARKZAP_INBOUND_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json({ ok: false, error: "misconfigured" }, { status: 503 });
  }
  if (!timingSafeEq(bearerOf(req), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { failures?: unknown };
  try {
    body = (await req.json()) as { failures?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const falhas = Array.isArray(body.failures) ? (body.failures as Falha[]) : [];
  if (!falhas.length) return NextResponse.json({ ok: true, corrigidas: 0 });

  const supabase = createAdminClient();
  let corrigidas = 0;

  for (const f of falhas) {
    const chave = str(f.dedupe_key);
    const phone = str(f.phone);
    const erro = str(f.error) || str(f.status) || "não entregue";
    if (!chave) continue;

    try {
      type Alvo = { id: string; metadata: Record<string, unknown> | null };
      let alvo: Alvo | null = null;
      let messageId = "";

      if (chave.startsWith("proactive:")) {
        // Proativo NÃO tem messageId de origem — a chave é
        // "proactive:<fonte>:<repId>:<minutoEpoch>:<bolha>". Acha a resposta do
        // agente pra AQUELE rep na janela daquele minuto. (Sem este ramo, todo
        // proativo caía fora da correção — e proativo é justamente o tráfego
        // que está migrando pro SparkZap agora.)
        const partes = chave.split(":");
        const repId = partes[2] || "";
        const minuto = Number(partes[3] || 0);
        if (repId && Number.isFinite(minuto) && minuto > 0) {
          const inicio = new Date(minuto * 60_000 - 60_000).toISOString();
          const fim = new Date(minuto * 60_000 + 5 * 60_000).toISOString();
          const { data } = await supabase
            .from("sparkbot_messages")
            .select("id, metadata")
            .eq("rep_id", repId)
            .eq("role", "agent")
            .gte("created_at", inicio)
            .lte("created_at", fim)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          alvo = (data as unknown as Alvo | null) ?? null;
        }
      } else {
        // Resposta a inbound: a chave é "<messageId do rep>:<bolha>". A RESPOSTA
        // não tem ghl_message_id (só a msg do rep tem), então achamos o turno
        // pela pergunta e corrigimos a resposta que veio logo depois dela.
        messageId = chave.split(":")[0];
        const { data: pergunta } = await supabase
          .from("sparkbot_messages")
          .select("id, rep_id, created_at")
          .eq("ghl_message_id", messageId)
          .maybeSingle();
        if (pergunta) {
          const { data } = await supabase
            .from("sparkbot_messages")
            .select("id, metadata")
            .eq("rep_id", (pergunta as { rep_id: string }).rep_id)
            .eq("role", "agent")
            .gte("created_at", (pergunta as { created_at: string }).created_at)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          alvo = (data as unknown as Alvo | null) ?? null;
        }
      }

      if (alvo) {
        const meta = (alvo.metadata ?? {}) as Record<string, unknown>;
        await supabase
          .from("sparkbot_messages")
          .update({
            metadata: {
              ...meta,
              // Corrige a mentira: foi aceita na fila, mas NÃO chegou.
              not_sent: true,
              delivery_failed: true,
              delivery_error: erro.slice(0, 300),
              delivery_checked_at: new Date().toISOString(),
            },
          })
          .eq("id", alvo.id);
        corrigidas++;
      }
    } catch (err) {
      console.error("[sparkzap-delivery] correção do turno falhou:", err);
    }

    reportError({
      title: "SparkBot: resposta não chegou ao corretor (SparkZap)",
      feature: "sparkbot-inbound-sparkzap",
      severity: "high",
      description:
        `A fila do SparkZap desistiu de entregar (${erro}). O turno tinha sido registrado ` +
        `como enviado — o corretor ficou sem resposta e o histórico mentia.`,
      metadata: { phone, dedupe_key: chave, delivery_error: erro.slice(0, 200) },
    });
  }

  return NextResponse.json({ ok: true, recebidas: falhas.length, corrigidas });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "sparkzap-delivery-callback",
    armed: !!process.env.SPARKZAP_INBOUND_TOKEN,
  });
}
