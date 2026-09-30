import type { ProjectView } from "@majhi/shared";
import { Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { describeError } from "@/lib/errors";
import { useTaskRecords } from "@/lib/memory-queries";
import { ProjectPicker, useChosenProject } from "./project-picker";
import { RecordCard } from "./record-card";

/** Every finished task's record, newest first, or ranked by a search over meaning and words. */
export function RecordsView({
  projects,
  orgNames,
}: {
  projects: readonly ProjectView[] | undefined;
  orgNames: ReadonlyMap<string, string>;
}) {
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const [project, setProject] = useChosenProject("majhi.memory.records-project", projects, true);
  const records = useTaskRecords({
    query,
    project: project === "" || project === undefined ? undefined : project,
  });
  const searching = query.trim() !== "";
  const list = records.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
          />
          <Input
            type="search"
            aria-label="Search task records"
            placeholder="Search past tasks: an area, a file, a problem"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-11 pl-9"
          />
        </div>
        {projects !== undefined && projects.length > 1 && (
          <ProjectPicker
            projects={projects}
            orgNames={orgNames}
            value={project}
            onChange={setProject}
            allowAll
            className="h-11"
          />
        )}
      </div>

      {records.isError && <p className="m-0 text-base text-red">{describeError(records.error)}</p>}
      {records.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
      {records.data !== undefined && (
        <section aria-label={searching ? "Matching tasks" : "Finished tasks"} className="flex flex-col gap-3">
          {searching && (
            <p className="m-0 text-sm text-fg-faint">
              {list.length} {list.length === 1 ? "match" : "matches"}
            </p>
          )}
          {list.length === 0 ? (
            <p className="m-0 text-base text-fg-muted text-pretty">
              {searching
                ? "No finished task matches."
                : "No task records yet. When a task is done, the Housekeeper writes what it was for, what it changed, what was decided and what is left."}
            </p>
          ) : (
            <ol aria-label="Task records" className="m-0 flex list-none flex-col gap-3 p-0">
              {list.map((hit) => (
                <li key={hit.record.id}>
                  <RecordCard record={hit.record} />
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
