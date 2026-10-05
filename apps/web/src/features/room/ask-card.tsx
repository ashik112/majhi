import type { RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { Check, PencilLine, ShieldQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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

  const send = useMutation<unknown, ApiRequestError, Record<string, string>>({
    mutationFn: (body) => cmd("room.answerAsk", { task: item.task, item: item.id, answers: body }),
    onError: (error) => {
      setSending(undefined);
      toast("Could not answer", { detail: error.message, tone: "error" });
    },
  });

  // The timer belongs to one pick; a rerender must not restart it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (sending === undefined) return;
    const q = item.questions[0];
    if (q === undefined) return;
    const timer = setTimeout(() => send.mutate({ [q.id]: sending.id }), UNDO_MS);
    return () => clearTimeout(timer);
  }, [sending]);

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
    <section
      aria-label="Question"
      className="flex w-full max-w-[700px] flex-col gap-3 rounded-lg border border-blue-line bg-blue-wash px-3.5 py-3"
    >
      {item.questions.map((q, n) => (
        <div key={q.id} className={cn("flex flex-col gap-2", n > 0 && "border-t border-line pt-3")}>
          <p className="sticky top-0 z-10 -mx-3.5 -mt-1 flex items-start gap-2 px-3.5 pt-1 pb-1 text-base text-fg [background:linear-gradient(var(--c-blue-wash),var(--c-blue-wash)),var(--c-glass-strong)]">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-blue" />
            <span className="min-w-0 break-words">{q.question}</span>
          </p>
          <fieldset className="flex min-w-0 flex-col gap-1.5 pl-6" aria-label={q.question}>
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
                    if (e.key === "Enter" && single && answered(q) && !busy) send.mutate(answers);
                  }}
                  className={FIELD}
                />
                {single && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !answered(q)}
                    onClick={() => send.mutate(answers)}
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
          className="sticky bottom-0 z-10 -mx-3.5 -mb-3 flex items-center gap-2 rounded-b-lg px-3.5 pt-1.5 pb-3 pl-[34px] text-sm text-fg-muted [background:linear-gradient(var(--c-blue-wash),var(--c-blue-wash)),var(--c-glass-strong)]"
        >
          <span className="min-w-0 flex-1 truncate">
            {send.isPending ? "Sending" : "Sending in 5 seconds"}: {sending.label}
          </span>
          {!send.isPending && (
            <Button size="sm" variant="ghost" onClick={() => setSending(undefined)}>
              Undo
            </Button>
          )}
        </p>
      )}
      {!single && (
        // Sticks to the bottom of the dock, so Send stays in view however many options scroll past.
        <div className="sticky bottom-0 z-10 -mx-3.5 -mb-3 flex items-center gap-3 rounded-b-lg px-3.5 pt-2 pb-3 pl-[34px] [background:linear-gradient(var(--c-blue-wash),var(--c-blue-wash)),var(--c-glass-strong)]">
          <Button
            size="sm"
            variant="primary"
            disabled={send.isPending || !ready}
            onClick={() => send.mutate(answers)}
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
