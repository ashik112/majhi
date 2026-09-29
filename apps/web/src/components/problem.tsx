import type { ReactNode } from "react";
import { CenteredPage } from "@/components/centered-page";
import { cn } from "@/lib/cn";

/**
 * A full-screen message for a state the owner has to act on: config errors, the server not
 * answering, a missing page. Title and one line of body, then whatever the fix needs.
 */
export function Problem({
  icon,
  tone = "neutral",
  title,
  body,
  children,
}: {
  icon: ReactNode;
  tone?: "neutral" | "red" | "amber";
  title: string;
  body: ReactNode;
  children?: ReactNode;
}) {
  return (
    <CenteredPage>
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2.5 text-lg font-semibold text-balance">
          <span
            aria-hidden="true"
            className={cn(
              "flex [&_svg]:size-[18px]",
              tone === "red" && "text-red",
              tone === "amber" && "text-amber",
              tone === "neutral" && "text-fg-muted",
            )}
          >
            {icon}
          </span>
          {title}
        </h1>
        <p className="max-w-[65ch] text-base text-fg-muted text-pretty">{body}</p>
      </div>
      {children}
    </CenteredPage>
  );
}
