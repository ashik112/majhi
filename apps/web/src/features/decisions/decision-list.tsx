import { DECISION_KIND_LABEL, type OwnerDecision, type OwnerDecisionKind } from "@majhi/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BellRing,
  CircleDollarSign,
  CirclePause,
  GitMerge,
  KeyRound,
  LogIn,
  Mail,
  Mails,
  MessageCircleQuestion,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { OrgBadge } from "@/components/ui/org-badge";
import { Textarea } from "@/components/ui/select";
import { SecretAnswer } from "@/features/room/secret-answer";
import { cn } from "@/lib/cn";
import { badgeLetters, formatAgo } from "@/lib/format";
import { useOrgs } from "@/lib/studio-queries";
import { actionOf, openLabel, primaryOption, rowTitle, secretCardOf, workspaceOf } from "./model";

const ICON: Record<OwnerDecisionKind, ReactNode> = {
  ship: <GitMerge aria-hidden="true" />,
  question: <MessageCircleQuestion aria-hidden="true" />,
  approval: <ShieldCheck aria-hidden="true" />,
  secret: <KeyRound aria-hidden="true" />,
  budget: <CircleDollarSign aria-hidden="true" />,
  paused: <CirclePause aria-hidden="true" />,
  "sign-in": <LogIn aria-hidden="true" />,
  draft: <Mail aria-hidden="true" />,
  batch: <Mails aria-hidden="true" />,
  incident: <BellRing aria-hidden="true" />,
  trust: <Scale aria-hidden="true" />,
};

export function KindIcon({ kind, className }: { kind: OwnerDecisionKind; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center text-fg-muted [&_svg]:size-4",
        className,
      )}
    >
      {ICON[kind]}
    </span>
  );
}

/** What a decision is, in the queue: the shared word for its kind. */
export function kindWord(decision: OwnerDecision): string {
  return DECISION_KIND_LABEL[decision.kind];
}

/** The workspace's tile and name. The name is cut when the line is short. */
export function WorkspaceName({ id, className }: { id: string; className?: string }) {
  const org = useOrgs().data?.find((o) => o.id === id);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <OrgBadge label={badgeLetters(org?.key ?? id)} color={org?.color} size="xs" />
      <span className="min-w-0 truncate">{org?.name ?? id}</span>
    </span>
  );
}

const ROW_ESTIMATE = 150;

/** One decision as a card: what it is, the captain's reason and every answer as a button. */
function DecisionCard({
  d,
  on,
  checked,
  isHeld,
  now,
  busy,
  working,
  onSelect,
  onPick,
  onAnswer,
}: {
  d: OwnerDecision;
  on: boolean;
  checked: boolean;
  isHeld: boolean;
  now: number;
  busy: boolean;
  working: string | undefined;
  onSelect: (id: string) => void;
  onPick: (id: string, range: boolean) => void;
  onAnswer: (d: OwnerDecision, option: string, text?: string) => void;
}) {
  const run = useRunAttention();
  const workspace = workspaceOf(d);
  const suggestion = d.suggestion;
  const main = primaryOption(d, undefined);
  const textOption = d.options.find((o) => o.text === true);
  const secret = secretCardOf(d);
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState("");
  const submit = () => {
    if (textOption !== undefined && reply.trim() !== "" && !busy) onAnswer(d, textOption.id, reply.trim());
  };
  return (
    <div
      data-decision={d.id}
      aria-current={on ? "true" : undefined}
      className={cn(
        "flex gap-2 rounded-xl border bg-glass p-3",
        on ? "border-accent-line" : "border-line",
        isHeld && "opacity-55",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={isHeld}
        aria-label={`Select ${rowTitle(d)}`}
        onClick={(e) => onPick(d.id, e.shiftKey)}
        onChange={() => undefined}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--c-accent)]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <button
          type="button"
          onClick={() => onSelect(d.id)}
          className="m-0 flex min-w-0 cursor-pointer flex-col items-stretch gap-1.5 rounded-sm bg-transparent p-0 text-left"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            <Lamp state={d.kind === "paused" ? "paused" : "needs"} size={7} />
            <span className="shrink-0">{kindWord(d)}</span>
            {workspace !== undefined && <WorkspaceName id={workspace} className="max-w-[40%] text-fg-soft" />}
            {d.task !== undefined && d.chat !== true && (
              <span className="shrink-0 font-mono text-fg-faint">{d.task}</span>
            )}
            <span className="tnum ml-auto shrink-0 font-mono text-fg-faint">{formatAgo(d.at, now)}</span>
          </span>
          <span className={cn("text-base text-fg text-pretty break-words", on && "font-medium")}>
            {rowTitle(d)}
          </span>
          {suggestion !== undefined && suggestion.by === "captain" && suggestion.reason !== "" && (
            <span className="line-clamp-1 font-mono text-xs text-green">{suggestion.reason}</span>
          )}
        </button>
        {isHeld ? (
          <span className="text-xs text-fg-muted">Waiting to be sent</span>
        ) : secret !== undefined ? (
          <SecretAnswer task={secret.task} item={secret.item} label={d.title} compact />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {d.options.map((o) => {
              const typed = o.text === true;
              return (
                <Button
                  key={o.id}
                  size="sm"
                  variant={o.id === main?.id && !typed ? "primary" : "secondary"}
                  disabled={busy}
                  aria-pressed={typed ? replyOpen : undefined}
                  className="h-auto min-h-7 max-w-full py-1 whitespace-normal"
                  onClick={() => (typed ? setReplyOpen(!replyOpen) : onAnswer(d, o.id))}
                >
                  {working === o.id ? "Working..." : o.label}
                </Button>
              );
            })}
            {d.options.length === 0 && (
              <Button size="sm" variant="primary" onClick={() => run(actionOf(d.link))}>
                {openLabel(d.link)}
              </Button>
            )}
          </div>
        )}
        {replyOpen && textOption !== undefined && (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Textarea
              aria-label={textOption.label}
              rows={2}
              autoFocus
              value={reply}
              placeholder={textOption.id === "changes" ? "What should change?" : "Your answer"}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setReplyOpen(false);
                }
              }}
              className="max-h-32 min-h-[56px] resize-y font-sans"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant="primary" disabled={busy || reply.trim() === ""}>
                Send
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setReplyOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * The queue: one card per decision, answerable in place, with a checkbox for batches. Only the cards
 * on screen are drawn, so 500 decisions stay fast.
 */
export function DecisionList({
  decisions,
  selected,
  now,
  scroller,
  picked,
  held,
  busy,
  working,
  onSelect,
  onPick,
  onAnswer,
}: {
  decisions: readonly OwnerDecision[];
  selected: string | undefined;
  now: number;
  /** The element the queue scrolls in. */
  scroller: HTMLElement | null;
  picked: ReadonlySet<string>;
  /** Decisions in a batch that waits out its undo time. */
  held: ReadonlySet<string>;
  busy: boolean;
  /** The option being sent right now. */
  working: string | undefined;
  onSelect: (id: string) => void;
  /** The checkbox: `range` when shift was held. */
  onPick: (id: string, range: boolean) => void;
  onAnswer: (d: OwnerDecision, option: string, text?: string) => void;
}) {
  const virtual = useVirtualizer({
    count: decisions.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
    getItemKey: (i) => decisions[i]?.id ?? i,
  });
  const at = decisions.findIndex((d) => d.id === selected);
  // The keys move the selection: keep it in view.
  useEffect(() => {
    if (at >= 0) virtual.scrollToIndex(at, { align: "auto" });
  }, [at, virtual]);

  return (
    <ul
      className="relative m-0 list-none p-0"
      style={{ height: virtual.getTotalSize() }}
      aria-label={`${decisions.length} decisions`}
    >
      {virtual.getVirtualItems().map((row) => {
        const d = decisions[row.index];
        if (d === undefined) return null;
        const isHeld = held.has(d.id);
        return (
          <li
            key={d.id}
            ref={virtual.measureElement}
            data-index={row.index}
            className="absolute inset-x-0 top-0 pb-2"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <DecisionCard
              d={d}
              on={d.id === selected}
              checked={picked.has(d.id) || isHeld}
              isHeld={isHeld}
              now={now}
              busy={busy}
              working={working}
              onSelect={onSelect}
              onPick={onPick}
              onAnswer={onAnswer}
            />
          </li>
        );
      })}
    </ul>
  );
}
