"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { SalesConfigContent } from "./sales-config-content";

export default function SalesAgentConfigPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
        </div>
      }
    >
      <SalesConfigContent />
    </Suspense>
  );
}
