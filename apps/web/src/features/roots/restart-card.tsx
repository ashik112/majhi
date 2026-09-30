import { collapseHome, type WorkspacesUpdateResult } from "@majhi/shared";
import { FolderX, RotateCw } from "lucide-react";
import * as m from "motion/react-m";
import { CommandLine } from "@/components/command-line";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

/**
 * Shown after saving roots that majhi cannot see yet when no host helper can remount them.
 * Container mounts are fixed at start, so the owner runs the restart command on the host (SPEC 3.5).
 */
export function RestartCard({
  result,
  home,
  continueLabel,
  onContinue,
}: {
  result: WorkspacesUpdateResult;
  home: string;
  /** The secondary action: carry on without restarting, for example "Show repos now". */
  continueLabel: string;
  onContinue: () => void;
}) {
  const count = result.unmounted.length;
  return (
    <m.section
      aria-labelledby="restart-title"
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-fit w-full max-w-[600px] flex-col rounded-xl border border-amber-line bg-card"
    >
      <div className="flex flex-col gap-2 p-5 pb-4">
        <h1 id="restart-title" className="text-lg font-semibold text-balance">
          Saved. Restart majhi to see {count === 1 ? "this root" : "these roots"}
        </h1>
        <p className="text-base text-fg-muted text-pretty">
          {count === 1 ? "This root is" : "These roots are"} in majhi.yaml but not visible to majhi yet. It
          only sees folders that were mounted when it started.
        </p>
      </div>

      <ul
        aria-label="Roots not mounted yet"
        className="mx-5 flex flex-col rounded-md border border-line-strong"
      >
        {result.unmounted.map((path) => (
          <li
            key={path}
            className="flex h-9 items-center gap-2.5 border-line-strong px-3 not-last:border-b"
            title={path}
          >
            <FolderX aria-hidden="true" className="size-3.5 shrink-0 text-amber" />
            <span className="min-w-0 truncate font-mono text-base text-fg">{collapseHome(path, home)}</span>
            <span className="ml-auto shrink-0 text-sm text-fg-faint">not mounted</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 px-5 pt-5">
        <p className="text-base text-fg-soft">
          Run this in the majhi folder on your machine, then reload this page.
        </p>
        <CommandLine command={result.restartCommand} />
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-line px-5 py-3">
        <p className="text-sm text-fg-faint">{plural(count, "root")} waiting for a restart</p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={onContinue}>
            {continueLabel}
          </Button>
          <Button variant="primary" onClick={() => window.location.assign("/")}>
            <RotateCw aria-hidden="true" />
            Reload
          </Button>
        </div>
      </div>
    </m.section>
  );
}
