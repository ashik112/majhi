import { DECISION_KIND_LABEL, type DecisionLink, type OwnerDecision, PRIVATE } from "@majhi/shared";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { useToast } from "@/components/ui/toast";
import { useAnswerDecision } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatAgo } from "@/lib/format";
import { useOrgs } from "@/lib/studio-queries";
import { useNow } from "@/lib/use-now";
import type { BannerAction } from "../shell/model";

/** Where "Open" goes, as the banner and the bell already navigate. */
function actionOf(link: DecisionLink): BannerAction {
  switch (link.kind) {
    case "task":
      return { kind: "task", id: link.id, ...(link.item === undefined ? {} : { item: link.item }) };
    case "chat":
      return { kind: "chat", id: link.id };
    case "captain":
      return { kind: "page", to: "/captain" };
    case "limits":
      return { kind: "page", to: "/limits" };
    case "account":
      return { kind: "page", to: "/accounts", search: { account: link.id } };
  }
}

function openLabel(link: DecisionLink): string {
  switch (link.kind) {
    case "task":
      return "Open task";
    case "chat":
      return "Open chat";
    case "captain":
      return "Open Captain";
    case "limits":
      return "Open Limits";
    case "account":
      return "Sign in";
  }
}

/** The workspace a decision belongs to: its org, Private for a task of none, nothing for an account or the day's budget. */
export function workspaceOf(decision: OwnerDecision): string | undefined {
  return decision.org ?? (decision.task === undefined ? undefined : PRIVATE);
}

/** The chip: the workspace's tile and name, the name cut short when it is long. */
export function WorkspaceChip({ id, className }: { id: string; className?: string }) {
  const org = useOrgs().data?.find((o) => o.id === id);
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${className ?? ""}`}>
      <OrgBadge label={badgeLetters(org?.key ?? id)} color={org?.color} size="xs" />
      <span className="min-w-0 truncate text-xs font-medium text-fg-soft">{org?.name ?? id}</span>
    </span>
  );
}

/** "Captain recommends Rebuild: keeps a backup branch" or "The agent suggests Rebuild". */
function Suggestion({ decision }: { decision: OwnerDecision }) {
  const suggestion = decision.suggestion;
  if (suggestion === undefined) return null;
  const label = decision.options.find((o) => o.id === suggestion.option)?.label ?? suggestion.option;
  const captain = suggestion.by === "captain";
  return (
    <p className="text-sm text-fg-muted text-pretty break-words">
      {captain ? "Captain recommends " : "The agent suggests "}
      <span className="font-semibold text-fg">{label}</span>
      {captain && suggestion.reason !== "" && <>: {suggestion.reason}</>}
    </p>
  );
}

/**
 * One decision: where it comes from, what it asks, what the captain thinks, and the answers as
 * buttons. Answering removes the row (the list refetches); an answer that fails says why and stays.
 * `compact` is the bell's popover: the title may take three lines.
 */
export function DecisionRow({
  decision,
  compact = false,
  showWorkspace = true,
  onOpen,
}: {
  decision: OwnerDecision;
  compact?: boolean;
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
  const titleSaysKind = decision.title
    .toLowerCase()
    .startsWith(DECISION_KIND_LABEL[decision.kind].toLowerCase());
  const send = (option: string) =>
    answer.mutate(
      { id: decision.id, option },
      { onError: (error) => toast("Could not answer it", { detail: describeError(error), tone: "error" }) },
    );
  const open = (
    <Button
      size="sm"
      variant={decision.options.length === 0 ? "primary" : "ghost"}
      data-notice=""
      className={decision.options.length === 0 ? undefined : "ml-auto px-2"}
      onClick={() => {
        onOpen?.();
        run(actionOf(decision.link));
      }}
    >
      {openLabel(decision.link)}
    </Button>
  );

  return (
    <div
      data-decision={decision.id}
      className="flex min-w-0 flex-col gap-1.5 border-b border-line px-3 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Lamp state={decision.kind === "paused" ? "paused" : "needs"} size={7} />
        {showWorkspace && workspace !== undefined && <WorkspaceChip id={workspace} className="max-w-[45%]" />}
        {decision.task !== undefined && (
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-fg-faint">
            {decision.chat !== true && (
              <span className="shrink-0 font-mono text-fg-muted">{decision.task}</span>
            )}
            {decision.taskTitle !== undefined && (
              <span className="min-w-0 truncate">{decision.taskTitle}</span>
            )}
          </span>
        )}
        {/* What kind it is, unless the title already says so. In the popover, only where nothing else says whose it is. */}
        {(compact ? workspace === undefined && decision.task === undefined : !titleSaysKind) && (
          <span
            className={`shrink-0 text-xs ${compact ? "font-medium text-fg-soft" : "ml-auto text-fg-faint"}`}
          >
            {DECISION_KIND_LABEL[decision.kind]}
          </span>
        )}
        <span className={`tnum shrink-0 text-xs text-fg-faint ${compact || titleSaysKind ? "ml-auto" : ""}`}>
          {formatAgo(decision.at, now)}
        </span>
      </div>
      <p className={`text-base text-fg break-words text-pretty ${compact ? "line-clamp-3" : ""}`}>
        {decision.title}
      </p>
      <Suggestion decision={decision} />
      <div className="flex min-w-0 flex-wrap items-center gap-2 pt-0.5">
        {decision.options.map((option) => (
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
        {open}
      </div>
    </div>
  );
}
