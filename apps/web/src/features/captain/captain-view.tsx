import { useNavigate, useSearch } from "@tanstack/react-router";
import { Ship } from "lucide-react";
import { Problem } from "@/components/problem";
import { Segmented } from "@/components/ui/segmented";
import { useCaptainStatus } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { FindingsSheet } from "./findings";
import { FullLog } from "./log";
import { ScorecardSheet } from "./scorecard";

type View = "history" | "results" | "findings";

const VIEWS: readonly { value: View; label: string }[] = [
  { value: "history", label: "History" },
  { value: "results", label: "Results" },
  { value: "findings", label: "Findings" },
];

/** The view an old `?tab=` link asked for: the log is History, findings are Findings. */
function viewOf(tab: string | undefined): View {
  if (tab === "findings") return "findings";
  if (tab === "results") return "results";
  return "history";
}

/**
 * The Captain page in Settings: what the captain did (History), how it turned out (Results) and what it and the
 * agents noticed (Findings). Talking to it, its switch and its rules live elsewhere: the console, the top bar and
 * each workspace's settings.
 */
export function CaptainView() {
  const query = useCaptainStatus();
  const status = query.data;
  const now = useNow(30_000);
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const view = viewOf(search.tab);

  if (query.isError)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Problem icon={<Ship />} title="Could not load the captain" body={describeError(query.error)} />
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className={cn(
          "mb-3 flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl px-3.5 py-1.5",
          GLASS,
        )}
      >
        <h1 className="text-lg leading-5 font-semibold text-fg">Captain</h1>
        <Segmented
          label="Captain view"
          value={view}
          onChange={(next) =>
            void navigate({
              to: ".",
              replace: true,
              search: (prev: AppSearch) => ({ ...prev, tab: next === "history" ? undefined : next }),
            } as never)
          }
          segments={VIEWS}
        />
      </header>
      <section
        aria-label={VIEWS.find((v) => v.value === view)?.label}
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-2xl p-4", GLASS)}
      >
        {view === "history" && status && <FullLog orgs={status.orgs} now={now} />}
        {view === "results" && <ScorecardSheet />}
        {view === "findings" && status && (
          <FindingsSheet orgs={status.orgs} now={now} focus={Number(search.id) || undefined} />
        )}
      </section>
    </div>
  );
}
