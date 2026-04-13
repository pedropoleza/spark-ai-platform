"use client";

import { ReactNode } from "react";
import { TenantProvider } from "@/hooks/use-tenant";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
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
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <Header />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </TenantProvider>
  );
}
