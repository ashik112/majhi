import { collapseHome } from "@majhi/shared";
import { FileWarning, RotateCw } from "lucide-react";
import { CommandLine } from "@/components/command-line";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

/** majhi.yaml exists but does not pass the schema. The owner fixes the file by hand, then retries. */
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
  return (
    <Problem
      icon={<FileWarning />}
      tone="red"
      title="majhi.yaml has errors"
      body="majhi could not load its config. Fix the file, then retry. Nothing changes until it loads."
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

      <div>
        <Button variant="primary" onClick={onRetry} disabled={retrying}>
          <RotateCw aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
          {retrying ? "Checking" : "Retry"}
        </Button>
      </div>
    </Problem>
  );
}
