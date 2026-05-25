"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Layers, Mail, CreditCard, Settings, Shield, Zap, type LucideIcon } from "lucide-react";
import { useHubSession } from "./hub-session";

type NavItem = { id: string; label: string; href: string; icon: LucideIcon };

const PRIMARY: NavItem[] = [
  { id: "home", label: "Início", href: "/hub", icon: Home },
  { id: "agents", label: "Agentes", href: "/hub/agents", icon: Layers },
  { id: "messages", label: "Mensagens", href: "/hub/messages", icon: Mail },
  { id: "billing", label: "Faturamento", href: "/hub/billing", icon: CreditCard },
  { id: "settings", label: "Conta", href: "/hub/settings", icon: Settings },
];

const ADMIN: NavItem[] = [{ id: "access", label: "Acessos", href: "/hub/access", icon: Shield }];

function isActive(pathname: string, href: string): boolean {
  if (href === "/hub") return pathname === "/hub";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Sidebar() {
  const pathname = usePathname();
  const session = useHubSession();
  const workspace = session.locationName || "Minha conta";
  const initial = (workspace.trim()[0] || "S").toUpperCase();

  const renderLink = (it: NavItem) => {
    const Icon = it.icon;
    return (
      <Link key={it.id} href={it.href} className="sb__link" aria-current={isActive(pathname, it.href) ? "true" : undefined}>
        <Icon />
        <span>{it.label}</span>
      </Link>
    );
  };

  return (
    <aside className="sb">
      <div className="sb__brand">
        <div className="sb__mark">
          <Zap size={16} />
        </div>
        <div className="sb__word">
          Spark <span>Hub</span>
        </div>
      </div>

      <div className="sb__loc">
        <div>
          <div className="sb__loc-name" title={workspace}>
            {workspace}
          </div>
          <div className="sb__loc-meta">Conta ativa</div>
        </div>
      </div>

      <nav>{PRIMARY.map(renderLink)}</nav>

      {session.isAdmin && (
        <>
          <div className="sb__group">Administração</div>
          <nav>{ADMIN.map(renderLink)}</nav>
        </>
      )}

      <div className="sb__foot">
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            background: "var(--primary)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 600,
            flex: "0 0 32px",
          }}
        >
          {initial}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="sb__foot-name">Minha conta</div>
          <div className="sb__foot-role">{session.isAdmin ? "Administrador" : "Operador"}</div>
        </div>
      </div>
    </aside>
  );
}
