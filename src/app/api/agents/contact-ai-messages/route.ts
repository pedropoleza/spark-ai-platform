/**
 * GET /api/agents/contact-ai-messages?contactId=...
 *
 * Devolve os TEXTOS que o agente de IA realmente mandou pra esse contato
 * (de execution_log, action_type='send_message', success=true). O custom JS
 * injetado no GHL usa essa lista pra IDENTIFICAR quais bolhas outbound da
 * conversa são do AGENTE (vs. mensagem manual do rep) — anti-eco igual F52 —
 * e só nessas anexa o 👍/👎 (GU-3).
 *
 * Auth: Bearer JWT do /api/agents/ui-auth (location_id do token, defense-in-depth).
 *
 * 200: { ok:true, texts: string[] }  (mais recentes primeiro, dedup, cap 60)
 *
 * Plano: _planning/ghl-ui-agent-controls/PLANO.md (GU-3).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";

export const maxDuration = 20;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request, "GET, OPTIONS") });
}

export async function GET(request: NextRequest) {
  const cors = corsHeadersFor(request, "GET, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...cors, ...(init.headers || {}) } });

  const token = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!token) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const contactId = new URL(request.url).searchParams.get("contactId")?.trim();
  if (!contactId) return json({ ok: false, reason: "missing_contactId" }, { status: 400 });

  try {
    const supabase = createAdminClient();
    // location_id no filtro = fronteira de segurança (rep só lê sends da location dele).
    const { data, error } = await supabase
      .from("execution_log")
      .select("action_payload")
      .eq("contact_id", contactId)
      .eq("location_id", token.location_id)
      .eq("action_type", "send_message")
      .eq("success", true)
      .order("created_at", { ascending: false })
      .limit(80);
    if (error) {
      console.error("[contact-ai-messages] query error:", error.message);
      return json({ ok: false, reason: "query_failed" }, { status: 500 });
    }

    // action_payload.message é um array de partes (string[]) — às vezes string.
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const row of data || []) {
      const payload = row.action_payload as { message?: unknown } | null;
      const msg = payload?.message;
      const parts = Array.isArray(msg) ? msg : msg != null ? [msg] : [];
      for (const p of parts) {
        const t = String(p || "").trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          texts.push(t);
        }
      }
      if (texts.length >= 60) break;
    }

    return json({ ok: true, texts });
  } catch (err) {
    console.error("[contact-ai-messages] erro:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
