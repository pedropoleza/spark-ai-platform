"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { AccountAssistantConfigContent } from "./account-assistant-config-content";

export default function AccountAssistantConfigPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
        </div>
      }
    >
      <AccountAssistantConfigContent />
    </Suspense>
  );
}
