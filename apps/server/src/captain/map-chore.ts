import type { CaptainChore } from "@majhi/shared";
import type { CaptainPorts } from "./ports.ts";
import type { ChoreRun } from "./runner.ts";

/**
 * Keeps each workspace's project map current while Auto-pilot is on (SPEC 5.20). One chore, one action:
 * it runs the same `map.update` the owner's button runs, when work merged since the map was updated,
 * at most once in 24 hours, and only while the workspace's budget has room. A map nothing has changed
 * since costs nothing: the check is two reads, no model. While Auto-pilot is off the chore never runs
 * (`choresNow`), and it has no schedule or setting of its own.
 */

const DAY_MS = 86_400_000;

export function createMapChore(
  ports: CaptainPorts,
  now: () => Date,
): Pick<Record<CaptainChore, (run: ChoreRun) => Promise<void>>, "map"> {
  return {
    async map(run) {
      const m = ports.map;
      if (m === undefined || run.ws.rulesOff?.has("map-update") === true) return;
      const { org, ws } = run;
      const state = await m.stale(org);
      if (!state.stale) return;
      if (state.updatedAt !== undefined && now().getTime() - Date.parse(state.updatedAt) < DAY_MS) return;
      const rest = await ports.laneRest(org);
      if (rest !== undefined) {
        run.note(
          `map:${org}`,
          `Left the project map of ${ws.name}`,
          `The workspace's budget is used up: ${rest}`,
        );
        return;
      }
      const merges = `${state.merges} ${state.merges === 1 ? "task" : "tasks"}`;
      await run.act({
        key: `map:update:${org}:${ws.day}`,
        text: `Updated the project map of ${ws.name}`,
        reason: `${merges} merged since the map was updated. It updates at most once a day, within the workspace's budget`,
        do: async () => {
          const r = await m.update(org);
          return {
            text: `Updated the project map of ${ws.name}: ${r.summary}`,
            undoNote: "The map only describes the projects. Remove a line you do not trust on the Map page",
          };
        },
      });
    },
  };
}
