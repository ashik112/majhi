import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { getHealth } from "@/lib/api";
import { reloadAfterRestart } from "@/lib/queries";

/**
 * - `stopping`: the old server still answers; the helper is about to recreate it.
 * - `starting`: `/health` failed, so the new server is on its way up.
 * - `scanning`: it answers again; loading the config and a fresh scan.
 * - `timed-out`: no answer after `RESTART_TIMEOUT_MS`.
 */
export type RestartPhase = "stopping" | "starting" | "scanning" | "timed-out";

export const RESTART_TIMEOUT_MS = 90_000;
const POLL_MS = 500;
/** A probe that hangs is as good as a failure: the server is between containers. */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * Follows a restart the host helper started. `/health` keeps answering until the old server
 * stops, fails while the new one starts, then answers again. Once it is back, this reloads the
 * config and the repos and calls `onBack`.
 *
 * `checkAgain` starts over after a time-out, and then takes the first answer as the way back:
 * the restart may have finished while nobody was watching.
 */
export function useRestartWatch(onBack: () => void) {
  const client = useQueryClient();
  const [phase, setPhase] = useState<RestartPhase>("stopping");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const back = useEffectEvent(onBack);

  useEffect(() => {
    const stop = new AbortController();
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    let wentDown = attempt > 0;
    let timer: number | undefined;

    async function probe() {
      if (stop.signal.aborted) return;
      if (Date.now() > deadline) {
        setPhase("timed-out");
        return;
      }
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
      const up = await getHealth(signal).then(
        () => true,
        () => false,
      );
      if (stop.signal.aborted) return;

      if (!up) {
        wentDown = true;
        setPhase("starting");
      } else if (wentDown) {
        setPhase("scanning");
        try {
          await reloadAfterRestart(client);
          if (!stop.signal.aborted) back();
          return;
        } catch {
          // It went away again mid-scan; keep watching.
          setPhase("starting");
        }
      }
      timer = window.setTimeout(probe, POLL_MS);
    }
    void probe();

    return () => {
      stop.abort();
      window.clearTimeout(timer);
    };
  }, [client, attempt]);

  function checkAgain() {
    setPhase("starting");
    setStartedAt(Date.now());
    setAttempt((n) => n + 1);
  }

  return { phase, startedAt, checkAgain };
}
