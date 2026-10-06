import type { CaptainChore } from "@majhi/shared";
import type { CaptainPorts } from "./ports.ts";
import type { ChoreRun } from "./runner.ts";

/**
 * Keeps each workspace's project wikis current while Auto-pilot is on (`upkeep-wiki`). One chore, one action a day: it
 * runs the same update the owner's button runs, for a workspace whose wiki is on and whose projects moved past the
 * commit their pages were built from, and only while the workspace's budget has room. A wiki nothing has changed
 * since costs nothing: the check is git, no model. A project never built is left to the owner's first Update, which
 * is the one that costs a first build. While Auto-pilot is off the chore never runs (`choresNow`).
 */
export function createWikiChore(
  ports: CaptainPorts,
): Pick<Record<CaptainChore, (run: ChoreRun) => Promise<void>>, "wiki"> {
  return {
    async wiki(run) {
      const w = ports.wiki;
      if (w === undefined || run.ws.rulesOff?.has("wiki-update") === true) return;
      const { org, ws } = run;
      if (!(await w.enabled(org))) return;
      const state = await w.stale(org);
      if (state.projects.length === 0) return;
      const rest = await ports.laneRest(org);
      if (rest !== undefined) {
        run.note(`wiki:${org}`, `Left the wiki of ${ws.name}`, `The workspace's budget is used up: ${rest}`);
        return;
      }
      const names = state.projects.join(", ");
      await run.act({
        key: `wiki:update:${org}:${ws.day}`,
        text: `Updated the wiki of ${ws.name}`,
        reason: `${names} moved past what the wiki was built from. It updates at most once a day, within the workspace's budget`,
        do: async () => {
          const r = await w.update(org);
          return {
            text: `Updated the wiki of ${ws.name}: ${r.summary}`,
            undoNote: "The wiki only describes the code. Every older version of a page is kept",
          };
        },
      });
    },
  };
}
