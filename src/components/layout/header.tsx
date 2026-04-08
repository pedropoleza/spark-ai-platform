"use client";

import { useTenant } from "@/hooks/use-tenant";
import { MapPin } from "lucide-react";

export function Header() {
  const { locationName } = useTenant();

  return (
    <header className="h-16 border-b border-neutral-200 bg-white flex items-center justify-between px-8">
      <div className="flex items-center gap-2 text-sm text-neutral-500">
        <MapPin className="w-3.5 h-3.5" />
        <span>{locationName}</span>
      </div>
    </header>
  );
}
