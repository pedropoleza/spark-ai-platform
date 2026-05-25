import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { loadEntitlementsGrid } from "@/lib/hub/data";
import { AccessTable } from "./access-table";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const session = await getSession();
  if (!session) redirect("/");
  if (!session.isAdmin) redirect("/hub");

  const rows = await loadEntitlementsGrid(session.companyId);
  return <AccessTable rows={rows} />;
}
