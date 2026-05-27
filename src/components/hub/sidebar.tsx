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

  const renderLink = (it: NavItem) => {
    const Icon = it.icon;
    // title + aria-label: quando a sidebar colapsa (≤880px) o <span> some via CSS
    // — sem isso o link vira só ícone, sem nome acessível nem tooltip (fix C1
    // ultra-review 2026-05-26).
    return (
      <Link key={it.id} href={it.href} className="sb__link" title={it.label} aria-label={it.label} aria-current={isActive(pathname, it.href) ? "true" : undefined}>
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

      {/* Sem switcher de conta / rodapé de usuário: a sidebar do GHL (à esquerda)
          já mostra conta + usuário — repetir aqui duplicaria (Pedro 2026-05-25). */}
      <nav>{PRIMARY.map(renderLink)}</nav>

      {session.isAdmin && (
        <>
          <div className="sb__group">Administração</div>
          <nav>{ADMIN.map(renderLink)}</nav>
        </>
      )}
    </aside>
  );
}
