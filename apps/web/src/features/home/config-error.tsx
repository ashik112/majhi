import { collapseHome } from "@majhi/shared";
import { FileWarning, RotateCw } from "lucide-react";
import { CommandLine } from "@/components/command-line";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useRestoreConfig } from "@/lib/queries";

/** majhi.yaml exists but does not pass the schema. majhi puts back the last version that loaded, or the owner fixes the lines by hand. */
export function ConfigError({
  file,
  home,
  errors,
  onRetry,
  retrying,
}: {
  file: string;
  home: string;
  errors: readonly string[];
  onRetry: () => void;
  retrying: boolean;
}) {
  const restore = useRestoreConfig();
  return (
    <Problem
      icon={<FileWarning />}
      tone="red"
      title="majhi.yaml has errors"
      body="majhi could not load its config. Put back the last version that worked, or fix the lines below and retry. Nothing changes until it loads."
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg-muted">File</span>
        <CommandLine command={collapseHome(file, home)} prompt={false} />
      </div>

      <section aria-labelledby="config-errors" className="flex flex-col gap-1.5">
        <h2 id="config-errors" className="text-sm text-fg-muted">
          {plural(errors.length, "error")}
        </h2>
        <ul className="flex flex-col rounded-md border border-red-line bg-red-wash/60">
          {errors.map((error) => (
            <li
              key={error}
              className="flex gap-2.5 border-red-line/60 px-3 py-2 font-mono text-sm text-fg-soft not-last:border-b"
            >
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-red" />
              <span className="min-w-0 break-words">{error}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? "Restoring" : "Restore last working version"}
          </Button>
          <Button onClick={onRetry} disabled={retrying}>
            <RotateCw aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
            {retrying ? "Checking" : "Retry"}
          </Button>
        </div>
        {restore.error && (
          <p role="alert" className="m-0 text-sm text-red">
            {describeError(restore.error)}
          </p>
        )}
      </div>
    </Problem>
  );
}
