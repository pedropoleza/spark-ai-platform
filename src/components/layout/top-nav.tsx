"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Activity, DollarSign, Settings, Sparkles, Search } from "lucide-react";
import { useTenant } from "@/hooks/use-tenant";
import { cn } from "@/lib/utils/cn";

const navItems = [
  { label: "Hub de Agentes", href: "/dashboard", icon: LayoutDashboard },
  { label: "Atividade", href: "/dashboard/activity", icon: Activity },
  { label: "Billing", href: "/dashboard/billing", icon: DollarSign },
  { label: "Configurações", href: "/dashboard/settings", icon: Settings },
];

export function TopNav() {
  const pathname = usePathname();
  const { locationName } = useTenant();

  return (
    <div className="relative border-b border-gray-200 bg-white">
      {/* Linha azul fina no topo */}
      <div className="absolute top-0 left-0 right-0 h-0.5 brand-gradient" />
      {/* Top row: brand + search + tenant */}
      <div className="mx-auto w-full max-w-[1600px] flex items-center justify-between gap-6 px-6 lg:px-10 xl:px-14 h-16">
        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-3 group">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl brand-gradient flex items-center justify-center shadow-[0_4px_14px_-4px_rgba(22,117,242,0.5)]">
              <Sparkles className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
          </div>
          <div className="hidden sm:block">
            <div className="font-semibold text-gray-900 leading-tight tracking-tight">Matrix AI Hub</div>
            <div className="text-[10px] text-gray-500 leading-tight">Hub de comando</div>
          </div>
        </Link>

        {/* Search */}
        <div className="flex-1 max-w-xl hidden md:block">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar agentes, conversas, contatos..."
              className="w-full h-10 pl-10 pr-4 rounded-lg border border-gray-200 bg-gray-50/60 text-sm text-gray-900 placeholder:text-gray-400 transition-all hover:border-gray-300 focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15"
            />
          </div>
        </div>

        {/* Tenant pill */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-brand-50 border border-brand-100">
            <div className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
            <span className="text-xs font-medium text-brand-700 truncate max-w-[180px]">
              {locationName}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom row: module tabs on subtle gray bar */}
      <nav className="-mb-px overflow-x-auto bg-gray-50/70 border-t border-gray-100">
        <div className="mx-auto w-full max-w-[1600px] px-6 lg:px-10 xl:px-14 flex items-center gap-1 min-w-min">
          {navItems.map((item) => {
            const isActive = item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-active={isActive}
                className={cn(
                  "module-tab mb-2.5 mt-1",
                )}
              >
                <Icon className={cn("w-4 h-4", isActive ? "text-brand-500" : "text-gray-400")} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
