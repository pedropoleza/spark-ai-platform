import * as React from "react";
import { cn } from "@/lib/utils/cn";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-neutral-100",
          "placeholder:text-neutral-500",
          "transition-colors duration-150",
          "hover:border-white/20",
          "focus-visible:outline-none focus-visible:border-violet-500/60 focus-visible:ring-2 focus-visible:ring-violet-500/25",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "resize-y",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
