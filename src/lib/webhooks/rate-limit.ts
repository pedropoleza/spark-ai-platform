/**
 * Webhook rate limit + anomaly detection (Pedro 2026-05-28 F20).
 *
 * GHL não dá secret HMAC pra inbound webhook (usa Ed25519 público, que vai
 * ser implementado em iteração futura). Enquanto isso, mitigações:
 *
 *   1. Rate limit por IP: max 50 hits/min do mesmo IP. Bloqueia DDoS trivial.
 *   2. Cost circuit breaker: se location atingiu monthly_spend_cap_usd,
 *      rejeita webhook (não só pula charge — bot continua respondendo seria
 *      runaway).
 *   3. Anomaly signal: location recebendo de >5 IPs únicos em 1min = critical.
 *
 * Strategy:
 *   - Single query INSERT + COUNT em 1 round-trip (rate limit check)
 *   - Cleanup periódico (rows >5min) via cron sparkbot-proactive ou manual.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_HITS = 50;
const ANOMALY_UNIQUE_IPS_THRESHOLD = 5;

export interface RateLimitCheck {
  allowed: boolean;
  reason?: "rate_limit" | "cost_cap";
  current_count?: number;
  cap?: number;
}

/**
 * Registra um hit e valida rate limit + cost circuit breaker.
 * Retorna allowed=false quando:
 *   - IP excedeu RATE_LIMIT_MAX_HITS no último minuto
 *   - Location atingiu monthly_spend_cap_usd
 *
 * Async/silent em DB errors — fail-OPEN pra não bloquear legitimate traffic
 * quando DB cair. Pior cenário sem rate limit = $$ extra de IA por algumas
 * horas, manageable. Pior cenário com fail-closed = bot offline pra todos.
 */
export async function checkWebhookRateLimit(
  ip: string,
  locationId: string | null,
): Promise<RateLimitCheck> {
  if (!ip || ip === "unknown") {
    // Sem IP confiável (header missing) — fail-open. Vercel sempre dá
    // x-forwarded-for; se vier vazio é cenário improvável.
    return { allowed: true };
  }
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - RATE_LIMIT_WINDOW_SEC * 1000).toISOString();

  try {
    // Registra o hit primeiro (mesmo que rejeite). Fingerprint pra anomaly.
    await supabase
      .from("webhook_rate_limit_hits")
      .insert({ ip, location_id: locationId });

    // Conta hits do mesmo IP no último minuto.
    const { count: ipCount } = await supabase
      .from("webhook_rate_limit_hits")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .gte("hit_at", cutoffIso);

    if ((ipCount ?? 0) > RATE_LIMIT_MAX_HITS) {
      return {
        allowed: false,
        reason: "rate_limit",
        current_count: ipCount ?? 0,
        cap: RATE_LIMIT_MAX_HITS,
      };
    }

    // Anomaly check: location recebendo de muitos IPs únicos.
    if (locationId) {
      const { data: ipsRows } = await supabase
        .from("webhook_rate_limit_hits")
        .select("ip")
        .eq("location_id", locationId)
        .gte("hit_at", cutoffIso);
      const uniqueIps = new Set((ipsRows || []).map((r) => r.ip as string));
      if (uniqueIps.size >= ANOMALY_UNIQUE_IPS_THRESHOLD) {
        // Não bloqueia, só sinaliza. Pode ser legitimate (GHL usa pool de IPs)
        // mas em escala suspeita, signal alerta.
        try {
          const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
          recordSignalAsync({
            type: "error",
            source: "system",
            severity: "high",
            title: `Webhook GHL: location com ${uniqueIps.size} IPs únicos em 1min`,
            description:
              `Location ${locationId.slice(0, 8)} recebeu inbound de ${uniqueIps.size} IPs distintos no último minuto. ` +
              `Pode ser legítimo (pool GHL) mas se persistir, investigar spoofing.`,
            metadata: { location_id: locationId, unique_ips: uniqueIps.size, threshold: ANOMALY_UNIQUE_IPS_THRESHOLD },
          });
        } catch {
          /* não-fatal */
        }
      }
    }

    // Cost circuit breaker: location atingiu cap mensal = bloqueia webhook.
    // Diferente do billing existente que só pula CHARGE (bot continua
    // respondendo, dono come custo). Aqui em modo "atingiu = stop".
    if (locationId) {
      const { isMonthlyCapReached } = await import("@/lib/billing/charge");
      const capCheck = await isMonthlyCapReached(locationId, 0);
      if (capCheck.blocked) {
        return {
          allowed: false,
          reason: "cost_cap",
          current_count: Math.round(capCheck.spentSoFar),
          cap: capCheck.cap,
        };
      }
    }

    return { allowed: true };
  } catch (err) {
    console.warn(
      "[webhook-rate-limit] check falhou (fail-open):",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return { allowed: true };
  }
}

/**
 * Cleanup de hits >5min. Chamado pelo cron sparkbot-proactive periodicamente.
 * Mantém tabela enxuta (~50 req/min x 5min = 250 rows steady-state).
 */
export async function cleanupWebhookHits(): Promise<{ deleted: number }> {
  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("webhook_rate_limit_hits")
    .delete({ count: "exact" })
    .lt("hit_at", cutoffIso);
  return { deleted: count ?? 0 };
}
