import { PAGE_PATH, type WatchPlan } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiRequestError } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { usePlanWatch, useSaveWatch } from "@/lib/watch-queries";

/** `**bold**` in a plan line becomes bold text. Nothing else in it is markup. */
function Line({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <p className="m-0 text-base text-fg-soft text-pretty">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of one string
          <b key={i} className="font-medium text-fg">
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/**
 * "Tell me when ...": one sentence into a watch. The plan shows what majhi understood in one line, with
 * the value it read just now, and starts only when the owner says so.
 */
export function SentenceBox({
  org,
  onManual,
  onEdit,
}: {
  /** The workspace in the filter. Absent: majhi picks the one whose connection the sentence names. */
  org: string | undefined;
  onManual: () => void;
  onEdit: (plan: WatchPlan) => void;
}) {
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<WatchPlan | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [needsConnection, setNeedsConnection] = useState(false);
  const planner = usePlanWatch();
  const save = useSaveWatch();
  const toast = useToast();

  const ask = () => {
    const sentence = text.trim();
    if (sentence.length < 3 || planner.isPending) return;
    setProblem(undefined);
    setNeedsConnection(false);
    planner.mutate(
      { text: sentence, ...(org === undefined ? {} : { org }) },
      {
        onSuccess: setPlan,
        onError: (e) => {
          setPlan(undefined);
          setProblem(describeError(e));
          setNeedsConnection(e instanceof ApiRequestError && e.status === 409);
        },
      },
    );
  };
  const start = () => {
    if (plan === undefined) return;
    save.mutate(
      { org: plan.org, def: plan.def },
      {
        onSuccess: () => {
          toast("Watching it now", { detail: plan.def.name });
          setPlan(undefined);
          setText("");
        },
        onError: (e) => setProblem(describeError(e)),
      },
    );
  };

  return (
    <div className="flex shrink-0 flex-col border-b border-line">
      <form
        className="flex items-center gap-2 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          aria-label="Describe what to watch"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tell me when Redis on my cache goes over 80% memory"
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-accent/40 bg-raised px-3 text-base text-fg placeholder:text-fg-faint"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={planner.isPending || text.trim().length < 3}
        >
          {planner.isPending ? "Thinking" : "Watch"}
        </Button>
        <button
          type="button"
          onClick={onManual}
          className="shrink-0 cursor-pointer text-sm whitespace-nowrap text-accent-text underline-offset-2 hover:underline"
        >
          Set up manually
        </button>
      </form>
      {problem !== undefined && (
        <p className="m-0 px-3 pb-2.5 text-sm text-red text-pretty">
          {problem}
          {needsConnection && (
            <>
              {" "}
              <Link
                to={PAGE_PATH.connections}
                search={{}}
                className="text-accent-text underline-offset-2 hover:underline"
              >
                Open Connections
              </Link>
            </>
          )}
        </p>
      )}
      {plan !== undefined && (
        <div className="mx-3 mb-2.5 flex flex-col gap-2 rounded-[10px] border border-line bg-raised px-3 py-2.5">
          <Line text={plan.line} />
          {!plan.test.ok && (
            <p className="m-0 text-sm text-fg-faint">
              You can still start it: it shows as unknown until it can read the value.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={start}>
              Start watching
            </Button>
            <Button size="sm" onClick={() => onEdit(plan)}>
              Edit details
            </Button>
            <Button size="sm" onClick={() => setPlan(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
