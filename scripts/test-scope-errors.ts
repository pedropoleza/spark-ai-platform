/**
 * Golden test — scope-manager Onda 2 (2026-05-20)
 * Valida a classificação de erros de escopo/IAM em ghlErrorToResult.
 *
 * Roda com:
 *   npx tsx -r tsconfig-paths/register scripts/test-scope-errors.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

// Importa a função pura (sem Supabase, sem efeitos colaterais)
import { ghlErrorToResult } from "@/lib/account-assistant/tools/types";

// ---------------------------------------------------------------------------
// Utilitário de assert
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Casos de teste
// ---------------------------------------------------------------------------

console.log("\n[scope-errors] Caso 1: IAM 500 unsupported_endpoint");
{
  const err = new Error(
    "GHL API 500: This route is not yet supported by the IAM Service for this resource",
  );
  const result = ghlErrorToResult(err, "delete_appointment");
  assert(result.status === "error", "status = error");
  assert(
    result.status === "error" && result.code === "unsupported_endpoint",
    "code = unsupported_endpoint",
    `got: ${result.status === "error" ? result.code : "n/a"}`,
  );
  assert(
    result.status === "error" && result.retryable === false,
    "retryable = false",
  );
  assert(
    result.status === "error" &&
      result.message.includes("não é suportada") &&
      result.message.includes("não dá pra fazer"),
    "mensagem clara para o LLM",
    `got: "${result.status === "error" ? result.message : ""}"`,
  );
}

console.log("\n[scope-errors] Caso 2: 403 — scope_or_location");
{
  const err = new Error(
    'GHL API 403: {"message":"token does not have access to this location","statusCode":403}',
  );
  const result = ghlErrorToResult(err, "get_contact_notes");
  assert(result.status === "error", "status = error");
  assert(
    result.status === "error" && result.code === "scope_or_location",
    "code = scope_or_location",
    `got: ${result.status === "error" ? result.code : "n/a"}`,
  );
  assert(
    result.status === "error" && result.retryable === false,
    "retryable = false",
  );
}

console.log("\n[scope-errors] Caso 3: 500 real transitório — SEM code, retryable true");
{
  const err = new Error(
    'GHL API 502: {"message":"Bad Gateway","statusCode":502}',
  );
  const result = ghlErrorToResult(err, "create_appointment");
  assert(result.status === "error", "status = error");
  assert(
    result.status === "error" && result.retryable === true,
    "retryable = true (transitório)",
  );
  assert(
    result.status === "error" && result.code === undefined,
    "code = undefined (não é escopo/IAM)",
    `got: ${result.status === "error" ? result.code : "n/a"}`,
  );
}

console.log("\n[scope-errors] Caso 4: 429 rate limit — retryable true, sem code");
{
  const err = new Error(
    'GHL API 429: {"message":"Too Many Requests","statusCode":429}',
  );
  const result = ghlErrorToResult(err, "search_contacts");
  assert(result.status === "error", "status = error");
  assert(
    result.status === "error" && result.retryable === true,
    "retryable = true (rate limit)",
  );
  assert(
    result.status === "error" && result.code === undefined,
    "code = undefined",
  );
}

console.log("\n[scope-errors] Caso 5: 400 duplicate contact — comportamento mantido");
{
  const err = new Error(
    'GHL API 400: {"message":"Duplicated Contacts","statusCode":400,"meta":{"contactId":"ErpM2X8vR1U4IrRTZnKX","contactName":"João Silva"}}',
  );
  const result = ghlErrorToResult(err, "create_contact");
  assert(result.status === "error", "status = error");
  assert(
    result.status === "error" && result.message.includes("já existe"),
    "mensagem inclui 'já existe'",
    `got: "${result.status === "error" ? result.message : ""}"`,
  );
  assert(
    result.status === "error" && result.message.includes("ErpM2X8vR1U4IrRTZnKX"),
    "contactId preservado na mensagem",
  );
  assert(
    result.status === "error" && result.retryable === false,
    "retryable = false",
  );
  assert(
    result.status === "error" && result.code === undefined,
    "code = undefined (duplicate não é scope issue)",
  );
}

// Variante IAM com wording ligeiramente diferente
console.log("\n[scope-errors] Caso 6: IAM 500 (wording alternativo 'not supported by the IAM')");
{
  const err = new Error("GHL API 500: not supported by the IAM service");
  const result = ghlErrorToResult(err, "some_endpoint");
  assert(
    result.status === "error" && result.code === "unsupported_endpoint",
    "code = unsupported_endpoint para wording alternativo",
  );
}

// ---------------------------------------------------------------------------
// Resultado final
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(50)}`);
console.log(`[scope-errors] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("[scope-errors] Todos os casos passaram ✓");
}
