import { DECISION_KIND_LABEL, type OwnerDecision } from "@majhi/shared";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { useAnswerDecision } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { WorkspaceName } from "./decision-list";
import { actionOf, openLabel, workspaceOf } from "./model";

export { workspaceOf };

/** "Captain recommends Rebuild: keeps a backup branch" or "The agent suggests Rebuild". */
function Suggestion({ decision, dense }: { decision: OwnerDecision; dense: boolean }) {
  const suggestion = decision.suggestion;
  if (suggestion === undefined) return null;
  const label = decision.options.find((o) => o.id === suggestion.option)?.label ?? suggestion.option;
  const captain = suggestion.by === "captain";
  return (
    <p className={`text-sm text-fg-muted text-pretty break-words ${dense ? "line-clamp-2" : "line-clamp-3"}`}>
      {captain ? "Captain recommends " : "The agent suggests "}
      <span className="font-semibold text-fg">{label}</span>
      {captain && suggestion.reason !== "" && <>: {suggestion.reason}</>}
    </p>
  );
}

/**
 * A compact decision, for the bell and the Captain page: where it comes from, what it asks, what the
 * captain thinks and the answers as buttons. The line opens the decision on the Decisions page. A
 * decision that needs typed words (Ask for changes) is answered there, not here.
 */
export function DecisionRow({
  decision,
  dense = false,
  onOpen,
}: {
  decision: OwnerDecision;
  /** Tighter rows for a column that shares its height. */
  compact?: boolean;
  dense?: boolean;
  showWorkspace?: boolean;
  /** Runs before navigating, to close the popover. */
  onOpen?: () => void;
}) {
  const run = useRunAttention();
  const toast = useToast();
  const answer = useAnswerDecision();
  const now = useNow(60_000);
  const workspace = workspaceOf(decision);
  const busy = answer.isPending;
  // Work to ship has several answers on its page; here the main one is enough.
  const options = decision.options.filter(
    (o) => o.text !== true && (decision.kind !== "ship" || o.primary === true),
  );
  const send = (option: string) =>
    answer.mutate(
      { id: decision.id, option },
      { onError: (error) => toast("Could not answer it", { detail: describeError(error), tone: "error" }) },
    );
  const decide = () => {
    onOpen?.();
    run({ kind: "page", to: "/decisions", search: { id: decision.id } });
  };

  return (
    <div
      data-decision={decision.id}
      className={`flex min-w-0 flex-col border-b border-line px-3 last:border-b-0 ${dense ? "gap-1 py-2" : "gap-1.5 py-3"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Lamp state={decision.kind === "paused" ? "paused" : "needs"} size={7} />
        {workspace !== undefined && (
          <WorkspaceName id={workspace} className="max-w-[45%] shrink-0 text-xs font-medium text-fg-soft" />
        )}
        <span className="shrink-0 text-xs text-fg-faint">{DECISION_KIND_LABEL[decision.kind]}</span>
        <span className="tnum ml-auto shrink-0 text-xs text-fg-faint">{formatAgo(decision.at, now)}</span>
      </div>
      <button
        type="button"
        onClick={decide}
        title="Open this decision"
        className="m-0 w-full cursor-pointer rounded-sm p-0 text-left text-base text-fg break-words text-pretty line-clamp-3 hover:underline"
      >
        {decision.kind === "ship" && decision.taskTitle !== undefined ? decision.taskTitle : decision.title}
      </button>
      <Suggestion decision={decision} dense={dense} />
      <div className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5">
        {options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.primary === true ? "primary" : "secondary"}
            disabled={busy}
            className="h-auto min-h-7 max-w-full py-1 text-left whitespace-normal"
            onClick={() => send(option.id)}
          >
            {option.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={options.length === 0 ? "primary" : "ghost"}
          data-notice=""
          className={options.length === 0 ? undefined : "ml-auto px-2"}
          onClick={() => {
            onOpen?.();
            run(actionOf(decision.link));
          }}
        >
          {openLabel(decision.link)}
        </Button>
      </div>
    </div>
  );
}
