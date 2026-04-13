import * as React from "react";
import { cn } from "@/lib/utils/cn";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-neutral-100",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-neutral-200",
          "placeholder:text-neutral-500",
          "transition-colors duration-150",
          "hover:border-white/20",
          "focus-visible:outline-none focus-visible:border-violet-500/60 focus-visible:ring-2 focus-visible:ring-violet-500/25",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
