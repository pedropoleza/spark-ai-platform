/**
 * Validação de env vars. Executa na primeira importação deste módulo —
 * em qualquer path da app que acabe carregando aqui, vamos ver logs de
 * problemas de configuração imediatamente em vez de descobrir em runtime.
 *
 * Não throwa em missing required em prod pra não derrubar build/SSR,
 * mas loga ERROR audível. Em dev (NODE_ENV=development), throwa pra
 * forçar configuração correta.
 */

const REQUIRED_ALWAYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "JWT_SECRET",
  "OPENAI_API_KEY",
];

const REQUIRED_GHL = [
  "GHL_TOKEN_SUPABASE_URL",
  "GHL_TOKEN_SUPABASE_SERVICE_KEY",
  "NEXT_PUBLIC_GHL_COMPANY_ID",
];

const REQUIRED_CRON = ["CRON_SECRET"];

// NEXT_PUBLIC_ vars devem estar setadas em build time (Next.js inlines elas)
// então se faltar aqui em runtime não dá pra fazer nada.

let validated = false;

export function validateEnv(): void {
  if (validated) return;
  validated = true;

  const missing: string[] = [];
  for (const key of [...REQUIRED_ALWAYS, ...REQUIRED_GHL, ...REQUIRED_CRON]) {
    if (!process.env[key]) missing.push(key);
  }

  if (missing.length > 0) {
    const msg = `Missing required env vars: ${missing.join(", ")}`;
    if (process.env.NODE_ENV === "development") {
      console.error(`[env] ❌ ${msg}`);
      throw new Error(msg);
    } else {
      console.error(`[env] ⚠️  ${msg} — app may fail at runtime`);
    }
  }

  // Avisos de configuração suspeita
  if (process.env.NODE_ENV === "production") {
    if (process.env.DEV_MODE === "true") {
      console.error("[env] 🚨 DEV_MODE=true em produção — isso é um bug de deploy. Desabilite imediatamente.");
    }
    if (process.env.NEXT_PUBLIC_DEV_MODE === "true") {
      console.error("[env] 🚨 NEXT_PUBLIC_DEV_MODE=true em produção — botão de dev-login aparecerá na UI.");
    }
    if (!process.env.GHL_WEBHOOK_SECRET) {
      console.warn("[env] ⚠️  GHL_WEBHOOK_SECRET não configurado — webhook aceita requests sem assinatura. Configure + WEBHOOK_REQUIRE_SIGNATURE=true para prod.");
    }
    if (!process.env.ASSISTANT_HUB_LOCATION_ID?.trim()) {
      // H29 2026-05-20: env virou opcional — hub agora é resolvido via DB
      // (resolveActiveHubAgents em hub-resolver.ts). Env mantida como fallback
      // de segurança. Se o DB tiver ≥1 agent account_assistant ativo, tudo ok.
      console.warn(
        "[env] ⚠️  ASSISTANT_HUB_LOCATION_ID não configurado — hub será resolvido via DB. " +
          "Configure a env como fallback de segurança se o DB ficar inacessível.",
      );
    }
    if (!process.env.ASSISTANT_HUB_COMPANY_ID?.trim()) {
      console.error(
        "[env] 🚨 ASSISTANT_HUB_COMPANY_ID não configurado — Sparkbot não consegue chamar GHL pra Hub.",
      );
    }
    // P0-5 review pré-launch 2026-06-10: SPOF do token de agência. Estas creds são
    // usadas em token-refresher.ts (refresh + self-heal H38 + exchangeAuthCode). Se
    // faltarem em prod, o refresh do token de agência falha quando ele expira → TODAS
    // as chamadas ao Spark Leads passam a dar 401 (webhook, proativos, tools) ~24h depois,
    // de forma silenciosa. Não throwa (não derruba SSR), mas loga ERROR audível.
    if (!process.env.GHL_CLIENT_ID?.trim() || !process.env.GHL_CLIENT_SECRET?.trim()) {
      console.error(
        "[env] 🚨 GHL_CLIENT_ID/GHL_CLIENT_SECRET não configurados — o refresh/self-heal do token " +
          "de agência (token-refresher.ts) vai falhar quando o token expirar, causando 401 em massa " +
          "nas chamadas ao Spark Leads. Configure ANTES do launch.",
      );
    }
  }

  // OpenAI vs Anthropic
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) {
    console.error("[env] ❌ Nem OPENAI_API_KEY nem ANTHROPIC_API_KEY configurados — IA não vai funcionar.");
  }
}

/**
 * Credenciais que viram header HTTP. Espaço ou quebra de linha invisível no
 * valor vira 401 no provedor, não erro de configuração.
 */
const CHAVES_DE_API = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "VOYAGE_API_KEY",
  "GROQ_API_KEY",
  "GHL_CLIENT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/**
 * Tira espaço/quebra-de-linha das credenciais no boot.
 *
 * Fix bug observado em prod 2026-08-10 (H73, queixa da Márcia "a IA não ouve
 * áudio"): a `OPENAI_API_KEY` da Vercel estava salva com um `\n` colado no fim
 * (166 chars em vez de 164). A chave era a CERTA — a OpenAI devolvia 401 por
 * causa do caractere invisível. Quebrava Whisper (áudio), Vision (imagem),
 * embeddings e o fallback OpenAI, na frota inteira, enquanto o resto da IA
 * seguia funcionando (Claude) — por isso pareceu bug de transcrição por dias.
 *
 * Saneia em UM lugar em vez de espalhar `.trim()` por ~20 chamadas: as libs
 * (OpenAI SDK, Anthropic SDK) leem `process.env` por conta própria.
 */
export function sanearChavesDeApi(): void {
  for (const nome of CHAVES_DE_API) {
    const bruto = process.env[nome];
    if (typeof bruto !== "string") continue;
    const limpo = bruto.trim();
    if (limpo !== bruto) {
      process.env[nome] = limpo;
      console.warn(
        `[env] ⚠️  ${nome} tinha espaço/quebra-de-linha nas pontas (${bruto.length} → ${limpo.length} chars) — corrigido em memória. Corrija o valor na Vercel.`,
      );
    }
  }
}

// Executa imediatamente no carregamento do módulo
sanearChavesDeApi();
validateEnv();
