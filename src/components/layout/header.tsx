"use client";

import { useTenant } from "@/hooks/use-tenant";
import { MapPin } from "lucide-react";

export function Header() {
  const { locationName } = useTenant();

  return (
    <header className="h-16 border-b border-white/5 bg-black/20 backdrop-blur-xl flex items-center justify-between px-8">
      <div className="flex items-center gap-2 text-sm">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
          <MapPin className="w-3 h-3 text-violet-400" />
          <span className="text-neutral-300 text-xs font-medium">{locationName}</span>
        </div>
      </div>
    </header>
  );
}
