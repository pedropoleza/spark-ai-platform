"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SessionPayload } from "@/lib/auth/sso";

/**
 * Sessão do /hub. Espelha o SessionPayload do SSO (inclui isAdmin, que o
 * TenantProvider antigo não carrega). Provider próprio pra não tocar no
 * use-tenant compartilhado com o /dashboard.
 */
const HubSessionContext = createContext<SessionPayload | null>(null);

export function HubSessionProvider({
  session,
  children,
}: {
  session: SessionPayload;
  children: ReactNode;
}) {
  return <HubSessionContext.Provider value={session}>{children}</HubSessionContext.Provider>;
}

export function useHubSession(): SessionPayload {
  const ctx = useContext(HubSessionContext);
  if (!ctx) throw new Error("useHubSession deve ser usado dentro de HubSessionProvider");
  return ctx;
}
