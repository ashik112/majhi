import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MajhiMark } from "@/components/ui/majhi-mark";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { queryKeys, useConfig } from "@/lib/queries";
import { FirstTaskStep } from "./first-task-step";
import { FolderStep } from "./folder-step";
import { ProjectsPicker } from "./projects-pick";
import { RiverScene, type SceneStop } from "./scene/river-scene";
import { SignInStep } from "./sign-in-step";
import { savePlace } from "./skip";
import { type SetupStepId, setupSteps, stepIndex } from "./steps";

/** How long the boat takes to reach the ghat before the arrive moment lights up. */
const ARRIVE_AFTER_MS = 2600;

/**
 * Setup: the river on the left, the step on the right. Three steps: sign in, projects, the first task. The place
 * is saved on every move, so a reload comes back to the same step.
 */
export function SetupFlow({
  start,
  onLater,
  onArrive,
}: {
  start: SetupStepId;
  /** "Finish later": back to the app, and setup stops opening by itself. */
  onLater: () => void;
  /** The end: the id of the task that was started, or none when the owner looked around instead. */
  onArrive: (task?: string) => void;
}) {
  const queryClient = useQueryClient();
  const reduced = useReducedMotion() ?? false;
  const config = useConfig().data;
  const [index, setIndex] = useState(() => stepIndex(start));
  const [folderDone, setFolderDone] = useState(false);
  const [found, setFound] = useState("");
  const [arrived, setArrived] = useState(false);
  const last = setupSteps.length - 1;
  const current = setupSteps[index];
  // A computer majhi has not seen has no majhi.yaml: the folder comes before the first step.
  const needsFolder = config?.status === "first-run" && !folderDone;

  useEffect(() => {
    if (current) savePlace(current.id);
  }, [current]);

  useEffect(() => {
    if (index !== last) {
      setArrived(false);
      return;
    }
    const timer = window.setTimeout(() => setArrived(true), reduced ? 0 : ARRIVE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [index, last, reduced]);

  if (!current) return null;
  const next = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.onboarding });
    setIndex((i) => Math.min(last, i + 1));
  };
  // The river: where the boat set out, then the three stops.
  const stops: SceneStop[] = [
    { id: "welcome", title: "Welcome", state: "done" },
    ...setupSteps.map(
      (s, i): SceneStop => ({
        id: s.id,
        title: s.title,
        state: i === index ? "current" : i < index ? "done" : "todo",
      }),
    ),
  ];

  const why =
    current.id === "signin"
      ? "majhi runs agents on your own Claude or Codex plan. Pick one; you can add more later."
      : current.id === "projects"
        ? `${found} Agents work only in the projects you pick.`.trim()
        : "Say what you want in plain words. A lead agent plans it, works in its own copy of the repo, and asks you before it pushes.";

  return (
    <main className="flex min-h-0 flex-1 gap-3 p-3 max-[860px]:flex-col">
      <div
        className={cn(
          "relative flex shrink-0 overflow-hidden rounded-2xl border border-glass-line shadow-glass",
          "w-[clamp(340px,36vw,540px)] max-[860px]:h-[180px] max-[860px]:w-full",
        )}
      >
        <RiverScene
          className="size-full max-[860px]:[&_nav]:hidden"
          stops={stops}
          current={index + 1}
          arrived={arrived}
          onPick={(i) => i > 0 && !needsFolder && i - 1 <= index && setIndex(i - 1)}
        />
        <div className="pointer-events-none absolute top-4 left-4 flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-[7px] bg-brand text-brand-ink shadow-[0_4px_14px_-4px_var(--c-brand)]"
          >
            <MajhiMark className="w-[19px]" />
          </span>
          <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg [text-shadow:0_0_8px_var(--rv-label-halo)]">
            majhi
          </span>
        </div>
      </div>

      <section
        aria-labelledby="setup-heading"
        className={cn(GLASS, "flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl px-8 max-[1180px]:px-6")}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-[560px] flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 pt-6 pb-1">
            <p className="m-0 font-mono text-sm text-fg-faint tabular-nums">
              Step {index + 1} of {setupSteps.length}
            </p>
            <Button variant="ghost" size="sm" className="-mr-2.5 ml-auto" onClick={onLater}>
              Finish later
            </Button>
          </header>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={needsFolder ? "folder" : current.id}
              data-step={current.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: reduced ? 0 : 0.32, ease: [0.16, 1, 0.3, 1] }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="my-auto flex max-h-full min-h-0 flex-col overflow-y-auto pb-[4vh]">
                <div className="flex shrink-0 flex-col gap-2 pt-3 pb-6">
                  <h1
                    id="setup-heading"
                    className="m-0 text-xl font-semibold tracking-[-0.012em] text-balance"
                  >
                    {needsFolder ? "Where are your repos?" : current.heading}
                  </h1>
                  {!needsFolder && <p className="m-0 text-body text-fg-muted text-pretty">{why}</p>}
                </div>
                {needsFolder ? (
                  <FolderStep onDone={() => setFolderDone(true)} />
                ) : current.id === "signin" ? (
                  <SignInStep onNext={next} />
                ) : current.id === "projects" ? (
                  <ProjectsPicker onAdded={next} note={setFound} />
                ) : (
                  <FirstTaskStep onStarted={(id) => onArrive(id)} onSkip={() => onArrive()} />
                )}
              </div>
            </m.div>
          </AnimatePresence>
        </div>
      </section>
    </main>
  );
}
