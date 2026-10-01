import { type Fact, GLOBAL_SCOPE, type OrgView, projectScope } from "@majhi/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { ApiRequestError } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import {
  useApproveAllFacts,
  useMemoryEvents,
  useMemorySearch,
  useRejectAllFacts,
} from "@/lib/memory-queries";
import { AutoDecisions } from "./auto-decisions";
import { FactRow } from "./fact-row";
import { factsOf, GLOBAL, type ProjectOrgs, shownFact } from "./model";

/** Above this many active lessons, a search field helps. */
const SEARCH_FROM = 6;

/**
 * The lessons of one row: those waiting for the owner first, with Approve all and Reject all, then
 * the active ones, then what curation decided on its own. A project also gets its org's lessons.
 */
export function LessonsTab({
  target,
  facts,
  projectOrgs,
  orgs,
}: {
  target: string;
  facts: UseQueryResult<Fact[], ApiRequestError>;
  projectOrgs: ProjectOrgs;
  orgs: readonly OrgView[];
}) {
  const events = useMemoryEvents({ limit: 100 });
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const search = useMemorySearch(query);
  const searching = query.trim() !== "";
  const orgNames = useMemo(() => new Map(orgs.map((o) => [o.id, o.name])), [orgs]);
  const ownScope = target === GLOBAL ? GLOBAL_SCOPE : projectScope(target);

  const mine = useMemo(
    () => factsOf(target, facts.data ?? [], projectOrgs).filter(shownFact),
    [target, facts.data, projectOrgs],
  );
  const pending = mine.filter((f) => f.status === "pending");
  const active = useMemo(() => {
    const list = mine.filter((f) => f.status === "active");
    if (!searching) return list.toSorted((a, b) => Number(b.pinned) - Number(a.pinned));
    const ids = new Set(list.map((f) => f.id));
    return (search.data ?? []).map((h) => h.fact).filter((f) => ids.has(f.id));
  }, [mine, searching, search.data]);
  const byId = useMemo(() => new Map((facts.data ?? []).map((f) => [f.id, f])), [facts.data]);
  const mineIds = useMemo(() => new Set(mine.map((f) => f.id)), [mine]);
  const decisions = (events.data ?? []).filter((e) => mineIds.has(e.fact));
  const total = mine.filter((f) => f.status === "active").length;

  if (facts.isError) return <p className="pt-5 text-base text-red">{describeError(facts.error)}</p>;
  if (facts.isPending) return <Skeleton className="mt-5 h-32 rounded-lg" />;
  return (
    <>
      {pending.length > 0 && (
        <DetailSection
          title="Waiting for you"
          note={plural(pending.length, "lesson")}
          className="border-t-0"
          actions={<BulkReview ids={pending.map((f) => f.id)} />}
        >
          <ul aria-label="Lessons waiting for review" className="m-0 flex list-none flex-col p-0">
            {pending.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                orgNames={orgNames}
                projectOrgs={projectOrgs}
                ownScope={ownScope}
              />
            ))}
          </ul>
        </DetailSection>
      )}
      <DetailSection
        title="Active"
        note={total === 0 ? undefined : plural(total, "lesson")}
        {...(pending.length === 0 ? { className: "border-t-0" } : {})}
        actions={
          total >= SEARCH_FROM && (
            <div className="relative w-[240px]">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint"
              />
              <Input
                type="search"
                aria-label="Search lessons"
                placeholder="Search lessons"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="h-7 pl-8 text-sm"
              />
            </div>
          )
        }
      >
        {search.isError && <p className="text-sm text-red">{describeError(search.error)}</p>}
        {active.length === 0 && !(searching && search.isPending) ? (
          <p className="max-w-[72ch] text-base text-fg-muted text-pretty">
            {searching
              ? "No active lesson matches."
              : "No lessons here yet. The Housekeeper keeps at most three per finished task, and only when something went wrong in a way worth remembering. Only global lessons and contradictions wait for you."}
          </p>
        ) : (
          <ul aria-label="Active lessons" className="m-0 flex list-none flex-col p-0">
            {active.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                orgNames={orgNames}
                projectOrgs={projectOrgs}
                ownScope={ownScope}
              />
            ))}
          </ul>
        )}
      </DetailSection>
      <AutoDecisions events={decisions} facts={byId} error={events.error} />
    </>
  );
}

/** Approve all and Reject all for the lessons that wait, each behind a confirm. */
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
    <>
      <Button size="sm" variant="ghost" onClick={() => setConfirm("reject")}>
        Reject all
      </Button>
      <Button size="sm" variant="primary" onClick={() => setConfirm("approve")}>
        Approve all
      </Button>
      {confirm !== undefined && (
        <ConfirmDialog
          title={confirm === "approve" ? `Approve ${count}?` : `Reject ${count}?`}
          body={
            confirm === "approve"
              ? "They become active and later tasks get them in their brief. Each one can be undone from the log."
              : "They are kept as rejected, so none is lost. Each one can be undone."
          }
          confirmLabel={confirm === "approve" ? "Approve all" : "Reject all"}
          busy={approve.isPending || reject.isPending}
          error={problem}
          onCancel={close}
          onConfirm={() => run(confirm)}
        />
      )}
    </>
  );
}
