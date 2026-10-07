import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { cmd } from "@/lib/api";
import { deployKey } from "@/lib/deploy-queries";
import { type PlanStep, planStepsOf } from "./deploy-model";

/** The deploy steps of a task, read from the deploy views of the projects it changed. Same queries as the project page. */
export function useTaskDeploys(task: string, projects: readonly string[], enabled: boolean): PlanStep[] {
  const views = useQueries({
    queries: projects.map((project) => ({
      queryKey: deployKey(project),
      queryFn: () => cmd("projects.deployView", { project }),
      enabled,
    })),
    combine: (results) => results.map((r) => r.data),
  });
  return useMemo(() => planStepsOf(task, views), [task, views]);
}
