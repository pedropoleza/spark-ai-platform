import { redirect } from "next/navigation";
import { Shield } from "lucide-react";
import { getSession } from "@/lib/auth/sso";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const session = await getSession();
  if (!session) redirect("/");
  if (!session.isAdmin) redirect("/hub");

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Acessos</h1>
          <p className="page-hd__sub">Libere ou bloqueie agentes pagos por escritório.</p>
        </div>
      </div>
      <div className="card">
        <div className="empty">
          <Shield size={32} style={{ color: "var(--ink-4)" }} />
          <p style={{ marginTop: 12 }}>A liberação de acessos (entitlements) entra na fase de admin.</p>
        </div>
      </div>
    </div>
  );
}
