/**
 * /hub/campaigns/recurring/new — wrapper server (Etapa 4.5).
 *
 * Carrega agentes lead-facing da location e passa pro wizard client.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { RecurringWizard, type AgentChoice } from "./recurring-wizard";

export const dynamic = "force-dynamic";

export default async function NewRecurringCampaignPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const supabase = createAdminClient();
  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, template_key, type")
    .eq("location_id", session.locationId)
    .eq("status", "active")
    .in("type", ["sales_agent", "recruitment_agent", "custom_agent"])
    .order("name", { ascending: true });

  type AgentRow = { id: string; name: string; template_key: string | null; type: string };
  const choices: AgentChoice[] = ((agents || []) as AgentRow[]).map((a) => ({
    id: a.id,
    name: a.name,
    templateKey: a.template_key || (a.type === "sales_agent" ? "sales" : a.type === "recruitment_agent" ? "recruitment" : "custom"),
  }));

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Nova campanha recorrente</h1>
          <p className="page-hd__sub">Cron-style: dispara automaticamente no horário/dia configurado, com lista atualizada a cada execução.</p>
        </div>
      </div>
      {choices.length === 0 ? (
        <div className="card">
          <div className="empty" style={{ padding: 40, textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
              Nenhum agente lead-facing ativo
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Crie um agente de Vendas, Recrutamento ou Personalizado primeiro.
            </div>
          </div>
        </div>
      ) : (
        <RecurringWizard agents={choices} />
      )}
    </div>
  );
}
