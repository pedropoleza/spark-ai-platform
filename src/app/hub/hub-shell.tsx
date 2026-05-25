"use client";

import { type ReactNode } from "react";
import type { SessionPayload } from "@/lib/auth/sso";
import { HubSessionProvider } from "@/components/hub/hub-session";
import { Sidebar } from "@/components/hub/sidebar";
import { TopBar } from "@/components/hub/topbar";

/**
 * Shell do /hub: sidebar clara + topbar, scoped em .hub-root (tokens v3 não
 * vazam pro /dashboard). Tema/densidade ficam em data-attrs (Conta liga o
 * toggle na Fase H). Embedável no Spark Leads (iframe) — sem chrome externo.
 */
export function HubShell({ session, children }: { session: SessionPayload; children: ReactNode }) {
  return (
    <HubSessionProvider session={session}>
      <div className="hub-root" data-theme="light" data-density="regular">
        <div className="hub-app">
          <Sidebar />
          <div className="hub-main">
            <TopBar />
            <main className="content scroll">{children}</main>
          </div>
        </div>
      </div>
    </HubSessionProvider>
  );
}
