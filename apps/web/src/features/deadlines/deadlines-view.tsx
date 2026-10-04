import { ListDetail } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { useDeadlines } from "@/lib/deadline-queries";
import { GLASS } from "@/lib/glass";
import { DeadlinesPane } from "./deadlines-pane";
import { useScopes } from "./parts";

/** Deadlines: hackathons, grants, launches, client dates and renewals, each in its own time zone. */
export function DeadlinesView() {
  const scopes = useScopes();
  const list = useDeadlines().data?.deadlines;
  const open = list?.filter((d) => d.status === "open").length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={cn("mb-3 flex min-h-11 shrink-0 items-center gap-4 rounded-2xl px-4 py-2", GLASS)}>
        <h1 className="text-md leading-5 font-semibold text-fg">Deadlines</h1>
        {open !== undefined && <span className="tnum font-mono text-xs text-fg-faint">{open} open</span>}
      </header>
      <ListDetail>
        <DeadlinesPane scopes={scopes} />
      </ListDetail>
    </div>
  );
}
