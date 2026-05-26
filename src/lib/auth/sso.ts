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

  // Tentar buscar lista de usuarios
  try {
    const response = await client.get<{ users: GHLUser[] }>("/users/", {
      locationId,
    });

    console.log("[SSO] Users response count:", response.users?.length);

    const user = response.users?.find((u) => u.id === userId);
    if (user) {
      console.log("[SSO] User found:", { id: user.id, role: user.role, type: user.type });
      return { user, isAdmin: isUserAdmin(user) };
    }
  } catch (err) {
    console.log("[SSO] Users list failed:", err instanceof Error ? err.message : err);
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

  // GHL API não validou — aceitar com permissão limitada.
  // O Custom Menu Link do GHL já autentica o usuário. Se a API falhar
  // (GHL instável, rate limit, etc), permitimos acesso mas sem admin.
  console.warn("[SSO] GHL API validation failed — accepting with limited access. userId:", userId);
  return {
    user: { id: userId, name: "", firstName: "", lastName: "", email: "",
            role: "user", type: "user", permissions: {} },
    isAdmin: false,
  };
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
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none", // Necessario para iframe cross-origin (GHL)
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
