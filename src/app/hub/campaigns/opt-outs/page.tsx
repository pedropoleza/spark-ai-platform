/**
 * /hub/campaigns/opt-outs — Lista de contatos opt-out + custom keywords.
 * Etapa 4.8 (Pedro 2026-05-28).
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { listActiveKeywords } from "@/lib/account-assistant/proactive/optout-detector";
import { OptOutManager } from "./opt-out-manager";

export const dynamic = "force-dynamic";

export default async function OptOutsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const supabase = createAdminClient();
  const [{ data: optouts }, keywords] = await Promise.all([
    supabase
      .from("outreach_optouts")
      .select("id, contact_id, source, reason, created_at")
      .eq("location_id", session.locationId)
      .order("created_at", { ascending: false })
      .limit(500),
    listActiveKeywords(session.locationId),
  ]);

  type Row = {
    id: string;
    contact_id: string;
    source: string;
    reason: string | null;
    created_at: string;
  };

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Opt-outs (descadastros)</h1>
          <p className="page-hd__sub">
            Contatos que pediram pra não receber mais mensagens (STOP, PARAR, etc) ou foram marcados manualmente pelo admin.
          </p>
        </div>
      </div>

      <OptOutManager
        initialOptouts={(optouts as Row[] | null) || []}
        defaultKeywords={keywords.default}
        initialCustomKeywords={keywords.custom}
      />
    </div>
  );
}
