import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { DashboardShell } from "../dashboard/dashboard-shell";

export default async function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    redirect("/");
  }

  return (
    <DashboardShell session={session}>
      {children}
    </DashboardShell>
  );
}
