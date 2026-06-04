/**
 * Smoke E2E dos endpoints GU-1 em PROD, com auth REAL:
 *  1. Pega um userId real da location via GHL (/users).
 *  2. POST /api/agents/ui-auth → token PROD-assinado (não depende de JWT_SECRET local).
 *  3. contact-status → pause ON → status → feedback 👎 → pause OFF → status.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/smoke-gu1-endpoints.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const BASE = "https://spark-ai-platform.vercel.app";
const LOC = "jA6uzx6tONyTeocxw4Cj";
const CONTACT = "1sfbr5EiFJ8jvoGxE2nO";

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://app.sparkleads.pro" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* */ }
  return { status: res.status, json };
}

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOC).maybeSingle();
  const companyId = loc?.company_id as string;
  if (!companyId) throw new Error("company_id não achado");

  // Pega um userId real da location
  const client = new GHLClient(companyId, LOC);
  const usersResp = await client.get<{ users?: Array<{ id: string; name?: string; role?: string }> }>("/users/", { locationId: LOC });
  const user = usersResp.users?.[0];
  if (!user?.id) throw new Error("nenhum user na location");
  console.log(`\nuserId real: ${user.id} (${user.name || "?"}, role=${user.role || "?"})`);

  // ui-auth → token prod
  const auth = await call("POST", "/api/agents/ui-auth", null, { userId: user.id, locationId: LOC, companyId });
  console.log(`\n0. ui-auth → HTTP ${auth.status}`, JSON.stringify(auth.json).slice(0, 140));
  const token = (auth.json as { token?: string })?.token || null;
  if (!token) { console.log("SEM TOKEN — abortando"); process.exit(1); }

  console.log("\n=== GU-1 E2E (auth real) ===\n");

  const noAuth = await call("GET", `/api/agents/contact-status?contactId=${CONTACT}`, null);
  console.log(`1. status no-auth → HTTP ${noAuth.status} (esperado 401)`);

  const s1 = await call("GET", `/api/agents/contact-status?contactId=${CONTACT}`, token);
  console.log(`2. status → HTTP ${s1.status}`, JSON.stringify(s1.json));
  const agentId = (s1.json as { agentId?: string })?.agentId;

  const on = await call("POST", `/api/agents/contact-pause`, token, { contactId: CONTACT, paused: true });
  console.log(`3. pause ON → HTTP ${on.status}`, JSON.stringify(on.json));

  const s2 = await call("GET", `/api/agents/contact-status?contactId=${CONTACT}`, token);
  console.log(`4. status (deve paused:true) → HTTP ${s2.status}`, JSON.stringify(s2.json));

  const fb = await call("POST", `/api/agents/message-feedback`, token, {
    agentId, contactId: CONTACT,
    aiMessage: "Oi! Tudo certo por aqui 😊 (smoke GU-1)",
    rating: "negative", suggestion: "Mais direto; oferecer 2 horários espaçados.",
  });
  console.log(`5. feedback 👎 → HTTP ${fb.status}`, JSON.stringify(fb.json));

  const off = await call("POST", `/api/agents/contact-pause`, token, { contactId: CONTACT, paused: false });
  console.log(`6. pause OFF (revert) → HTTP ${off.status}`, JSON.stringify(off.json));

  const s3 = await call("GET", `/api/agents/contact-status?contactId=${CONTACT}`, token);
  console.log(`7. status final (deve paused:false) → HTTP ${s3.status}`, JSON.stringify(s3.json));

  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
