import { PAGE_PATH } from "@majhi/shared";
import { Outlet, useRouterState, useSearch } from "@tanstack/react-router";
import * as m from "motion/react-m";
import { Suspense, useMemo } from "react";
import { InShellContext } from "@/components/centered-page";
import { AttentionBanner } from "@/components/shell/banner";
import { CaptainTicker } from "@/components/shell/captain-ticker";
import { NotifyPrompt } from "@/components/shell/notify-prompt";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import { Sidebar } from "@/components/shell/sidebar";
import { StaleBuildBar } from "@/components/shell/stale-build";
import { AgentDrawer } from "@/features/agent-drawer/agent-drawer";
import { BossProvider, useBoss } from "@/features/boss/boss-context";
import { LazyBossDrawer } from "@/features/boss/boss-drawer-lazy";
import { ChatDock } from "@/features/chat-dock/chat-dock";
import { useNeedsYou } from "@/features/decisions/needs-you";
import { AppGate } from "@/features/home/app-gate";
import { NewTaskProvider, useNewTask } from "@/features/new-task/new-task-context";
import { Palette } from "@/features/search/palette";
import { isSettingsPath, SettingsFrame } from "@/features/settings/settings-frame";
import { deriveBanner, homeRowIds } from "@/features/shell/model";
import { useShortcuts } from "@/features/shell/use-shortcuts";
import { TaskDrawer } from "@/features/task-drawer/task-drawer";
import { UpdateOverlay } from "@/features/update/update-overlay";
import { GlobalFileViewer } from "@/features/viewer/global-file-viewer";
import { usePendingPermission } from "@/lib/attention";
import { useAttentionBadge } from "@/lib/browser-notify";
import { cn } from "@/lib/cn";
import { useDecisions } from "@/lib/decision-queries";
import { useAdoptOrgParam, useOrgFilter } from "@/lib/org-filter";
import { useServerEvents } from "@/lib/use-server-events";
import { useArrivalNewTask } from "@/onboarding/arrive";

/** Pages that lay out their own panes to fit the viewport. */
const PINNED: ReadonlySet<string> = new Set([
  PAGE_PATH.today,
  PAGE_PATH.captain,
  PAGE_PATH.limits,
  PAGE_PATH.decisions,
  PAGE_PATH.chats,
  PAGE_PATH.agents,
  PAGE_PATH.connections,
  PAGE_PATH.skills,
  PAGE_PATH.usage,
  PAGE_PATH.audit,
  PAGE_PATH.orgs,
]);

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
            <Frame />
          </BossProvider>
        </NewTaskProvider>
      </AppGate>
      <UpdateOverlay />
    </div>
  );
}

/** The sidebar, the banner that appears when something needs the owner, and the page. */
function Frame() {
  const newTask = useNewTask();
  const { helpOpen, setHelpOpen, paletteOpen, setPaletteOpen } = useShortcuts(newTask.open);
  useArrivalNewTask(newTask.open);
  useAdoptOrgParam();
  const decisions = useDecisions().data?.decisions;
  const permission = usePendingPermission();
  const { task: drawerTask, peek } = useSearch({ from: "__root__" });
  const onHome = useRouterState({ select: (s) => s.location.pathname === "/" });
  // On `/t/<id>` the page is that task: the banner and the captain's line leave it alone.
  const openTask = useRouterState({
    select: (s) => {
      const [, first, id] = s.location.pathname.split("/");
      return first === "t" ? id : undefined;
    },
  });
  const { org } = useOrgFilter();
  // Home draws every decision as a row: its banner only says what is not on the screen.
  const banner = useMemo(
    () =>
      deriveBanner({
        decisions,
        permission,
        onScreen: onHome ? homeRowIds(decisions, org) : undefined,
        openTask,
      }),
    [decisions, permission, onHome, org, openTask],
  );
  useAttentionBadge(useNeedsYou() ?? 0);
  // The Captain drawer's code is read when it opens (the sidebar warms it when the pointer reaches its button).
  const { open: bossOpen } = useBoss();
  // The page fades in when the section changes (board, task, a page), not on every task switch.
  const section = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith("/t/")
        ? "/"
        : s.location.pathname.startsWith("/chats")
          ? PAGE_PATH.chats
          : s.location.pathname,
  });
  // The board, the task view and the list-and-detail pages fix their own frame and scroll inside it;
  // other pages scroll here.
  // Settings pages sit in one frame with the Settings list; the frame scrolls the page itself.
  const settings = isSettingsPath(section);
  const pinned = section === "/" || PINNED.has(section) || settings;

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <Sidebar />
      <main id="main" tabIndex={-1} className="flex h-full min-w-0 flex-1 flex-col outline-none">
        <StaleBuildBar />
        <NotifyPrompt />
        <AttentionBanner banner={banner} />
        {openTask === undefined && <CaptainTicker />}
        <m.div
          key={settings ? "settings" : section}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
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
        </m.div>
      </main>
      {bossOpen && (
        <Suspense fallback={null}>
          <LazyBossDrawer />
        </Suspense>
      )}
      <GlobalFileViewer />
      <ChatDock />
      {drawerTask !== undefined && <TaskDrawer id={drawerTask} />}
      {peek !== undefined && drawerTask === undefined && <AgentDrawer id={peek} />}
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
