import { type Notice, PRIVATE } from "@majhi/shared";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrgBadge } from "@/components/ui/org-badge";
import { useHeldOption, useSendDecision } from "@/features/decisions/use-send-decision";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { badgeLetters } from "@/lib/format";
import { useOrgs } from "@/lib/studio-queries";
import { shortAgo } from "./model";

/** The workspace's tile; a row of no workspace (an update) gets majhi's own mark. */
function Tile({ org }: { org: string | undefined }) {
  const orgs = useOrgs().data;
  if (org === undefined) {
    return (
      <span
        aria-hidden="true"
        className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-raised text-fg-muted"
      >
        <Sparkles className="size-3" />
      </span>
    );
  }
  const found = orgs?.find((o) => o.id === org);
  return (
    <OrgBadge
      label={badgeLetters(found?.key ?? (org === PRIVATE ? "Private" : org))}
      color={found?.color}
      size="xs"
    />
  );
}

/** The decision's main answer, as the same button Needs you has: it answers once, for every place that shows it. */
function Answer({ notice }: { notice: Notice }) {
  const answer = notice.answer;
  const decisions = useDecisions().data?.decisions;
  const { send, busy } = useSendDecision();
  const held = useHeldOption(answer?.decision ?? "");
  const decision = decisions?.find((d) => d.id === answer?.decision);
  if (answer === undefined || decision === undefined) return null;
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-2">
      {answer.says !== undefined && (
        <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{answer.says}</span>
      )}
      <Button
        size="sm"
        variant="primary"
        disabled={busy || held !== undefined}
        className={cn("max-w-[60%] shrink-0 truncate", answer.says === undefined && "ml-auto")}
        onClick={() => send(decision, answer.option)}
      >
        {held === answer.option ? "Sending..." : answer.label}
      </Button>
    </div>
  );
}

/**
 * One row of the bell: an unread dot, the workspace, what happened in bold, the detail under it and the
 * age on the right. A row that waits for the owner carries its main answer as a button. A read row is
 * one quiet line. The row opens its home; the button answers.
 */
export function NoticeRow({
  notice,
  now,
  onOpen,
}: {
  notice: Notice;
  now: number;
  onOpen: (notice: Notice) => void;
}) {
  const quiet = notice.read && notice.answer === undefined;
  return (
    <div
      data-notice-row={notice.id}
      className="flex min-w-0 gap-2 border-b border-line px-3 py-2 last:border-b-0 hover:bg-raised/60"
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-[5px] size-1.5 shrink-0 rounded-full",
          notice.read ? "bg-transparent" : notice.needsYou ? "bg-lamp-needs" : "bg-accent",
        )}
      />
      <span className="mt-px">
        <Tile org={notice.org} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-notice=""
          onClick={() => onOpen(notice)}
          title={notice.detail === undefined ? notice.subject : `${notice.subject}: ${notice.detail}`}
          className="block w-full cursor-pointer rounded-sm p-0 text-left"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-base",
                notice.read ? "text-fg-muted" : "font-semibold text-fg",
              )}
            >
              {notice.subject}
              {quiet && notice.detail !== undefined && (
                <span className="font-normal text-fg-faint">: {notice.detail}</span>
              )}
            </span>
            <span className="tnum shrink-0 text-xs text-fg-faint">{shortAgo(notice.at, now)}</span>
          </span>
          {!quiet && notice.detail !== undefined && (
            <span className="mt-0.5 block truncate text-sm text-fg-muted">{notice.detail}</span>
          )}
        </button>
        <Answer notice={notice} />
      </div>
    </div>
  );
}
