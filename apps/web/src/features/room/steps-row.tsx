import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";

/** What an agent did between two messages, folded into one line. The steps draw only once opened. */
export function StepsRow({
  count,
  className,
  children,
}: {
  count: number;
  className?: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cn("list-none", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs text-fg-faint hover:text-fg-soft"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {count} {count === 1 ? "step" : "steps"} it took
      </button>
      {open && <ol className="m-0 mt-1 flex flex-col p-0 pl-3">{children}</ol>}
    </li>
  );
}
