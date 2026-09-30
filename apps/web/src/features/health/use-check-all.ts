import type { AccountView } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { plural } from "@/lib/format";
import { opsKeys } from "@/lib/ops-queries";
import { useAccountHealth } from "@/lib/studio-queries";

/** Checks every account, three at a time, and reports how far it got. Each check also refreshes the list. */
export function useCheckAll(accounts: readonly AccountView[]) {
  const health = useAccountHealth();
  const client = useQueryClient();
  const [state, setState] = useState({ running: false, done: 0, total: 0, finished: false });
  const [error, setError] = useState<string>();
  const mutate = useRef(health.mutateAsync);
  mutate.current = health.mutateAsync;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function run() {
    const ids = accounts.map((a) => a.id);
    setError(undefined);
    setState({ running: true, done: 0, total: ids.length, finished: false });
    let next = 0;
    let failed = 0;
    let done = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (id === undefined) return;
        try {
          await mutate.current(id);
        } catch {
          failed += 1;
        }
        done += 1;
        if (live.current) setState((s) => ({ ...s, done }));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // The checks list reads each account's fresh result, so it runs after them.
    await client.invalidateQueries({ queryKey: opsKeys.checks }).catch(() => undefined);
    if (!live.current) return;
    setState({ running: false, done, total: ids.length, finished: true });
    if (failed > 0) setError(`${plural(failed, "account")} could not be checked. Open them for details.`);
  }

  return { ...state, error, run };
}
