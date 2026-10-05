import { type HealthRunOutput, healthRunDue } from "@majhi/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type ApiRequestError, cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { opsKeys } from "@/lib/ops-queries";

/**
 * One action that checks everything: the server runs the doctor checks, every account and every
 * connection, and tells the page as each finishes, so `data.run` is the progress. A run starts by
 * itself, once per visit, when the last full run is older than 15 minutes.
 */
export function useCheckAll(data: HealthRunOutput | undefined) {
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const [finished, setFinished] = useState(false);
  const start = useMutation<{ started: boolean; total: number }, ApiRequestError, void>({
    mutationFn: () => cmd("health.checkAll", {}, { reason: "Owner ran the health check" }),
    onSuccess: () => {
      setError(undefined);
      return client.invalidateQueries({ queryKey: opsKeys.checks });
    },
    onError: (err) => setError(describeError(err)),
  });
  const serverRunning = data?.run.running === true;
  const running = start.isPending || serverRunning;

  // A run that was going and has ended: say so once.
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !serverRunning) setFinished(true);
    if (serverRunning) setFinished(false);
    was.current = serverRunning;
  }, [serverRunning]);

  const tried = useRef(false);
  const mutate = useRef(start.mutate);
  mutate.current = start.mutate;
  useEffect(() => {
    if (tried.current || data === undefined) return;
    tried.current = true;
    if (healthRunDue({ lastFullRunAt: data.lastFullRunAt, running: data.run.running, now: Date.now() })) {
      mutate.current();
    }
  }, [data]);

  return {
    running,
    // Between the press and the server's first answer, the numbers of the last run are not this run's.
    done: serverRunning ? (data?.run.done ?? 0) : 0,
    total: serverRunning ? (data?.run.total ?? 0) : 0,
    finished,
    error,
    run: () => start.mutate(),
  };
}
