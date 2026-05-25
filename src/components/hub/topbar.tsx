"use client";

import Link from "next/link";
import { Fragment } from "react";
import { usePathname } from "next/navigation";
import { Search, Bell, Plus } from "lucide-react";
import { useHubSession } from "./hub-session";

const SECTION_LABEL: Record<string, string> = {
  agents: "Agentes",
  messages: "Mensagens",
  billing: "Faturamento",
  settings: "Conta",
  access: "Acessos",
};

function buildCrumbs(pathname: string, workspace: string): string[] {
  const segs = pathname.split("/").filter(Boolean); // ["hub", "agents", ...]
  const crumbs = ["Spark Hub", workspace];
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
  const session = useHubSession();
  const crumbs = buildCrumbs(pathname, session.locationName || "Minha conta");

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
      <div className="row" style={{ gap: 10 }}>
        <div className="searchbox">
          <Search size={14} />
          <input placeholder="Buscar…" aria-label="Buscar" />
          <kbd>⌘K</kbd>
        </div>
        <button className="btn btn--quiet btn--icon" title="Notificações" aria-label="Notificações">
          <Bell />
        </button>
        <Link href="/hub/agents/new" className="btn btn--primary">
          <Plus /> Novo agente
        </Link>
      </div>
    </header>
  );
}
