import { createContext, type ReactNode, useContext } from "react";
import { cn } from "@/lib/cn";

/** Set by the app shell, whose own `<main>` already holds the page: there a centered page is a plain block. */
export const InShellContext = createContext(false);

/** The page layout for single-task screens: one centered column, set a little above the middle. */
export function CenteredPage({ children, className }: { children: ReactNode; className?: string }) {
  const inShell = useContext(InShellContext);
  const Tag = inShell ? "div" : "main";
  return (
    <Tag className="flex min-h-0 flex-1 justify-center overflow-auto px-6 pt-[10vh] pb-16">
      <div className={cn("flex w-full max-w-[600px] flex-col gap-6", className)}>{children}</div>
    </Tag>
  );
}
