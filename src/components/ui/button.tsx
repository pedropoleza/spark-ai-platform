import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-brand-500 text-white shadow-[0_1px_2px_0_rgba(22,117,242,0.2),inset_0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-brand-600 hover:shadow-[0_4px_12px_-2px_rgba(22,117,242,0.35)]",
        secondary:
          "bg-gray-100 text-gray-900 border border-gray-200 hover:bg-gray-200 hover:border-gray-300",
        outline:
          "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-900",
        ghost:
          "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
        destructive:
          "bg-red-600 text-white hover:bg-red-700 shadow-[0_1px_2px_0_rgba(220,38,38,0.2)]",
        link:
          "text-brand-500 underline-offset-4 hover:underline hover:text-brand-600",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
