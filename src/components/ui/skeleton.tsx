import { cn } from "@/lib/utils/cn";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-lg bg-gray-100 border border-gray-200/60", className)}
      {...props}
    />
  );
}

export { Skeleton };
