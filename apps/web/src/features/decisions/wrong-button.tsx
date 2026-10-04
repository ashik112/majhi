import { answerChoices } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useDecisionRecord, useLabelDecision } from "@/lib/decisions-queries";
import { describeError } from "@/lib/errors";

/**
 * "Wrong?" on a line that reports a decision from the decision provider (Laya's rating of a task, a
 * wake, a fact). The owner picks the right answer; it is kept as a label for the evals and calibration
 * and changes nothing else.
 */
export function WrongButton({ decision }: { decision: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="cursor-pointer rounded-xs text-xs text-fg-faint hover:text-fg"
      >
        Wrong?
      </button>
      {open && <WrongForm decision={decision} done={() => setOpen(false)} />}
    </span>
  );
}

function WrongForm({ decision, done }: { decision: string; done: () => void }) {
  const toast = useToast();
  const record = useDecisionRecord(decision, true);
  const label = useLabelDecision();
  const answers = Object.entries(record.data?.answers ?? {});
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const question = picked ?? answers[0]?.[0];
  const asked = question === undefined ? undefined : record.data?.request?.questions[question];
  const choices = asked === undefined ? [] : answerChoices(asked);
  const given = question === undefined ? undefined : String(record.data?.answers[question]?.value);
  const [right, setRight] = useState<string | undefined>(undefined);
  const value = right ?? choices.find((c) => c !== given) ?? choices[0] ?? "";
  if (record.isPending) return <span className="text-xs text-fg-faint">Loading</span>;
  if (record.isError || question === undefined || choices.length === 0)
    return (
      <span className="text-xs text-fg-faint">
        This decision has no stored question to correct. Use Recent decisions in Hub setup.
      </span>
    );
  return (
    <form
      aria-label="Wrong?"
      className="flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        label.mutate(
          { id: decision, question, right: value },
          {
            onSuccess: () => {
              toast("Saved. It trains the decision and changes nothing now.");
              done();
            },
            onError: (e) => toast("Could not save", { detail: describeError(e), tone: "error" }),
          },
        );
      }}
    >
      {answers.length > 1 && (
        <Select
          aria-label="Question"
          value={question}
          onChange={(e) => {
            setPicked(e.target.value);
            setRight(undefined);
          }}
        >
          {answers.map(([k]) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
      )}
      <span className="text-fg-muted">It should have been</span>
      <Select aria-label="Right answer" value={value} onChange={(e) => setRight(e.target.value)}>
        {choices.map((c) => (
          <option key={c} value={c}>
            {c === given ? `${c} (what it said)` : c}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" variant="primary" disabled={label.isPending}>
        Save
      </Button>
    </form>
  );
}
