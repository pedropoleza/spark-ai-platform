"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils/cn";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-11 items-center justify-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1 text-neutral-400 backdrop-blur-sm",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex items-center justify-center whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition-all duration-200",
      "text-neutral-400 hover:text-neutral-200",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40",
      "disabled:pointer-events-none disabled:opacity-50",
      "data-[state=active]:bg-white/8 data-[state=active]:text-white",
      "data-[state=active]:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(139,92,246,0.25),0_4px_12px_-4px_rgba(139,92,246,0.3)]",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-6 animate-fade-in focus-visible:outline-none",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
