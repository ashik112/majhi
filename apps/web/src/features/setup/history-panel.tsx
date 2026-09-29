import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { historyRow } from "@/features/boss/model";
import { useHistory, useUndo } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useNow } from "@/lib/use-now";

/** The last config changes, by the owner, the boss or a hand edit, each with Undo. */
export function HistoryPanel() {
  const history = useHistory(8);
  const undo = useUndo();
  const toast = useToast();
  const now = useNow(60_000);
  const rows = (history.data ?? []).map((entry) => historyRow(entry, now));

  return (
    <section aria-label="History" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-md font-semibold">History</h2>
        <span className="text-sm text-fg-faint">Every change is a commit you can undo</span>
      </div>
      {history.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {history.isError && <p className="text-sm text-red">{describeError(history.error)}</p>}
      {history.data && rows.length === 0 && <p className="text-sm text-fg-faint">No changes yet.</p>}
      {rows.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((row) => (
            <li
              key={row.commit}
              className="flex items-start gap-2 rounded-[10px] border border-line-strong bg-raised px-3 py-2"
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
              {row.undone && <span className="pt-0.5 text-xs text-fg-faint">Undone</span>}
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
    </section>
  );
}
