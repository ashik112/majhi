import type { CommandOutput, HomeBackground, HomeCheck, HomeDeploy, lifecycle } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { DoingFact, MrFact } from "@/features/board/home-model";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * Why each waiting task is not running (`tasks.blockers`). Under the tasks key, so every tasks event
 * refetches it, and the task feed's patch (`task-sync.ts`) marks it stale too. A slow safety read covers
 * what has no event: a machine that calmed down, an account that signed in.
 */
export const blockersKey = [...queryKeys.tasks, "blockers"] as const;
const SAFETY_MS = 30_000;

export function useBlockers(): ReadonlyMap<string, lifecycle.Blocker | null> {
  const data = useQuery<CommandOutput<"tasks.blockers">, ApiRequestError>({
    queryKey: blockersKey,
    queryFn: () => cmd("tasks.blockers", {}),
    staleTime: SAFETY_MS,
    refetchInterval: SAFETY_MS,
    refetchIntervalInBackground: false,
  }).data;
  return useMemo(() => new Map((data ?? []).map((b) => [b.task, b.blocker])), [data]);
}

export interface HomeFacts {
  mrs: ReadonlyMap<string, MrFact>;
  /** Open merge requests of a task beyond its first. */
  mrExtra: ReadonlyMap<string, number>;
  doing: ReadonlyMap<string, DoingFact>;
  /** The merge gate verdict and hand-off state of each review task. */
  checks: ReadonlyMap<string, HomeCheck>;
  /** Hand-off checks, processes and previews that run now. */
  background: readonly HomeBackground[];
  /** The deploy steps of recently merged tasks that are not all live yet. */
  deploys: ReadonlyMap<string, HomeDeploy>;
}

/** The open merge requests and what each working agent does. The live line has no event, so it is read every few seconds. */
const FACTS_MS = 5000;

export function useHomeFacts(): HomeFacts {
  const data = useQuery<CommandOutput<"tasks.homeFacts">, ApiRequestError>({
    queryKey: [...queryKeys.tasks, "home-facts"],
    queryFn: () => cmd("tasks.homeFacts", {}),
    staleTime: FACTS_MS,
    refetchInterval: FACTS_MS,
    refetchIntervalInBackground: false,
  }).data;
  return useMemo(() => {
    const mrs = new Map<string, MrFact>();
    const mrExtra = new Map<string, number>();
    for (const m of data?.mrs ?? []) {
      if (mrs.has(m.task)) mrExtra.set(m.task, (mrExtra.get(m.task) ?? 0) + 1);
      else mrs.set(m.task, m);
    }
    const doing = new Map<string, DoingFact>();
    for (const d of data?.doing ?? []) {
      if (!doing.has(d.task)) doing.set(d.task, d);
    }
    const checks = new Map((data?.checks ?? []).map((c) => [c.task, c]));
    const deploys = new Map((data?.deploys ?? []).map((d) => [d.task, d]));
    return { mrs, mrExtra, doing, checks, background: data?.background ?? [], deploys };
  }, [data]);
}
