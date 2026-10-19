import { type LabelTask, PRIVATE_NAME, taskLabel } from "@majhi/shared";
import { useOrgs } from "@/lib/studio-queries";

/**
 * `project · Name` for any task shape that carries a name, a title and its repos: the one label every
 * screen shows instead of the id (the id stays in the address and in a tooltip). With no project it
 * names the workspace, from the orgs the app already holds.
 */
export function useTaskLabel(): (task: LabelTask) => string {
  const orgs = useOrgs().data;
  return (task) =>
    taskLabel(
      task,
      task.org === undefined ? PRIVATE_NAME : (orgs?.find((o) => o.id === task.org)?.name ?? task.org),
    );
}
