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
  }

  // OpenAI vs Anthropic
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) {
    console.error("[env] ❌ Nem OPENAI_API_KEY nem ANTHROPIC_API_KEY configurados — IA não vai funcionar.");
  }
}

// Executa imediatamente no carregamento do módulo
validateEnv();
