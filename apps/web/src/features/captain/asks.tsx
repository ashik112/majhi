import { type CaptainCapAsk, CHORE_LABEL } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { useAnswerCap } from "@/lib/captain-queries";
import { describeError } from "@/lib/errors";

/** A chore that reached its daily cap in a workspace, and the captain's question: raise it for today, or leave it. */
export function CapAskRow({ ask, name }: { ask: CaptainCapAsk; name: string }) {
  const toast = useToast();
  const answer = useAnswerCap();
  const line = ask.text;
  const send = (choice: "raise" | "leave") =>
    answer.mutate(
      { org: ask.org, chore: ask.chore, answer: choice },
      {
        onSuccess: () =>
          toast(
            choice === "raise"
              ? `${CHORE_LABEL[ask.chore]}: up to ${ask.raiseTo} today in ${name}`
              : `${CHORE_LABEL[ask.chore]} stays at ${ask.cap} today in ${name}`,
          ),
        onError: (error) => toast("Could not answer it", { detail: describeError(error), tone: "error" }),
      },
    );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-line bg-amber-wash px-3 py-2">
      <span className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-sm text-fg-soft">
        <Lamp state="needs" size={7} />
        <span className="min-w-0 text-pretty">{upperFirst(line)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="primary" disabled={answer.isPending} onClick={() => send("raise")}>
          Raise to {ask.raiseTo} for today
        </Button>
        <Button size="sm" variant="secondary" disabled={answer.isPending} onClick={() => send("leave")}>
          Leave it
        </Button>
      </span>
    </div>
  );
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
