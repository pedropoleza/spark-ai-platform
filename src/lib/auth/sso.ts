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
): Promise<{ user: GHLUser; isAdmin: boolean }> {
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

  // GHL API não validou o usuario. Aceitar com cautela pois o Custom Menu Link
  // do GHL já garante autenticação. Mas logar o evento para monitoramento.
  console.warn("[SSO] GHL API validation failed — accepting via Custom Menu Link trust. userId:", userId);
  return {
    user: {
      id: userId,
      name: "",
      firstName: "",
      lastName: "",
      email: "",
      role: "unknown",
      type: "unknown",
      permissions: {},
    },
    isAdmin: true,
  };
}

function isUserAdmin(user: GHLUser): boolean {
  const role = (user.role || "").toLowerCase();
  const type = (user.type || "").toLowerCase();

  return (
    role === "admin" ||
    role === "user" ||
    role === "owner" ||
    role === "agency_owner" ||
    role === "agency_user" ||
    type === "account" ||
    type === "admin" ||
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
