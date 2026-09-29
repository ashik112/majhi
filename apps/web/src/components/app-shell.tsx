import { Outlet, useRouterState } from "@tanstack/react-router";
import * as m from "motion/react-m";
import { useMemo } from "react";
import { InShellContext } from "@/components/centered-page";
import { AttentionBanner } from "@/components/shell/banner";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import { Sidebar } from "@/components/shell/sidebar";
import { AppGate } from "@/features/home/app-gate";
import { NewTaskProvider, useNewTask } from "@/features/new-task/new-task-context";
import { deriveBanner } from "@/features/shell/model";
import { useShortcuts } from "@/features/shell/use-shortcuts";
import { useAgentIndex } from "@/lib/agent-index";
import { usePendingPermission } from "@/lib/attention";
import { useOrgFilter } from "@/lib/org-filter";
import { useAccounts } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { useServerEvents } from "@/lib/use-server-events";

export function AppShell() {
  useServerEvents();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-amber px-3 py-2 font-semibold text-amber-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AppGate>
        <NewTaskProvider>
          <Frame />
        </NewTaskProvider>
      </AppGate>
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
  const now = useNow(60_000);
  const banner = useMemo(
    () => deriveBanner({ tasks: tasks ?? [], agents, accounts: accounts ?? [], permission, now }),
    [tasks, agents, accounts, permission, now],
  );
  // The page fades in when the section changes (board, task, a page), not on every task switch.
  const section = useRouterState({
    select: (s) => (s.location.pathname.startsWith("/t/") ? "/" : s.location.pathname),
  });

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main id="main" tabIndex={-1} className="flex h-full min-w-0 flex-1 flex-col outline-none">
        <AttentionBanner banner={banner} org={org} />
        <m.div
          key={section}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <InShellContext.Provider value={true}>
            <Outlet />
          </InShellContext.Provider>
        </m.div>
      </main>
      {helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
