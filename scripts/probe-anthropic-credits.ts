/**
 * Health-ping da API da Anthropic: 1 chamada de 1 token só pra descobrir se a
 * conta está com crédito AGORA (descoberto 2026-06-16 que agentes lead-facing
 * estavam falhando com 400 "credit balance is too low"). Não muda nada, não
 * fala com lead nenhum — só lê o status da conta. Não imprime a key.
 *   npx tsx scripts/probe-anthropic-credits.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
// Aceita um caminho de env via argv (ex: arquivo puxado da Vercel pra teste
// pontual); default .env.local. Resolve relativo ao CWD se vier por arg.
const envArg = process.argv[2];
config({ path: envArg ? resolve(process.cwd(), envArg) : resolve(__dirname, "..", ".env.local") });

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log("❌ ANTHROPIC_API_KEY ausente no .env.local");
    process.exit(2);
  }
  console.log(`Key carregada: ...${key.slice(-4)} (len ${key.length})`);

  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  const ms = Date.now() - started;
  const text = await res.text();
  console.log(`\nHTTP ${res.status} em ${ms}ms`);

  if (res.ok) {
    console.log("✅ CRÉDITO OK — a API respondeu normalmente. O apagão de crédito JÁ VOLTOU.");
  } else {
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    const msg = (parsed as { error?: { message?: string; type?: string } })?.error?.message || text;
    const isCredit = /credit balance is too low/i.test(text);
    console.log(isCredit
      ? "🔴 AINDA SEM CRÉDITO — a conta da Anthropic continua estourada AGORA."
      : `⚠️  Falhou por OUTRO motivo: ${msg}`);
  }
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error("probe error:", e); process.exit(3); });
