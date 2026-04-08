"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, LayoutDashboard, Activity, DollarSign, Settings } from "lucide-react";
import { cn } from "@/lib/utils/cn";

const navItems = [
  {
    label: "Hub de Agentes",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    label: "Atividade",
    href: "/dashboard/activity",
    icon: Activity,
  },
  {
    label: "Billing",
    href: "/dashboard/billing",
    icon: DollarSign,
  },
  {
    label: "Configuracoes",
    href: "/dashboard/settings",
    icon: Settings,
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-neutral-200 bg-neutral-50 flex flex-col h-screen">
      {/* Logo */}
      <div className="h-16 flex items-center gap-2.5 px-6 border-b border-neutral-200">
        <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-neutral-900">Spark AI</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors",
                isActive
                  ? "bg-white text-neutral-900 shadow-sm font-medium"
                  : "text-neutral-600 hover:bg-white hover:text-neutral-900"
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-neutral-200">
        <p className="text-xs text-neutral-400">Spark AI Platform v0.1</p>
      </div>
    </aside>
  );
}
