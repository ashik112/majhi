import type { RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { Check, PencilLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";

type Ask = Extract<RoomItem, { type: "ask" }>;
type Question = Ask["questions"][number];

/** How long a one-click answer waits before it is sent, so a slip can be undone. */
const UNDO_MS = 5000;

const RECOMMENDED = /^\s*\(?recommended\)?\s*[:-]?\s*|\s*\(recommended\)\s*$/i;

/** An option as shown: its label without a "Recommended:" prefix, and whether it was recommended. */
export function optionView(q: Question, option: Question["options"][number]) {
  const label = option.label.replace(RECOMMENDED, "").trim() || option.label;
  return { label, recommended: RECOMMENDED.test(option.label) || q.default === option.id };
}

const FIELD =
  "min-w-0 flex-1 rounded-md border border-line-control bg-field px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50";

/** A pending question card: stacked option rows, one click answers a single question. */
export function PendingAsk({ item }: { item: Ask }) {
  const toast = useToast();
  const single = item.questions.length === 1;
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = { ...(item.answers ?? {}) };
    if (!single)
      for (const q of item.questions) if (!(q.id in initial) && q.default) initial[q.id] = q.default;
    return initial;
  });
  /** Questions whose answer is typed text, not an option. */
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  /** A single question's option, waiting out the undo window. */
  const [sending, setSending] = useState<{ id: string; label: string }>();

  const send = useMutation<unknown, ApiRequestError, { answers: Record<string, string>; holdMs?: number }>({
    mutationFn: ({ answers: body, holdMs }) =>
      cmd("room.answerAsk", {
        task: item.task,
        item: item.id,
        answers: body,
        ...(holdMs === undefined ? {} : { holdMs }),
      }),
    onError: (error) => {
      setSending(undefined);
      toast("Could not answer", { detail: error.message, tone: "error" });
    },
  });

  // The server holds a single question's answer for its Undo time and sends it, also when this tab is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one send per pick; a rerender must not repeat it
  useEffect(() => {
    if (sending === undefined) return;
    const q = item.questions[0];
    if (q === undefined) return;
    send.mutate({ answers: { [q.id]: sending.id }, holdMs: UNDO_MS });
  }, [sending]);

  const undo = () => {
    setSending(undefined);
    void cmd("answers.cancelHeld", { key: `ask:${item.task}:${item.id}` });
  };

  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (sending !== undefined) status.current?.scrollIntoView({ block: "nearest" });
  }, [sending]);

  const busy = send.isPending || sending !== undefined;
  const answered = (q: Question) => (answers[q.id] ?? "").trim() !== "";
  const ready = item.questions.every(answered);
  const unanswered = item.questions.filter((q) => !answered(q)).length;

  const pick = (q: Question, option: Question["options"][number]) => {
    setTyping((t) => ({ ...t, [q.id]: false }));
    setAnswers((a) => ({ ...a, [q.id]: option.id }));
    if (single) setSending({ id: option.id, label: optionView(q, option).label });
  };
  const type = (q: Question, text: string) => setAnswers((a) => ({ ...a, [q.id]: text }));
  const openText = (q: Question) => {
    setTyping((t) => ({ ...t, [q.id]: true }));
    setAnswers((a) => {
      const { [q.id]: current, ...rest } = a;
      return q.options.some((o) => o.id === current) ? rest : a;
    });
  };

  return (
    <section aria-label="Question" className="flex w-full min-w-0 flex-col gap-3 py-2">
      {item.questions.map((q, n) => (
        <div key={q.id} className={cn("flex flex-col gap-2", n > 0 && "border-t border-line pt-3")}>
          <p className="flex items-start gap-2 text-base text-fg">
            <span className="mt-[7px] shrink-0">
              <Lamp state="needs" size={8} />
            </span>
            <span className="min-w-0 break-words">{q.question}</span>
          </p>
          <fieldset className="flex min-w-0 flex-col gap-1.5 pl-4" aria-label={q.question}>
            {q.options.map((option) => {
              const view = optionView(q, option);
              const on = !typing[q.id] && answers[q.id] === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={single ? undefined : on}
                  onClick={() => pick(q, option)}
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150 disabled:cursor-default",
                    on
                      ? "border-accent bg-selected text-fg"
                      : "border-line-control bg-raised text-fg hover:border-line-hover hover:bg-selected disabled:opacity-60",
                  )}
                >
                  <span className="min-w-0 flex-1 break-words">{view.label}</span>
                  {view.recommended && (
                    <span className="mt-px shrink-0 rounded-sm border border-accent-line bg-accent-wash px-1.5 text-xs leading-5 text-accent-text">
                      Recommended
                    </span>
                  )}
                  {on && !single && (
                    <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
                  )}
                </button>
              );
            })}
            {q.freeText && (q.options.length === 0 || typing[q.id]) ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  // biome-ignore lint/a11y/noAutofocus: the owner just asked to type an answer
                  autoFocus={q.options.length > 0}
                  aria-label="Your answer"
                  placeholder="Type your answer"
                  value={typing[q.id] || q.options.length === 0 ? (answers[q.id] ?? "") : ""}
                  disabled={busy}
                  onChange={(e) => type(q, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && single && answered(q) && !busy) send.mutate({ answers });
                  }}
                  className={FIELD}
                />
                {single && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !answered(q)}
                    onClick={() => send.mutate({ answers })}
                  >
                    {send.isPending ? "Sending..." : "Send"}
                  </Button>
                )}
              </div>
            ) : (
              q.freeText && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => openText(q)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-dashed border-line-control px-3 py-2 text-left text-sm text-fg-muted transition-colors duration-150 hover:border-line-hover hover:text-fg disabled:opacity-60"
                >
                  <PencilLine aria-hidden="true" className="size-3.5 shrink-0" />
                  Something else
                </button>
              )
            )}
          </fieldset>
        </div>
      ))}
      {single && sending !== undefined && (
        <p
          ref={status}
          className="sticky bottom-0 z-10 -mx-3 flex items-center gap-2 bg-glass-strong px-3 py-1.5 pl-7 text-sm text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {send.isPending ? "Sending" : "Sending in 5 seconds"}: {sending.label}
          </span>
          {!send.isPending && (
            <Button size="sm" variant="ghost" onClick={undo}>
              Undo
            </Button>
          )}
        </p>
      )}
      {!single && (
        // Sticks to the bottom of the dock, so Send stays in view however many options scroll past.
        <div className="sticky bottom-0 z-10 -mx-3 flex items-center gap-3 bg-glass-strong px-3 py-2 pl-7">
          <Button
            size="sm"
            variant="primary"
            disabled={send.isPending || !ready}
            onClick={() => send.mutate({ answers })}
          >
            {send.isPending ? "Sending..." : "Send"}
          </Button>
          {!ready && (
            <span className="min-w-0 truncate text-xs text-fg-muted">
              {unanswered === 1 ? "1 question left to answer" : `${unanswered} questions left to answer`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
