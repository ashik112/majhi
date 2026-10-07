import type { DeployAsk } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useDeploy, useHoldDeploy } from "@/lib/deploy-queries";
import { describeError } from "@/lib/errors";
import { useTaskDetail } from "@/lib/task-queries";
import { DockBar } from "./dock-bar";

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The deploy that waits for the owner on this task, when one does. */
export function useDeployAsk(task: string, enabled: boolean): DeployAsk | undefined {
  return useTaskDetail(task, enabled).data?.deployAsk;
}

/** "Deploy to production? Staging is healthy at a1b2c3d. The fix is 38 lines." with Deploy and Hold. */
export function DeployAskBar({ task, ask, change }: { task: string; ask: DeployAsk; change: string }) {
  const deploy = useDeploy();
  const hold = useHoldDeploy();
  const toast = useToast();
  const fail = (what: string) => (error: unknown) =>
    toast(what, { detail: describeError(error), tone: "error" });
  const line = [
    ask.after === undefined ? undefined : `${capital(ask.after)} is healthy at ${ask.commit.slice(0, 7)}.`,
    ask.lines === undefined
      ? undefined
      : `The ${change} is ${ask.lines} ${ask.lines === 1 ? "line" : "lines"}.`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return (
    <DockBar
      label={`Deploy to ${ask.env}`}
      lamp="needs"
      title={`Deploy to ${ask.env}?`}
      line={line === "" ? undefined : line}
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            data-primary-action=""
            disabled={deploy.isPending || hold.isPending}
            onClick={() =>
              deploy.mutate(
                { project: ask.project, env: ask.env, task, commit: ask.commit },
                { onError: fail("Could not deploy") },
              )
            }
          >
            Deploy {ask.env}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={deploy.isPending || hold.isPending}
            onClick={() =>
              hold.mutate(
                { project: ask.project, env: ask.env, task, commit: ask.commit },
                { onError: fail("Could not hold it") },
              )
            }
          >
            Hold
          </Button>
        </>
      }
    />
  );
}
