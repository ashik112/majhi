import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A plain-sentence problem with what to do about it, for any call that failed. */
export function Problem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        "m-0 flex items-start gap-2 rounded-lg border border-red-line bg-red-wash px-3 py-2.5 text-base text-pretty text-red",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
