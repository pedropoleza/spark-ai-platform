import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import { recordSignal } from "@/lib/admin-signals/recorder";

export const maxDuration = 30;

/**
 * GET /api/cron/signals-alert  (Pedro 2026-06-17)
 *
 * O DESTRAVADOR da observabilidade. Até aqui, TODO problema de produção
 * (token caído, onboarding mudo, disparo travado, agente em loop) só era
 * descoberto quando o Pedro reclamava — os `admin_signals` existiam mas
 * ninguém os via. Este cron empurra os sinais CRÍTICOS pra um canal de
 * push (Telegram ou Slack) e roda um dead-man dos runners proativos.
 *
 * Duas responsabilidades:
 *   1. DEAD-MAN HEARTBEAT — se nenhum runner proativo deu tick há >15min,
 *      o pg_cron `sparkbot-proactive` provavelmente parou (lembretes,
 *      follow-ups, disparos, proativos TODOS mudos). Grava signal crítico.
 *   2. PUSH de admin_signals — manda os sinais alert-worthy (critical, ou
 *      high de falha/erro, ou medium com pico de ocorrência) pro canal,
 *      com anti-spam por `last_alerted_at` (re-alerta só se passou 4h, ou
 *      a ocorrência dobrou, ou escalou pra critical).
 *
 * CANAL: env-gated. Sem `ALERT_TELEGRAM_*` nem `ALERT_SLACK_WEBHOOK`
 * configurado, o push é NO-OP (mas o heartbeat ainda grava signal, visível
 * no painel). Assim dá pra deployar já e o Pedro liga o push depois só
 * setando o secret — sem marcar nada como "alertado" antes da hora (o
 * backlog dispara quando o canal existir).
 *
 * Auth: `isAuthorizedCron` (header x-vercel-cron OU Bearer CRON_SECRET).
 * Agendado por pg_cron a cada 5min (migration 00111).
 */

// Quantos alertas no máximo por execução — evita flood quando o canal é
// ligado pela 1a vez e há backlog. O excedente fica pro próximo tick e é
// logado (NUNCA suprimido em silêncio).
const MAX_PUSH_PER_RUN = 8;

// Runner parado há mais que isso = dead-man. Os runners tickam a cada 5min;
// 15min = perdeu 3 ticks, claramente travado (não é só jitter de schedule).
const RUNNER_STALE_MINUTES = 15;

// Só considera sinais "vivos" (vistos nas últimas 24h). Sinais antigos não
// são acionáveis agora e evitam flood na 1a ativação do canal.
const SIGNAL_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

type SignalRow = {
  id: string;
  type: string;
  severity: string;
  title: string;
  description: string | null;
  occurrence_count: number;
  last_seen_at: string;
  last_alerted_at: string | null;
  metadata: Record<string, unknown> | null;
};

const SEV_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function channelName(): "telegram" | "slack" | "none" {
  if (process.env.ALERT_TELEGRAM_BOT_TOKEN && process.env.ALERT_TELEGRAM_CHAT_ID) return "telegram";
  if (process.env.ALERT_SLACK_WEBHOOK) return "slack";
  return "none";
}

async function sendToChannel(text: string): Promise<boolean> {
  try {
    const tgToken = process.env.ALERT_TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.ALERT_TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: tgChat,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      return r.ok;
    }
    const slack = process.env.ALERT_SLACK_WEBHOOK;
    if (slack) {
      const r = await fetch(slack, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Slack usa markdown leve; tira as tags HTML do Telegram.
        body: JSON.stringify({ text: text.replace(/<\/?b>/g, "*").replace(/<\/?i>/g, "_") }),
      });
      return r.ok;
    }
    return false;
  } catch (e) {
    console.error("[signals-alert] erro ao enviar pro canal:", e);
    return false;
  }
}

function isAlertWorthy(s: SignalRow): boolean {
  // Nunca empurra 'idea' nem 'missed_capability' — só falha/erro real.
  if (s.type !== "failure" && s.type !== "error") return false;
  if (s.severity === "critical" || s.severity === "high") return true;
  // medium só com pico de ocorrência (algo repetindo muito).
  if (s.severity === "medium" && s.occurrence_count >= 20) return true;
  return false;
}

function isDue(s: SignalRow, nowMs: number): boolean {
  const meta = s.metadata || {};
  if (!s.last_alerted_at) return true; // nunca alertado
  const lastMs = new Date(s.last_alerted_at).getTime();
  if (nowMs - lastMs > 4 * 60 * 60 * 1000) return true; // re-lembra a cada 4h enquanto aberto
  const alertedOcc = Number(meta.alerted_occurrence) || 0;
  if (alertedOcc > 0 && s.occurrence_count >= alertedOcc * 2) return true; // ocorrência dobrou
  const alertedSev = String(meta.alerted_severity || "");
  if (s.severity === "critical" && alertedSev && alertedSev !== "critical") return true; // escalou
  return false;
}

function formatSignal(s: SignalRow, baseUrl: string | null): string {
  const emoji: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };
  const lines = [
    `${emoji[s.severity] || "⚪"} <b>${escapeHtml(s.title)}</b>`,
    s.description ? escapeHtml(String(s.description).slice(0, 300)) : "",
    `<i>${s.occurrence_count}× · ${s.severity}/${s.type}</i>`,
    baseUrl ? `→ ${baseUrl}/hub/admin/health` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Dead-man dos runners proativos. Grava signal crítico se travados. */
async function checkRunnerHeartbeat(
  supabase: ReturnType<typeof createAdminClient>,
  nowMs: number,
): Promise<{ stale: boolean; stale_minutes: number }> {
  const { data } = await supabase.from("runner_health").select("runner_name, last_tick_at");
  if (!data || data.length === 0) return { stale: false, stale_minutes: 0 };
  const ticks = data
    .map((r) => (r.last_tick_at ? new Date(r.last_tick_at).getTime() : 0))
    .filter((t) => t > 0);
  if (ticks.length === 0) return { stale: false, stale_minutes: 0 };
  const latest = Math.max(...ticks);
  const staleMin = Math.round((nowMs - latest) / 60000);
  if (staleMin > RUNNER_STALE_MINUTES) {
    // Title ESTÁVEL (dedup por fingerprint). Detalhe variável vai no corpo.
    await recordSignal({
      type: "failure",
      severity: "critical",
      source: "system",
      title: "Runners proativos parados (heartbeat dead-man)",
      description:
        `Nenhum runner proativo deu tick há ${staleMin}min (último: ${new Date(latest).toISOString()}). ` +
        `O pg_cron sparkbot-proactive pode estar parado — proativos, lembretes, follow-ups e disparos NÃO estão rodando.`,
      metadata: {
        feature: "runner-heartbeat",
        stale_minutes: staleMin,
        runners: data.map((r) => ({ name: r.runner_name, last_tick_at: r.last_tick_at })),
      },
    });
    return { stale: true, stale_minutes: staleMin };
  }
  return { stale: false, stale_minutes: staleMin };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const nowMs = Date.now();
  const channel = channelName();
  const result: Record<string, unknown> = {
    ok: true,
    channel,
    heartbeat_stale: false,
    candidates: 0,
    pushed: 0,
    dropped: 0,
    errors: [] as string[],
  };
  const errors = result.errors as string[];

  // 1. DEAD-MAN HEARTBEAT (await: o signal precisa estar commitado antes da
  //    query de push, pra ele entrar no mesmo batch).
  try {
    const hb = await checkRunnerHeartbeat(supabase, nowMs);
    result.heartbeat_stale = hb.stale;
    if (hb.stale) result.heartbeat_stale_minutes = hb.stale_minutes;
  } catch (e) {
    errors.push("heartbeat: " + (e instanceof Error ? e.message : String(e)));
  }

  // 2. Sem canal configurado → no-op no PUSH (mas o heartbeat já gravou o
  //    signal no painel). NÃO marca nada como alertado — o backlog dispara
  //    quando o Pedro setar ALERT_TELEGRAM_* ou ALERT_SLACK_WEBHOOK.
  if (channel === "none") {
    result.note = "nenhum canal de alerta configurado (set ALERT_TELEGRAM_BOT_TOKEN+ALERT_TELEGRAM_CHAT_ID ou ALERT_SLACK_WEBHOOK)";
    return NextResponse.json(result);
  }

  // base_url pro link do painel (mesmo cron_config usado pelos outros crons).
  let baseUrl: string | null = null;
  try {
    const { data: cfg } = await supabase.from("cron_config").select("base_url").eq("id", 1).maybeSingle();
    baseUrl = (cfg?.base_url as string) || process.env.NEXT_PUBLIC_APP_URL || null;
  } catch {
    baseUrl = process.env.NEXT_PUBLIC_APP_URL || null;
  }

  // 3. Busca sinais abertos e "vivos" (vistos nas últimas 24h).
  const { data: signals, error } = await supabase
    .from("admin_signals")
    .select("id, type, severity, title, description, occurrence_count, last_seen_at, last_alerted_at, metadata")
    .eq("status", "open")
    .gte("last_seen_at", new Date(nowMs - SIGNAL_FRESH_WINDOW_MS).toISOString())
    .limit(200);

  if (error) {
    errors.push("fetch signals: " + error.message);
    result.ok = false;
    return NextResponse.json(result, { status: 500 });
  }

  // 4. Filtra alert-worthy + due (anti-spam), ordena critical-primeiro.
  const due = (signals as SignalRow[] | null || [])
    .filter(isAlertWorthy)
    .filter((s) => isDue(s, nowMs))
    .sort((a, b) => {
      const sev = (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0);
      return sev !== 0 ? sev : b.occurrence_count - a.occurrence_count;
    });

  result.candidates = due.length;
  const toSend = due.slice(0, MAX_PUSH_PER_RUN);
  result.dropped = Math.max(0, due.length - MAX_PUSH_PER_RUN);

  for (const s of toSend) {
    const sent = await sendToChannel(formatSignal(s, baseUrl));
    if (!sent) {
      errors.push("envio falhou: " + s.id);
      continue;
    }
    result.pushed = (result.pushed as number) + 1;
    // Marca alertado: last_alerted_at + snapshot pra detectar "dobrou"/"escalou".
    await supabase
      .from("admin_signals")
      .update({
        last_alerted_at: new Date().toISOString(),
        metadata: { ...(s.metadata || {}), alerted_occurrence: s.occurrence_count, alerted_severity: s.severity },
      })
      .eq("id", s.id);
  }

  if ((result.dropped as number) > 0) {
    console.warn(`[signals-alert] ${result.dropped} alerta(s) acima do cap ${MAX_PUSH_PER_RUN}/run — vão no próximo tick`);
  }

  return NextResponse.json(result);
}
