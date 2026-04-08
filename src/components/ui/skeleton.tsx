import { cn } from "@/lib/utils/cn";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-lg bg-neutral-200", className)}
      {...props}
    />
  );
}

export { Skeleton };
