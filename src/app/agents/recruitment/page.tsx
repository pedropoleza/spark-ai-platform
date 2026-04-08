"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { RecruitmentConfigContent } from "./recruitment-config-content";

export default function RecruitmentAgentConfigPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
        </div>
      }
    >
      <RecruitmentConfigContent />
    </Suspense>
  );
}
