"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, LayoutDashboard, Activity, DollarSign, Settings, Sparkles } from "lucide-react";
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
    <aside className="w-64 flex-shrink-0 flex flex-col h-screen border-r border-white/5 bg-black/40 backdrop-blur-xl">
      {/* Logo */}
      <div className="h-16 flex items-center gap-3 px-6 border-b border-white/5">
        <div className="relative">
          <div className="w-9 h-9 brand-gradient rounded-xl flex items-center justify-center shadow-[0_4px_20px_-4px_rgba(139,92,246,0.6)]">
            <Sparkles className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
          <div className="absolute inset-0 brand-gradient rounded-xl blur-lg opacity-40 -z-10" />
        </div>
        <div>
          <div className="font-semibold text-neutral-100 leading-tight tracking-tight">Spark AI</div>
          <div className="text-[10px] text-neutral-500 leading-tight">Hub de comando</div>
        </div>
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
                "group relative flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all duration-200",
                isActive
                  ? "bg-white/8 text-white font-medium shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]"
                  : "text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 brand-gradient rounded-r-full" />
              )}
              <Icon className={cn("w-4 h-4 transition-colors", isActive ? "text-violet-300" : "text-neutral-500 group-hover:text-neutral-300")} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-white/5">
        <div className="flex items-center gap-2">
          <Bot className="w-3 h-3 text-neutral-500" />
          <p className="text-[10px] text-neutral-500">Platform v0.1</p>
        </div>
      </div>
    </aside>
  );
}
