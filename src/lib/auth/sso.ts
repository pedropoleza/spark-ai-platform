import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GHLUser } from "@/types/ghl";

const SESSION_COOKIE = "spark_session";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24 horas

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET nao configurado");
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  userId: string;
  companyId: string;
  locationId: string;
  locationName: string;
  isAdmin: boolean;
}

/**
 * Valida o usuario via GHL API e verifica se e admin
 */
export async function validateGHLUser(
  companyId: string,
  locationId: string,
  userId: string
): Promise<{ user: GHLUser; isAdmin: boolean } | null> {
  const client = new GHLClient(companyId, locationId);

  // Lista de usuários — com 1 retry pra instabilidade transitória da GHL (assim o
  // fail-closed abaixo raramente trava um usuário legítimo por flap de rede).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.get<{ users: GHLUser[] }>("/users/", { locationId });
      console.log("[SSO] Users response count:", response.users?.length);
      const user = response.users?.find((u) => u.id === userId);
      if (user) {
        console.log("[SSO] User found:", { id: user.id, role: user.role, type: user.type });
        return { user, isAdmin: isUserAdmin(user) };
      }
      break; // lista respondeu mas o user não está nela → tenta fetch individual (sem re-listar)
    } catch (err) {
      console.log(`[SSO] Users list failed (tentativa ${attempt + 1}/2):`, err instanceof Error ? err.message : err);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Tentar buscar usuario individual
  try {
    const user = await client.get<GHLUser>(`/users/${userId}`);
    if (user && (user.id || user.email)) {
      console.log("[SSO] Direct user found:", { id: user.id, role: user.role, type: user.type });
      return { user, isAdmin: isUserAdmin(user) };
    }
  } catch (err) {
    console.log("[SSO] Direct user fetch failed:", err instanceof Error ? err.message : err);
  }

  // FAIL-CLOSED (fix P0-1 ultra-review 2026-05-26): ANTES fabricava um usuário e
  // deixava entrar quando a GHL não confirmava. Como POST /api/auth/sso é público
  // e o Custom Menu Link manda só user_id/location_id CRUS (sem assinatura), isso
  // forjava sessão válida pra QUALQUER location_id → bypass de login cross-tenant.
  // A confirmação via API da GHL É a prova de origem; sem ela, NEGA o acesso.
  // Location ativa tem token OAuth (o bot precisa dele) → usuário real é
  // confirmado → sem lockout. AUDIT log abaixo pro Pedro vigiar nos logs do Vercel
  // se algum legítimo bate na trava (ex: outage da GHL) antes/depois do deploy.
  console.error(
    "[SSO][AUDIT] fail-closed — GHL não confirmou o usuário; acesso NEGADO:",
    JSON.stringify({ userId, locationId, companyId, at: new Date().toISOString() }),
  );
  return null;
}

function isUserAdmin(user: GHLUser): boolean {
  const role = (user.role || "").toLowerCase();
  const type = (user.type || "").toLowerCase();

  // Fix segurança (ultra-review 2026-05-26): ANTES role "user" e type "account"
  // — o DEFAULT de qualquer usuário GHL de uma location — caíam aqui, então
  // TODO usuário logado virava "admin". isAdmin gateia o painel Acessos (liberar
  // entitlements) e o bypass de cobrança; tem que ser só dono/admin da location
  // ou usuário de agência. Usuário comum ("user"/"account") = não-admin.
  // (Não afeta o uso do /hub: criar/configurar agente não exige admin; com a flag
  // de billing OFF, entitlement é liberado pra todos de qualquer forma.)
  return (
    role === "admin" ||
    role === "owner" ||
    role === "agency_owner" ||
    role === "agency_user" ||
    type === "agency"
  );
}

/**
 * Faz upsert da location no banco
 */
export async function upsertLocation(
  locationId: string,
  companyId: string,
  locationName?: string,
  timezone?: string
) {
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("locations")
    .upsert(
      {
        location_id: locationId,
        company_id: companyId,
        location_name: locationName || null,
        timezone: timezone || "America/New_York",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" }
    );

  if (error) {
    console.error("Erro ao upsert location:", error);
    throw error;
  }
}

/**
 * Cria um JWT de sessao e salva no cookie
 */
export async function createSession(payload: SessionPayload) {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .setIssuedAt()
    .sign(getJwtSecret());

  const cookieStore = await cookies();
  const isProd = process.env.NODE_ENV === "production";
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Prod: iframe cross-origin do GHL exige SameSite=None+Secure. Dev (http
    // localhost): "none" sem "secure" é REJEITADO pelo browser → Lax pra sessão
    // funcionar no preview local.
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

/**
 * Le e valida a sessao do cookie
 */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Remove a sessao
 */
export async function destroySession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
