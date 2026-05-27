"use client";

import Link from "next/link";
import { Fragment } from "react";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
const SECTION_LABEL: Record<string, string> = {
  agents: "Agentes",
  messages: "Mensagens",
  billing: "Faturamento",
  settings: "Conta",
  access: "Acessos",
};

// Breadcrumb sem nome da conta — a sidebar do GHL já mostra (Pedro 2026-05-25).
function buildCrumbs(pathname: string): string[] {
  const segs = pathname.split("/").filter(Boolean); // ["hub", "agents", ...]
  const crumbs = ["Spark Hub"];
  if (segs.length <= 1) {
    crumbs.push("Início");
    return crumbs;
  }
  crumbs.push(SECTION_LABEL[segs[1]] || "Início");
  if (segs[1] === "agents" && segs[2] === "new") crumbs.push("Novo agente");
  return crumbs;
}

export function TopBar() {
  const pathname = usePathname();
  const crumbs = buildCrumbs(pathname);

  return (
    <header className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {i === crumbs.length - 1 ? <em>{c}</em> : <span>{c}</span>}
          </Fragment>
        ))}
      </div>
      {/* Busca global + sino removidos (eram placeholders sem handler). Voltam
          quando houver implementação real. (ultra-review 2026-05-26) */}
      <div className="row" style={{ gap: 10 }}>
        {/* C1-P2e (ultra-review 2026-05-26): esconde o CTA dentro do próprio
            wizard de criação — antes "Novo agente" aparecia até em /hub/agents/new. */}
        {!pathname.startsWith("/hub/agents/new") && (
          <Link href="/hub/agents/new" className="btn btn--primary">
            <Plus /> Novo agente
          </Link>
        )}
      </div>
    </header>
  );
}
