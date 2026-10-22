import { PAGE_PATH } from "@majhi/shared";
import { Outlet, useRouterState, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { InShellContext } from "@/components/centered-page";
import { NotifyPrompt } from "@/components/shell/notify-prompt";
import { StaleBuildBar } from "@/components/shell/stale-build";
import { BossProvider } from "@/features/boss/boss-context";
import { ConsoleDataProvider } from "@/features/console/data-context";
import { TopBar } from "@/features/console/top-bar";
import { UndoToast } from "@/features/console/undo-toast";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { AppGate } from "@/features/home/app-gate";
import { NewTaskProvider, useNewTask } from "@/features/new-task/new-task-context";
import { isSettingsPath, SettingsFrame } from "@/features/settings/settings-frame";
import { useShortcuts } from "@/features/shell/use-shortcuts";
import { UpdateOverlay } from "@/features/update/update-overlay";
import { GlobalFileViewer } from "@/features/viewer/global-file-viewer";
import { useAttentionBadge } from "@/lib/browser-notify";
import { cn } from "@/lib/cn";
import { useAdoptOrgParam } from "@/lib/org-filter";
import { preloadOpenOnDemand } from "@/lib/preload";
import { useServerEvents } from "@/lib/use-server-events";
import { useArrivalNewTask } from "@/onboarding/arrive";

// What opens on demand is read when it first opens, so the first screen carries only the console.
const loadPalette = () => import("@/features/search/palette").then((m) => ({ default: m.Palette }));
const Palette = lazy(loadPalette);
const TaskDrawer = lazy(() =>
  import("@/features/task-drawer/task-drawer").then((m) => ({ default: m.TaskDrawer })),
);
const AgentDrawer = lazy(() =>
  import("@/features/agent-drawer/agent-drawer").then((m) => ({ default: m.AgentDrawer })),
);
const UpdateNotice = lazy(() =>
  import("@/features/update/update-notice").then((m) => ({ default: m.UpdateNotice })),
);
const ShortcutsDialog = lazy(() =>
  import("@/components/shell/shortcuts-dialog").then((m) => ({ default: m.ShortcutsDialog })),
);

/** Pages that lay out their own panes to fit the viewport. */
const PINNED: ReadonlySet<string> = new Set([PAGE_PATH.watch, PAGE_PATH.wiki, PAGE_PATH.usage]);

export function AppShell() {
  useServerEvents();
  return (
    <div className="relative isolate flex h-dvh min-h-0 flex-col overflow-hidden">
      <div aria-hidden="true" className="app-backdrop" />
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AppGate>
        <NewTaskProvider>
          <BossProvider>
            <ConsoleDataProvider>
              <Frame />
            </ConsoleDataProvider>
          </BossProvider>
        </NewTaskProvider>
      </AppGate>
      <UpdateOverlay />
    </div>
  );
}

/** The top bar, and under it the console or the page the owner opened (Settings pages and a task). */
function Frame() {
  const newTask = useNewTask();
  const { helpOpen, setHelpOpen, paletteOpen, setPaletteOpen } = useShortcuts(newTask.open);
  useArrivalNewTask(newTask.open);
  useAdoptOrgParam();
  useEffect(preloadOpenOnDemand, []);
  const { task: drawerTask, peek } = useSearch({ from: "__root__" });
  useAttentionBadge(useNeedsYou() ?? 0);
  // The page fades in when the section changes (a page, a task), not on every task switch.
  const section = useRouterState({
    select: (s) => (s.location.pathname.startsWith("/t/") ? "/t" : s.location.pathname),
  });
  const onConsole = section === PAGE_PATH.board;
  // Settings pages sit in one frame with the Settings list; the frame scrolls the page itself.
  const settings = isSettingsPath(section);
  const pinned = PINNED.has(section) || settings || section === "/t";

  return (
    <div className="cs-shell">
      <TopBar onSearch={() => setPaletteOpen(true)} />
      <div id="main" tabIndex={-1} className="cs-main">
        <StaleBuildBar />
        <NotifyPrompt />
        <Suspense fallback={null}>
          <UpdateNotice />
        </Suspense>
        {onConsole ? (
          <Outlet />
        ) : (
          <div
            key={settings ? "settings" : section}
            className={cn(
              "flex min-h-0 flex-1 animate-fade-in flex-col",
              pinned
                ? "overflow-hidden"
                : "overflow-y-auto overscroll-contain rounded-2xl pb-6 scroll-fade-end",
            )}
          >
            <InShellContext.Provider value={true}>
              {settings ? (
                <SettingsFrame>
                  <Outlet />
                </SettingsFrame>
              ) : (
                <Outlet />
              )}
            </InShellContext.Provider>
          </div>
        )}
      </div>
      <GlobalFileViewer />
      <UndoToast />
      <Suspense fallback={null}>
        {drawerTask !== undefined && <TaskDrawer id={drawerTask} />}
        {peek !== undefined && drawerTask === undefined && <AgentDrawer id={peek} />}
        {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      </Suspense>
    </div>
  );
}
