"use client";

import { ReactNode } from "react";
import { TenantProvider } from "@/hooks/use-tenant";
import { TopNav } from "@/components/layout/top-nav";
import type { SessionPayload } from "@/lib/auth/sso";

export function DashboardShell({
  children,
  session,
}: {
  children: ReactNode;
  session: SessionPayload;
}) {
  return (
    <TenantProvider
      value={{
        locationId: session.locationId,
        companyId: session.companyId,
        locationName: session.locationName,
        userId: session.userId,
      }}
    >
      <div className="flex flex-col h-screen bg-gray-50/50">
        <TopNav />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </TenantProvider>
  );
}
