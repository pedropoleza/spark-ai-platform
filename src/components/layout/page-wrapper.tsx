import { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface PageWrapperProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function PageWrapper({
  title,
  subtitle,
  backHref,
  actions,
  children,
  className,
}: PageWrapperProps) {
  return (
    <div className={cn("flex-1 overflow-y-auto", className)}>
      <div className="max-w-5xl mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            {backHref && (
              <Link
                href={backHref}
                className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-violet-300 mb-3 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Voltar
              </Link>
            )}
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-50">{title}</h1>
            {subtitle && (
              <p className="text-sm text-neutral-400 mt-1">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-3">{actions}</div>}
        </div>

        {/* Content */}
        {children}
      </div>
    </div>
  );
}
