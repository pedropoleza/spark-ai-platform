"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { PostSalesConfigContent } from "./post-sales-config-content";

export default function PostSalesAgentConfigPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
        </div>
      }
    >
      <PostSalesConfigContent />
    </Suspense>
  );
}
