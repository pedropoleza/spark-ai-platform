import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-violet-500/30 bg-violet-500/15 text-violet-200",
        secondary:
          "border-white/10 bg-white/5 text-neutral-300",
        success:
          "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
        warning:
          "border-amber-500/30 bg-amber-500/15 text-amber-300",
        destructive:
          "border-red-500/30 bg-red-500/15 text-red-300",
        outline:
          "border-white/15 text-neutral-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
