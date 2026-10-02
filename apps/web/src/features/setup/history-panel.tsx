import { Undo2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { useToast } from "@/components/ui/toast";
import { historyRow } from "@/features/boss/model";
import { useHistory, useUndo } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useNow } from "@/lib/use-now";

/** Rows per page; `history.list` gives at most 200. */
const PAGE = 20;
const MOST = 200;

/** The config changes, by the owner, the captain or a hand edit, newest first, each with Undo. */
export function HistorySection() {
  const [limit, setLimit] = useState(PAGE);
  const history = useHistory(limit);
  const undo = useUndo();
  const toast = useToast();
  const now = useNow(60_000);
  const rows = (history.data ?? []).map((entry) => historyRow(entry, now));
  const more = history.data !== undefined && history.data.length === limit && limit < MOST;

  return (
    <DetailSection
      title="Changes"
      note={history.data ? `Newest first, ${rows.length} shown` : undefined}
      className="border-t-0"
    >
      {history.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {history.isError && <p className="text-sm text-red">{describeError(history.error)}</p>}
      {history.data && rows.length === 0 && <p className="text-sm text-fg-faint">No changes yet.</p>}
      {rows.length > 0 && (
        <ol aria-label="History" className="m-0 flex max-w-[860px] list-none flex-col p-0">
          {rows.map((row) => (
            <li
              key={row.commit}
              className="flex min-h-11 items-center gap-3 border-t border-line py-2 first:border-t-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("text-base text-pretty", row.undone && "text-fg-faint line-through")}>
                  {row.what}
                </span>
                <span className="text-xs text-fg-faint">
                  {row.who}, {row.when}
                  {row.reason ? `: ${row.reason}` : ""}
                </span>
              </div>
              {row.undone && <span className="text-xs text-fg-faint">Undone</span>}
              {row.canUndo && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Undo: ${row.what}`}
                  disabled={undo.isPending}
                  onClick={() =>
                    undo.mutate(row.commit, {
                      onError: (error) =>
                        toast("Could not undo", { detail: describeError(error), tone: "error" }),
                    })
                  }
                >
                  <Undo2 aria-hidden="true" />
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {more && (
        <div>
          <Button
            size="sm"
            disabled={history.isFetching}
            onClick={() => setLimit(Math.min(MOST, limit + PAGE))}
          >
            {history.isFetching ? "Loading" : "Show older changes"}
          </Button>
        </div>
      )}
    </DetailSection>
  );
}
