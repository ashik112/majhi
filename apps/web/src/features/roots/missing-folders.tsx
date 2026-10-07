import type { WorkspacesUpdate, WorkspacesUpdateResult } from "@majhi/shared";
import type { UseMutationResult } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiRequestError } from "@/lib/api";

/**
 * Shown when the server did not save because a folder does not exist. One button makes the folders
 * and saves, so the owner never goes to a terminal or Finder.
 */
export function MissingFolders({
  save,
}: {
  save: UseMutationResult<WorkspacesUpdateResult, ApiRequestError, WorkspacesUpdate>;
}) {
  const missing = save.data?.missing ?? [];
  const input = save.variables;
  if (missing.length === 0 || input === undefined || save.isPending) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-amber-line bg-amber-wash px-3 py-2.5"
    >
      <p className="m-0 flex items-start gap-1.5 text-base text-amber-soft">
        <CircleAlert aria-hidden="true" className="mt-1 size-3.5 shrink-0" />
        <span>
          {missing.length === 1 ? "This folder does not exist" : "These folders do not exist"}:{" "}
          <span className="font-mono">{missing.join(", ")}</span>
        </span>
      </p>
      <div>
        <Button size="sm" variant="primary" onClick={() => save.mutate({ ...input, create: true })}>
          {missing.length === 1 ? "Create it and save" : "Create them and save"}
        </Button>
      </div>
    </div>
  );
}
