import { PAGE_PATH, SETTINGS_GROUPS, settingsEntryPath } from "@majhi/shared";
import { Link, useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/** True inside the Settings frame: a panel then shows without its own list. */
export const InSettingsFrame = createContext(false);
export const useInSettingsFrame = () => useContext(InSettingsFrame);

export function isSettingsPath(pathname: string): boolean {
  return pathname === PAGE_PATH.setup || pathname.startsWith(`${PAGE_PATH.setup}/`);
}

const ROW =
  "flex h-8 min-w-0 items-center rounded-md px-2.5 text-[14px] transition-colors duration-150 hover:bg-raised hover:text-fg";

/** The Settings list (14 entries in 4 groups, from SETTINGS_GROUPS in @majhi/shared) and the entry beside it. */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3">
      <nav
        aria-label="Settings"
        className={cn(
          "flex w-[208px] shrink-0 flex-col gap-5 min-[1280px]:w-[228px] overflow-y-auto overscroll-contain rounded-2xl px-2 py-3 scroll-fade",
          GLASS,
        )}
      >
        <h1 className="px-2.5 text-md font-semibold text-fg">Settings</h1>
        {SETTINGS_GROUPS.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-px">
            <h2 className="px-2.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase">
              {group.label}
            </h2>
            {group.entries.map((entry) => {
              const active = pathname === settingsEntryPath(entry);
              return (
                <Link
                  key={entry.id}
                  to={PAGE_PATH[entry.page]}
                  search={{}}
                  aria-current={active ? "page" : undefined}
                  className={cn(ROW, active ? cn(ROW_SELECTED, "font-medium") : "text-fg-muted")}
                >
                  <span className="truncate">{entry.label}</span>
                </Link>
              );
            })}
          </section>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-2xl scroll-fade-end">
        <InSettingsFrame.Provider value={true}>{children}</InSettingsFrame.Provider>
      </div>
    </div>
  );
}
