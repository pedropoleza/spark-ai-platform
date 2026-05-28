/**
 * /hub/campaigns/new — wrapper server pra criar campanha (Etapa 4.1 Commit B).
 *
 * Carrega lista de agentes lead-facing ATIVOS da location (são os únicos que
 * podem disparar campanha). Se nenhum, mostra empty state com link pra criar.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/sso";
import { loadHubAgents } from "@/lib/hub/data";
import { ChevronLeft } from "lucide-react";
import { CampaignWizard, type AgentChoice } from "./campaign-wizard";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const agents = await loadHubAgents(session.locationId);
  const leadAgents: AgentChoice[] = agents
    .filter((a) => a.audience === "lead" && a.status === "active")
    .map((a) => ({
      id: a.id,
      name: a.name,
      templateKey: a.template_key,
    }));

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <Link href="/hub/campaigns" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar pras campanhas
      </Link>
      <h1 className="page-hd__title" style={{ marginBottom: 4 }}>Nova campanha</h1>
      <p className="page-hd__sub" style={{ marginBottom: 20 }}>
        Escolha o agente, defina o filtro de contatos e a mensagem.
      </p>

      {leadAgents.length === 0 ? (
        <div className="card">
          <div className="empty" style={{ padding: "40px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Nenhum agente ativo pra disparar</div>
            <div className="muted" style={{ fontSize: 12.5, maxWidth: 420, margin: "0 auto 16px", lineHeight: 1.5 }}>
              Campanhas precisam de um agente lead-facing (Vendas, Recrutamento ou Custom) ativo nesta sub-account.
            </div>
            <Link href="/hub/agents/new" className="btn btn--primary btn--sm">
              Criar um agente
            </Link>
          </div>
        </div>
      ) : (
        <CampaignWizard agents={leadAgents} />
      )}
    </div>
  );
}
