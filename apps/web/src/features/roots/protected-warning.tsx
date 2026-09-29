import { type DockerRuntime, dockerRuntimeName } from "@majhi/shared";
import { ShieldAlert } from "lucide-react";
import { type ProtectedRoot, protectedWarning } from "./model";

/** Shown before saving a root in a folder macOS guards, so the owner is not surprised by the system prompt. */
export function ProtectedWarning({
  found,
  runtime,
}: {
  found: readonly ProtectedRoot[];
  runtime: DockerRuntime | undefined;
}) {
  if (found.length === 0) return null;
  return (
    <div
      role="note"
      aria-label="macOS folder access"
      className="mx-4 mb-4 flex gap-2 rounded-md border border-amber-line bg-amber-wash px-3 py-2.5"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-soft" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-base text-amber-soft text-pretty">
          {protectedWarning(found, dockerRuntimeName(runtime))}
        </p>
        <p className="truncate font-mono text-sm text-fg-muted">{found.map((f) => f.path).join(", ")}</p>
      </div>
    </div>
  );
}
