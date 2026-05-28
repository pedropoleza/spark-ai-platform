/**
 * /hub/campaigns/[id] — detail da campanha (Etapa 4.1 Commit C).
 *
 * Server wrapper: scope-check + load via loadHubCampaignDetail (anti-IDOR
 * por location_id). Render delegado pro client component CampaignDetailView
 * que controla os botões pause/resume/cancel.
 */
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/sso";
import { loadHubCampaignDetail } from "@/lib/hub/data";
import { ChevronLeft } from "lucide-react";
import { CampaignDetailView } from "./detail-view";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const campaign = await loadHubCampaignDetail(id, session.locationId);
  if (!campaign) notFound();

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <Link href="/hub/campaigns" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar pras campanhas
      </Link>
      <CampaignDetailView campaign={campaign} />
    </div>
  );
}
