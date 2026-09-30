import { Outlet, useRouterState, useSearch } from "@tanstack/react-router";
import * as m from "motion/react-m";
import { useMemo } from "react";
import { InShellContext } from "@/components/centered-page";
import { AttentionBanner } from "@/components/shell/banner";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import { Sidebar } from "@/components/shell/sidebar";
import { AgentDrawer } from "@/features/agent-drawer/agent-drawer";
import { BossProvider } from "@/features/boss/boss-context";
import { BossDrawer } from "@/features/boss/boss-drawer";
import { AppGate } from "@/features/home/app-gate";
import { NewTaskProvider, useNewTask } from "@/features/new-task/new-task-context";
import { deriveBanner } from "@/features/shell/model";
import { useShortcuts } from "@/features/shell/use-shortcuts";
import { TaskDrawer } from "@/features/task-drawer/task-drawer";
import { UpdateOverlay } from "@/features/update/update-overlay";
import { useAgentIndex } from "@/lib/agent-index";
import { usePendingPermission } from "@/lib/attention";
import { cn } from "@/lib/cn";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useServerEvents } from "@/lib/use-server-events";

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
  const { helpOpen, setHelpOpen } = useShortcuts(newTask.open);
  const { org } = useOrgFilter();
  const tasks = useTasks().data;
  const accounts = useAccounts().data;
  const agents = useAgentIndex();
  const permission = usePendingPermission();
  const { task: drawerTask, peek } = useSearch({ from: "__root__" });
  const now = useNow(60_000);
  const banner = useMemo(
    () => deriveBanner({ tasks: tasks ?? [], agents, accounts: accounts ?? [], permission, now }),
    [tasks, agents, accounts, permission, now],
  );
  // The page fades in when the section changes (board, task, a page), not on every task switch.
  const section = useRouterState({
    select: (s) => (s.location.pathname.startsWith("/t/") ? "/" : s.location.pathname),
  });
  // The board and the task view fix their own frame and scroll inside it; other pages scroll here.
  const pinned = section === "/";

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <Sidebar />
      <main id="main" tabIndex={-1} className="flex h-full min-w-0 flex-1 flex-col outline-none">
        <AttentionBanner banner={banner} org={org} />
        <m.div
          key={section}
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
            <Outlet />
          </InShellContext.Provider>
        </m.div>
      </main>
      <BossDrawer />
      {drawerTask !== undefined && <TaskDrawer id={drawerTask} />}
      {peek !== undefined && drawerTask === undefined && <AgentDrawer id={peek} />}
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
