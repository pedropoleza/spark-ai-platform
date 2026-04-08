import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-neutral-900 text-white",
        secondary: "border-transparent bg-neutral-100 text-neutral-700",
        success: "border-transparent bg-green-100 text-green-800",
        warning: "border-transparent bg-amber-100 text-amber-800",
        destructive: "border-transparent bg-red-100 text-red-800",
        outline: "border-neutral-200 text-neutral-700",
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
