import { collapseHome, type WorkspacesUpdateResult } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, FolderSearch } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { MissingFolders } from "@/features/roots/missing-folders";
import { draftFromConfig } from "@/features/roots/model";
import { RestartCard } from "@/features/roots/restart-card";
import { RestartingCard } from "@/features/roots/restarting-card";
import { RootsForm } from "@/features/roots/roots-form";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { queryKeys, useConfig, useSetWorkspaces, useSuggestRoots } from "@/lib/queries";
import { GroupTitle, Problem, StepFrame, useStep } from "./step-frame";

/**
 * Welcome: what majhi is, then the project folder. One click takes the folder majhi suggests;
 * "Choose another" opens the full folder picker. Every later step writes majhi.yaml, which only
 * loads with a folder, so this one comes first and cannot be skipped.
 */
export function WelcomeStep() {
  const step = useStep();
  const config = useConfig();
  const toast = useToast();
  const client = useQueryClient();
  const [pending, setPending] = useState<WorkspacesUpdateResult | null>(null);
  const [choosing, setChoosing] = useState(false);
  const state = config.data;
  const home = state?.home ?? "";

  const onSaved = (result: WorkspacesUpdateResult) => {
    // The journey's status reads the folder; ask for it again now rather than on the next event.
    void client.invalidateQueries({ queryKey: queryKeys.onboarding });
    if (result.remount !== "not-needed") {
      setPending(result);
      return;
    }
    toast("Folder saved");
    step.next();
  };

  if (pending?.remount === "restarting") {
    return (
      <StepFrame skippable={false}>
        <RestartingCard
          roots={pending.unmounted}
          home={pending.state.home}
          onBack={() => {
            toast("Folder mounted");
            step.next();
          }}
        />
      </StepFrame>
    );
  }
  if (pending) {
    return (
      <StepFrame skippable={false}>
        <RestartCard result={pending} home={pending.state.home} />
      </StepFrame>
    );
  }

  const roots = step.status.roots;

  return (
    <StepFrame skippable={false}>
      <div className="flex flex-col gap-8">
        <section aria-labelledby="folder-title" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <GroupTitle>
              <span id="folder-title">Your project folder</span>
            </GroupTitle>
            <p className="m-0 text-base text-fg-muted text-pretty">
              Where your git repos live. majhi needs it before it can save anything else.
            </p>
          </div>
          {roots.length > 0 && !choosing ? (
            <ChosenRoots roots={roots} home={home} onChange={() => setChoosing(true)} />
          ) : choosing || state === undefined ? (
            state && (
              <RootsForm
                bare
                mode={state.status === "loaded" ? "edit" : "first-run"}
                home={state.home}
                file={state.file}
                initial={
                  state.status === "loaded"
                    ? draftFromConfig(state.config, state.home)
                    : { rows: [], tasksDir: "" }
                }
                onSaved={onSaved}
                {...(roots.length > 0 ? { onCancel: () => setChoosing(false) } : {})}
              />
            )
          ) : (
            <Suggestion home={home} onSaved={onSaved} onChoose={() => setChoosing(true)} />
          )}
        </section>
      </div>
    </StepFrame>
  );
}

/** The one folder majhi suggests, with a single button to use it. */
function Suggestion({
  home,
  onSaved,
  onChoose,
}: {
  home: string;
  onSaved: (result: WorkspacesUpdateResult) => void;
  onChoose: () => void;
}) {
  const suggest = useSuggestRoots();
  const save = useSetWorkspaces(onSaved);
  const top = suggest.data?.[0];

  if (suggest.isError || (suggest.data && !top)) {
    return (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-base text-fg-muted text-pretty">
          {suggest.isError
            ? "majhi could not look for folders on this computer. Pick one yourself."
            : "No folder in your home holds a git repo majhi can find. Pick one yourself."}
        </p>
        <div>
          <Button variant="primary" size="lg" onClick={onChoose}>
            <FolderSearch aria-hidden="true" />
            Choose a folder
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "flex min-h-[76px] items-center gap-4 rounded-xl border border-accent-line bg-accent-wash px-4 py-3.5",
          !top && "border-line-strong bg-card",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-accent-line bg-field">
          <Folder aria-hidden="true" className="size-[18px] text-accent-text" />
        </span>
        {top ? (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-mono text-md text-fg" title={top.path}>
              {collapseHome(top.path, home)}
            </span>
            <span className="text-sm text-fg-muted">
              {plural(top.repoCount, "git repo")} inside. Suggested for you.
            </span>
          </div>
        ) : (
          <div aria-busy="true" className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="sr-only">Looking for folders with git repos</span>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        )}
        <Button
          variant="primary"
          size="lg"
          disabled={!top || save.isPending}
          onClick={() => top && save.mutate({ workspaces: [collapseHome(top.path, home)] })}
        >
          {save.isPending ? "Saving" : top ? `Use ${collapseHome(top.path, home)}` : "Use this folder"}
        </Button>
      </div>
      <MissingFolders save={save} />
      {save.error && (
        <Problem>
          {save.error.unreachable ? "majhi is not responding. The folder was not saved." : save.error.message}
        </Problem>
      )}
      <p className="m-0 text-sm text-fg-faint">
        Keep your repos somewhere else?{" "}
        <button
          type="button"
          onClick={onChoose}
          className="cursor-pointer text-accent-text underline decoration-accent-line underline-offset-[3px] hover:decoration-accent-text"
        >
          Choose another folder
        </button>
      </p>
    </div>
  );
}

function ChosenRoots({
  roots,
  home,
  onChange,
}: {
  roots: readonly string[];
  home: string;
  onChange: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Project folders" className="m-0 flex list-none flex-col gap-1.5 p-0">
        {roots.map((root) => (
          <li
            key={root}
            className="flex h-11 items-center gap-3 rounded-lg border border-line-strong bg-card px-3.5"
            title={root}
          >
            <Folder aria-hidden="true" className="size-4 shrink-0 text-accent-text" />
            <span className="min-w-0 truncate font-mono text-base text-fg">{collapseHome(root, home)}</span>
            <span className="ml-auto text-sm text-green">Set</span>
          </li>
        ))}
      </ul>
      <div>
        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={onChange}>
          Change folders
        </Button>
      </div>
    </div>
  );
}
