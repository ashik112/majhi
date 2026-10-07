import type { TaskSummary } from "@majhi/shared";
import { LAMP_TEXT, type LampState } from "@/components/ui/lamp";
import { TypeTile } from "../tasks-ui/type-chip";
import { plainTitle } from "./model";

/** What a subtask is doing, in a word: done, running, waits, or nothing while it is only queued. */
function kidState(kid: TaskSummary): { word: string; lamp: LampState } | undefined {
  if (kid.status === "done") return { word: "done", lamp: "done" };
  if (kid.status === "running") return { word: "running", lamp: "working" };
  if (kid.waitingOn.length > 0) return { word: "waits", lamp: "idle" };
  return undefined;
}

/** The subtasks of a parent, nested under it on its card, one line each. A click opens one. */
export function KidsList({ kids, onOpen }: { kids: readonly TaskSummary[]; onOpen: (id: string) => void }) {
  return (
    <ul className="relative -mx-1 mt-0.5 flex flex-col gap-0.5 border-t border-line px-1 pt-1.5">
      {kids.map((kid) => {
        const state = kidState(kid);
        return (
          <li key={kid.id}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(kid.id);
              }}
              title={`${kid.id}  ${plainTitle(kid.title)}`}
              className="relative flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-3.5 text-left text-sm hover:bg-raised before:absolute before:top-[-2px] before:bottom-1/2 before:left-1 before:w-1.5 before:rounded-bl-[4px] before:border-b before:border-l before:border-line-bright before:content-['']"
            >
              <TypeTile typing={kid.typing} size="sm" />
              <span className="min-w-0 flex-1 truncate text-fg-soft">{plainTitle(kid.title)}</span>
              {state !== undefined && (
                <span className={`shrink-0 text-xs ${LAMP_TEXT[state.lamp]}`}>{state.word}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
