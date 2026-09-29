import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The page layout for single-task screens: one centered column, set a little above the middle. */
export function CenteredPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className="flex min-h-0 flex-1 justify-center overflow-auto px-6 pt-[10vh] pb-16">
      <div className={cn("flex w-full max-w-[600px] flex-col gap-6", className)}>{children}</div>
    </main>
  );
}
