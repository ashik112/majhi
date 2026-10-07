import { DECISION_KIND_LABEL, type DecisionDetail, type OwnerDecision } from "@majhi/shared";
import { ArrowLeft, Check, TriangleAlert } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Lamp } from "@/components/ui/lamp";
import { Textarea } from "@/components/ui/select";
import { FailedStep, HandoffBlock } from "@/features/handoff/handoff-block";
import { Markdown } from "@/features/room/markdown";
import { cn } from "@/lib/cn";
import { formatAgo, MOD_KEY, plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { KindIcon, kindWord, WorkspaceName } from "./decision-bits";
import { openLabel, primaryOption, workspaceOf } from "./model";

/** A labelled block of the detail body, divided from the next by a hairline. */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-2 border-t border-line py-4 first:border-t-0"
    >
      <h3 className="text-sm font-medium text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

/** The agent's last message, about eight lines, with the rest behind "Show all". */
function Handback({ detail }: { detail: NonNullable<DecisionDetail["handback"]> }) {
  const [all, setAll] = useState(false);
  const [tall, setTall] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever the text changes
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setTall(el.scrollHeight > el.clientHeight + 4);
  }, [detail.text, all]);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div
        ref={box}
        className={cn("min-w-0 max-w-full overflow-hidden text-fg-soft", !all && "max-h-[10.5rem]")}
        style={!all && tall ? { maskImage: "linear-gradient(to bottom, black 70%, transparent)" } : undefined}
      >
        <Markdown text={detail.text} />
      </div>
      {(tall || all) && (
        <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

function Changes({
  diff,
  repos,
  checks,
}: {
  diff: NonNullable<DecisionDetail["diff"]>;
  repos: DecisionDetail["repos"];
  checks: string | undefined;
}) {
  if (diff.error !== undefined) {
    return <p className="text-sm text-red text-pretty">The change could not be read: {diff.error}</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="tnum flex flex-wrap items-baseline gap-x-3 text-base text-fg">
        <span>{plural(diff.files, "file")}</span>
        <span className="font-mono text-green">+{diff.additions}</span>
        <span className="font-mono text-red">-{diff.deletions}</span>
      </p>
      {diff.top.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {diff.top.map((f) => (
            <li key={f.path} className="flex min-w-0 items-baseline gap-3 py-0.5 font-mono text-xs">
              <span className="min-w-0 flex-1 truncate text-fg-soft" title={f.path}>
                {f.path}
              </span>
              <span className="tnum shrink-0 text-green">+{f.additions}</span>
              <span className="tnum shrink-0 text-red">-{f.deletions}</span>
            </li>
          ))}
          {diff.files > diff.top.length && (
            <li className="py-0.5 text-xs text-fg-faint">and {diff.files - diff.top.length} more</li>
          )}
        </ul>
      )}
      {diff.uncommitted && (
        <p className="flex items-center gap-1.5 text-sm text-caution">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          Some changes are not committed yet, so they would not be merged.
        </p>
      )}
      {checks !== undefined && (
        <p className="flex items-start gap-1.5 text-sm text-fg-soft text-pretty">
          <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-lamp-done" />
          Checked: {checks}.
        </p>
      )}
      {repos !== undefined && repos.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm text-fg-muted">
          {repos.map((r) => (
            <li key={r.project} className="min-w-0 break-words">
              <span className="font-mono text-xs">{r.project}</span> merges{" "}
              <span className="font-mono text-xs">{r.branch}</span> into{" "}
              <span className="font-mono text-xs">{r.into}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The selected decision in full: what it is, what the captain thinks, what changed and what the agent
 * said, so it can be decided here. The actions are pinned under the body; a reply box opens over them.
 */
export function DecisionDetailPane({
  decision,
  detail,
  detailError,
  now,
  busy,
  working,
  replyOpen,
  replyText,
  onReplyText,
  onReplyOpen,
  onAnswer,
  onOpen,
  onBack,
}: {
  decision: OwnerDecision;
  detail: DecisionDetail | undefined;
  detailError: string | undefined;
  now: number;
  busy: boolean;
  /** The option being sent right now. */
  working: string | undefined;
  replyOpen: boolean;
  replyText: string;
  onReplyText: (text: string) => void;
  onReplyOpen: (open: boolean) => void;
  onAnswer: (option: string, text?: string) => void;
  onOpen: () => void;
  /** Set below 1000px: the pane is the page and this goes back to the queue. */
  onBack: (() => void) | undefined;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const workspace = workspaceOf(decision);
  const textOption = decision.options.find((o) => o.text === true);
  const blocked = detail?.blocked ?? {};
  const main = primaryOption(decision, blocked);
  const suggestion = decision.suggestion;
  const suggestedLabel =
    decision.options.find((o) => o.id === suggestion?.option)?.label ?? suggestion?.option;
  const hand = detail?.handback;

  useLayoutEffect(() => {
    if (replyOpen) field.current?.focus();
  }, [replyOpen]);

  const blockedNow = decision.options.filter((o) => blocked[o.id] !== undefined);
  const noButtons = decision.options.length === 0;

  return (
    <section
      aria-label="Decision"
      className={cn("flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS)}
    >
      <div className="shrink-0 border-b border-line px-5 py-3.5">
        {onBack !== undefined && (
          <Button size="sm" variant="ghost" className="-ml-2.5 mb-1" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            All decisions
          </Button>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          <span className="flex items-center gap-1.5">
            <Lamp state={decision.kind === "paused" ? "paused" : "needs"} size={7} />
            {decision.kind === "paused" ? "Paused" : "Needs you"}
          </span>
          <span className="flex items-center gap-1.5">
            <KindIcon kind={decision.kind} />
            {kindWord(decision)}
          </span>
          {workspace !== undefined && <WorkspaceName id={workspace} className="max-w-[60%]" />}
          <span className="tnum font-mono text-fg-faint">{formatAgo(decision.at, now)}</span>
          {decision.task !== undefined && decision.chat !== true && (
            <span className="font-mono text-fg-faint" title="Task id">
              {decision.task}
            </span>
          )}
        </div>
        <h2 className="mt-1.5 text-lg font-semibold text-fg text-balance break-words">
          {decision.taskTitle ?? DECISION_KIND_LABEL[decision.kind]}
        </h2>
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-4 scroll-fade">
        <p className="m-0 text-md text-fg text-pretty break-words">{decision.sentence ?? decision.title}</p>

        {decision.blocked !== undefined && (
          <p className="mt-2 mb-0 flex items-start gap-1.5 text-sm text-caution text-pretty break-words">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {decision.blocked}
          </p>
        )}

        {detail?.changes !== undefined && (
          <Block title="Changes">
            <pre className="m-0 max-h-72 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-fg-soft">
              {detail.changes.join("\n")}
            </pre>
          </Block>
        )}

        {detail?.command !== undefined && (
          <Block title={decision.kind === "approval" ? "What it asks" : "Command"}>
            <p className="m-0 text-sm text-fg-muted">
              {detail.agent === undefined ? "Asked" : `@${detail.agent} asks`} to run this
              {decision.task !== undefined && decision.chat !== true ? ` in ${decision.task}` : ""}:
            </p>
            <pre className="m-0 max-h-72 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-fg-soft">
              {detail.command}
            </pre>
          </Block>
        )}

        {suggestion !== undefined && (
          <div className="mt-4 flex flex-col gap-1 rounded-xl border border-accent-line bg-accent-wash px-3 py-2.5">
            <p className="m-0 flex items-center gap-1.5 text-sm text-fg-muted">
              <Check aria-hidden="true" className="size-3.5 text-accent-text" />
              {suggestion.by === "captain" ? "Captain recommends" : "The agent suggests"}{" "}
              <span className="font-semibold text-fg">{suggestedLabel}</span>
            </p>
            {suggestion.by === "captain" && suggestion.reason !== "" && (
              <p className="m-0 text-base text-fg-soft text-pretty break-words">{suggestion.reason}</p>
            )}
          </div>
        )}

        {hand !== undefined && (
          <Block
            title={
              decision.kind === "ship" ? `What @${hand.agent} said last` : `Last message from @${hand.agent}`
            }
          >
            <Handback detail={hand} />
          </Block>
        )}
        {detail?.draft !== undefined && (
          <Block title={`To ${detail.draft.target}`}>
            <div className="flex flex-col gap-2 text-base text-fg-soft">
              {detail.draft.subject !== undefined && (
                <p className="m-0 font-medium text-fg">{detail.draft.subject}</p>
              )}
              <p className="m-0 whitespace-pre-wrap text-pretty break-words">{detail.draft.body}</p>
              <p className="m-0 text-xs text-fg-faint">Nothing is sent until you approve it.</p>
            </div>
          </Block>
        )}
        {decision.kind === "ship" && decision.task !== undefined && detail?.diff !== undefined && (
          <Block title="Checks">
            <FailedStep task={decision.task} className="pl-0" />
            <HandoffBlock task={decision.task} />
          </Block>
        )}
        {detail?.diff !== undefined && (
          <Block title="What changed">
            <Changes diff={detail.diff} repos={detail.repos} checks={detail.checks} />
          </Block>
        )}
        {detail?.questions !== undefined && detail.questions.length > 1 && (
          <Block title="Questions">
            <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-base text-fg-soft">
              {detail.questions.map((q) => (
                <li key={q.question} className="text-pretty">
                  {q.question}
                  {q.options.length > 0 && <span className="text-fg-faint"> ({q.options.join(", ")})</span>}
                </li>
              ))}
            </ol>
            <p className="m-0 text-sm text-fg-faint">Several questions are answered in the task.</p>
          </Block>
        )}
        {detailError !== undefined && (
          <p className="mt-3 text-sm text-fg-faint">Details are not available: {detailError}</p>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-5 py-3">
        {replyOpen && textOption !== undefined && (
          <form
            className="mb-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (replyText.trim() !== "" && !busy) onAnswer(textOption.id, replyText.trim());
            }}
          >
            <Textarea
              ref={field}
              aria-label={textOption.label}
              rows={3}
              value={replyText}
              placeholder={
                textOption.id === "changes"
                  ? "What should change? This goes to the lead and the task goes back to running."
                  : "Your answer"
              }
              onChange={(e) => onReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (replyText.trim() !== "" && !busy) onAnswer(textOption.id, replyText.trim());
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onReplyOpen(false);
                }
              }}
              className="max-h-40 min-h-[72px] resize-y font-sans"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant="primary" disabled={busy || replyText.trim() === ""}>
                {working === textOption.id
                  ? "Sending..."
                  : textOption.id === "changes"
                    ? "Send changes"
                    : "Send"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onReplyOpen(false)}>
                Cancel
              </Button>
              <span className="ml-auto flex items-center gap-1 text-xs text-fg-faint">
                <Kbd>{MOD_KEY}</Kbd>
                <Kbd>Enter</Kbd> sends
              </span>
            </div>
          </form>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {decision.options.map((option, i) => {
            const why = blocked[option.id];
            const typed = option.text === true;
            return (
              <Button
                key={option.id}
                variant={option.id === main?.id && !typed ? "primary" : "secondary"}
                aria-pressed={typed ? replyOpen : undefined}
                disabled={busy || why !== undefined}
                title={why}
                data-option={option.id}
                className="h-auto min-h-[34px] max-w-full py-1.5 whitespace-normal"
                onClick={() => (typed ? onReplyOpen(!replyOpen) : onAnswer(option.id))}
              >
                {working === option.id ? "Working..." : option.label}
                {i < 9 && (
                  <Kbd aria-hidden="true" className="hidden min-[1280px]:inline-flex">
                    {i + 1}
                  </Kbd>
                )}
              </Button>
            );
          })}
          <Button
            variant={noButtons ? "primary" : "ghost"}
            className={noButtons ? undefined : "ml-auto"}
            onClick={onOpen}
          >
            {openLabel(decision.link)}
            <Kbd aria-hidden="true" className="hidden min-[1280px]:inline-flex">
              o
            </Kbd>
          </Button>
        </div>
        {blockedNow.map((o) => (
          <p key={o.id} className="mt-2 mb-0 text-sm text-fg-faint text-pretty">
            {o.label} is not possible now. {blocked[o.id]}
          </p>
        ))}
      </div>
    </section>
  );
}
