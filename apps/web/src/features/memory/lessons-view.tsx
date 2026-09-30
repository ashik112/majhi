import type { Fact, OrgView } from "@majhi/shared";
import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import {
  useApproveAllFacts,
  useFacts,
  useMemoryEvents,
  useMemorySearch,
  useRejectAllFacts,
} from "@/lib/memory-queries";
import { AutoDecisions } from "./auto-decisions";
import { FactRow } from "./fact-row";
import { inFilter, type ProjectOrgs, type ScopeFilter, shownFact } from "./model";

/**
 * Lessons: the few hard-won gotchas memory keeps, with search, scope filters and the review list.
 * Only global lessons and contradictions wait for the owner; Approve all and Reject all clear the
 * list in one step, and each fact's step can still be undone.
 */
export function LessonsView({
  orgs,
  orgNames,
  projectOrgs,
}: {
  orgs: readonly OrgView[];
  orgNames: ReadonlyMap<string, string>;
  projectOrgs: ProjectOrgs;
}) {
  const facts = useFacts();
  const events = useMemoryEvents({ limit: 100 });
  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const search = useMemorySearch(query);
  const searching = query.trim() !== "";

  const byId = useMemo(() => new Map((facts.data ?? []).map((f) => [f.id, f])), [facts.data]);
  const shown = useMemo(() => (facts.data ?? []).filter(shownFact), [facts.data]);
  const rows = useMemo(() => {
    const source: Fact[] = searching ? (search.data ?? []).map((h) => h.fact) : shown;
    const inScope = source.filter((f) => inFilter(f, filter, projectOrgs));
    // Search order is the ranking; the list puts what waits for the owner first, then pinned ones.
    if (searching) return inScope;
    return [...inScope].sort((a, b) => rank(a) - rank(b));
  }, [searching, search.data, shown, filter, projectOrgs]);

  const pending = shown.filter((f) => f.status === "pending");
  const chips: { value: ScopeFilter; label: string; count: number; alert?: boolean }[] = [
    { value: "all", label: "All", count: shown.length },
    { value: "global", label: "Global", count: shown.filter((f) => f.scope === "global").length },
    ...orgs.map((o) => ({
      value: `org:${o.id}` as const,
      label: o.name,
      count: shown.filter((f) => inFilter(f, `org:${o.id}`, projectOrgs)).length,
    })),
    { value: "review", label: "Needs review", count: pending.length, alert: pending.length > 0 },
  ];
  const reviewIds = filter === "review" && !searching ? rows.map((f) => f.id) : [];

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-base text-fg-muted text-pretty">
        Gotchas learned the hard way, at most three per task. Rules already in a repo's CLAUDE.md, AGENTS.md
        or README are left out. Only global lessons and contradictions wait for you.
      </p>
      <fieldset aria-label="Lesson scope" className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
        {chips.map((chip) => (
          <ChoiceChip key={chip.value} pressed={chip.value === filter} onClick={() => setFilter(chip.value)}>
            <span className="max-w-[200px] truncate">{chip.label}</span>
            <span
              className={cn("font-mono text-xs tabular-nums", chip.alert ? "text-coral" : "text-fg-faint")}
            >
              {chip.count}
            </span>
          </ChoiceChip>
        ))}
      </fieldset>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
        />
        <Input
          type="search"
          aria-label="Search lessons"
          placeholder="Search lessons by meaning or words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-11 pl-9"
        />
      </div>

      {reviewIds.length > 0 && <BulkReview ids={reviewIds} />}

      {facts.isError && <p className="m-0 text-base text-red">{describeError(facts.error)}</p>}
      {search.isError && <p className="m-0 text-base text-red">{describeError(search.error)}</p>}
      {facts.isPending && <Skeleton className="h-20 w-full rounded-xl" />}
      {facts.data && (
        <section aria-label={searching ? "Search results" : "Lessons"} className="flex flex-col gap-2">
          {searching && !search.isPending && (
            <p className="m-0 text-sm text-fg-faint">
              {rows.length} {rows.length === 1 ? "match" : "matches"} among active lessons
            </p>
          )}
          {rows.length === 0 && !(searching && search.isPending) ? (
            <p className="m-0 text-base text-fg-muted text-pretty">{emptyText(filter, searching)}</p>
          ) : (
            <ul aria-label="Lessons" className="m-0 flex list-none flex-col gap-2 p-0">
              {rows.map((fact) => (
                <FactRow key={fact.id} fact={fact} orgNames={orgNames} />
              ))}
            </ul>
          )}
        </section>
      )}

      <AutoDecisions events={events.data ?? []} facts={byId} error={events.error} />
    </div>
  );
}

/** Approve all and Reject all for the pending lessons shown, each behind a confirm. */
function BulkReview({ ids }: { ids: readonly number[] }) {
  const approve = useApproveAllFacts();
  const reject = useRejectAllFacts();
  const toast = useToast();
  const [confirm, setConfirm] = useState<"approve" | "reject">();
  const [problem, setProblem] = useState<string>();
  const count = plural(ids.length, "lesson");
  const close = () => {
    setConfirm(undefined);
    setProblem(undefined);
  };
  const run = (which: "approve" | "reject") => {
    const mutation = which === "approve" ? approve : reject;
    mutation.mutate(
      { ids: [...ids] },
      {
        onSuccess: (out) => {
          close();
          toast(`${which === "approve" ? "Approved" : "Rejected"} ${plural(out.count, "lesson")}`);
        },
        onError: (e) => setProblem(describeError(e)),
      },
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-strong bg-card px-4 py-2.5">
      <p className="m-0 min-w-0 flex-1 text-base text-fg-muted">{count} waiting for you.</p>
      <Button size="sm" variant="primary" onClick={() => setConfirm("approve")}>
        Approve all
      </Button>
      <Button size="sm" onClick={() => setConfirm("reject")}>
        Reject all
      </Button>
      {confirm !== undefined && (
        <ConfirmDialog
          title={confirm === "approve" ? `Approve ${count}?` : `Reject ${count}?`}
          body={
            confirm === "approve"
              ? "They become active and later tasks get them in their brief. Each one can be undone from the log."
              : "They are kept as rejected, so none is lost. Each one can be undone from the log."
          }
          confirmLabel={confirm === "approve" ? "Approve all" : "Reject all"}
          busy={approve.isPending || reject.isPending}
          error={problem}
          onCancel={close}
          onConfirm={() => run(confirm)}
        />
      )}
    </div>
  );
}

/** Waiting lessons first, then pinned ones. */
function rank(fact: Fact): number {
  return fact.status === "pending" ? 0 : fact.pinned ? 1 : 2;
}

function emptyText(filter: ScopeFilter, searching: boolean): string {
  if (searching) return "No active lesson matches. Lessons that wait for review are under Needs review.";
  if (filter === "review") return "Nothing waits for you.";
  return "No lessons here yet. The Housekeeper keeps at most three per finished task, and only when something went wrong in a way worth remembering.";
}
