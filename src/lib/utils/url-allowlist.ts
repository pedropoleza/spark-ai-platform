/**
 * SSRF defense pra `fetch(url)` chamadas onde URL vem de input externo
 * (webhook attachments, audio_url, etc).
 *
 * Stress test 2026-05-03 expôs que webhook-handler.ts:738 e
 * audio-transcriber.ts faziam fetch direto na URL do webhook GHL sem
 * validação. Atacante forjando webhook (sem GHL_WEBHOOK_SECRET strict
 * em prod) podia apontar pra metadata services internos (169.254.169.254).
 *
 * Estratégia:
 *  1. Allowlist de hosts conhecidos (GHL/LeadConnector/Stevo + storage
 *     providers de áudio/imagem)
 *  2. Bloquear ranges IP privados (RFC1918 + link-local + loopback)
 */

const ALLOWED_HOST_PATTERNS: RegExp[] = [
  // GHL / LeadConnector
  /\.gohighlevel\.com$/i,
  /\.leadconnectorhq\.com$/i,
  /\.msgsndr\.com$/i,
  /\.highlevel-backend\.com$/i,
  /\.lcassetbucket\.com$/i,
  // Sparkleads white-label
  /\.sparkleads\.pro$/i,
  // Stevo (Evolution API) — Hetzner object storage
  /\.your-objectstorage\.com$/i,
  // Twilio
  /api\.twilio\.com$/i,
  /\.twilio\.com$/i,
  /media\.twiliocdn\.com$/i,           // MediaContentUrlN (audio/MMS) — raiz CDN
  /\.twiliocdn\.com$/i,                 // shards regionais
  // Meta / WhatsApp Cloud API (raro: direct media delivery sem GHL/Stevo
  // intermediary). Adicionado preventivamente — fix audit 2026-05-03.
  /lookaside\.fbsbx\.com$/i,
  /mmg\.whatsapp\.net$/i,
  /\.whatsapp\.net$/i,
  // Firebase / Google storage
  /firebasestorage\.googleapis\.com$/i,
  /storage\.googleapis\.com$/i,
  /storage\.cloud\.google\.com$/i,
  // AWS S3 (genérico — mais permissivo, mas necessário pra alguns providers)
  /\.s3\.amazonaws\.com$/i,
  /\.s3\.[a-z0-9-]+\.amazonaws\.com$/i,
  // Cloudflare R2
  /\.r2\.cloudflarestorage\.com$/i,
];

/** Verifica se host está em range IP privado (best-effort string-based — não resolve DNS). */
function isPrivateIpString(host: string): boolean {
  // IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 127) return true;                             // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;                // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16
    if (a === 0) return true;                               // 0.0.0.0/8 invalid
    return false;
  }
  // IPv6 loopback / link-local / unique-local
  if (host === "::1" || host === "[::1]") return true;
  if (host.startsWith("fe80:") || host.startsWith("[fe80:")) return true;
  if (host.startsWith("fc00:") || host.startsWith("fd00:") || host.startsWith("[fc")) return true;
  // hostnames suspeitos
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  if (lower.endsWith(".internal")) return true;
  if (lower.endsWith(".local")) return true;
  return false;
}

export interface UrlValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Valida URL pra fetch externo. Retorna `{ ok: true }` se está liberada
 * pra ir adiante, `{ ok: false, reason }` se devemos bloquear.
 *
 * Em DEV (NODE_ENV !== "production"), permite tudo MENOS IPs privados —
 * pra facilitar testes locais com URLs de mock.
 */
export function validateExternalUrl(url: string): UrlValidation {
  if (!url) return { ok: false, reason: "empty url" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }

  // Apenas HTTPS em prod (HTTP permitido em dev pra mocks)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `protocol ${parsed.protocol} not allowed` };
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    return { ok: false, reason: "http not allowed in production" };
  }

  const host = parsed.hostname;
  if (!host) return { ok: false, reason: "no host in url" };

  // Block private IPs SEMPRE (mesmo em dev)
  if (isPrivateIpString(host)) {
    return { ok: false, reason: `private ip / loopback host: ${host}` };
  }

  // Em dev, qualquer host externo OK
  if (process.env.NODE_ENV !== "production") return { ok: true };

  // Em prod, host deve bater allowlist
  if (ALLOWED_HOST_PATTERNS.some((re) => re.test(host))) return { ok: true };

  return { ok: false, reason: `host not in allowlist: ${host}` };
}

/**
 * Wrapper sobre `fetch` que aplica SSRF guard. Use sempre que URL
 * vem de input não-confiável (webhook, attachment, etc).
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const v = validateExternalUrl(url);
  if (!v.ok) {
    throw new Error(`SSRF guard blocked URL: ${v.reason}`);
  }
  return fetch(url, init);
}
