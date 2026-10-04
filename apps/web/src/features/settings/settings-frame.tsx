import { Link, useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import { SECTION_TITLE, type SetupSection } from "@/features/setup/sections";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { PAGE_PATH, type PageName } from "@/lib/pages";

/** True inside the Settings frame: Hub setup then shows its section without its own list. */
export const InSettingsFrame = createContext(false);
export const useInSettingsFrame = () => useContext(InSettingsFrame);

type Item =
  | { kind: "page"; page: PageName; label: string }
  | { kind: "section"; section: SetupSection; label?: string };

/**
 * The one Settings list, the way settings pages read elsewhere: groups of plain rows on the left, the
 * picked one on the right. Pages keep their own address (/connections, /limits); Hub setup's sections
 * are `/setup?section=`.
 */
const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "General",
    items: [
      { kind: "section", section: "overview" },
      { kind: "section", section: "roots" },
      { kind: "section", section: "ssh" },
      { kind: "section", section: "notifications" },
      { kind: "section", section: "appearance" },
      { kind: "section", section: "editor" },
    ],
  },
  {
    label: "Work",
    items: [
      { kind: "page", page: "connections", label: "Connections" },
      { kind: "page", page: "projects", label: "Projects and links" },
      { kind: "page", page: "skills", label: "Skills & MCP" },
      { kind: "page", page: "memory", label: "Memory" },
    ],
  },
  {
    label: "Agents and captain",
    items: [
      { kind: "page", page: "limits", label: "Limits" },
      { kind: "section", section: "approvals" },
      { kind: "section", section: "decisions" },
      { kind: "section", section: "memory", label: "Memory rules" },
      { kind: "section", section: "context" },
      { kind: "section", section: "turns" },
      { kind: "section", section: "teams" },
    ],
  },
  {
    label: "System",
    items: [
      { kind: "section", section: "containers" },
      { kind: "section", section: "e2e" },
      { kind: "section", section: "backups" },
      { kind: "section", section: "history" },
      { kind: "page", page: "audit", label: "Audit log" },
    ],
  },
];

/** The pages that open inside the Settings frame. */
export const SETTINGS_PATHS: ReadonlySet<string> = new Set([
  ...GROUPS.flatMap((g) => g.items.flatMap((i) => (i.kind === "page" ? [PAGE_PATH[i.page]] : []))),
  PAGE_PATH.setup,
]);

export function isSettingsPath(pathname: string): boolean {
  return [...SETTINGS_PATHS].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

const ROW =
  "flex h-8 min-w-0 items-center rounded-md px-2.5 text-body transition-colors duration-150 hover:bg-raised hover:text-fg";

export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as { section?: string } });
  const onSetup = pathname === PAGE_PATH.setup;
  const current = (item: Item): boolean =>
    item.kind === "page"
      ? pathname.startsWith(PAGE_PATH[item.page])
      : onSetup && (search.section ?? "overview") === item.section;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3">
      <nav
        aria-label="Settings"
        className={cn(
          "flex w-[184px] shrink-0 flex-col gap-4 min-[1280px]:w-[220px] overflow-y-auto overscroll-contain rounded-2xl px-2 py-3 scroll-fade",
          GLASS,
        )}
      >
        <h1 className="px-2.5 text-md font-semibold text-fg">Settings</h1>
        {GROUPS.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-px">
            <h2 className="px-2.5 pb-1 text-xs font-medium tracking-wide text-fg-faint uppercase">
              {group.label}
            </h2>
            {group.items.map((item) => {
              const label = item.kind === "page" ? item.label : (item.label ?? SECTION_TITLE[item.section]);
              const active = current(item);
              const className = cn(ROW, active ? "bg-raised font-medium text-fg" : "text-fg-muted");
              return item.kind === "page" ? (
                <Link
                  key={item.page}
                  to={PAGE_PATH[item.page]}
                  search={{}}
                  aria-current={active ? "page" : undefined}
                  className={className}
                >
                  <span className="truncate">{label}</span>
                </Link>
              ) : (
                <Link
                  key={item.section}
                  to={PAGE_PATH.setup}
                  search={item.section === "overview" ? {} : { section: item.section }}
                  aria-current={active ? "page" : undefined}
                  className={className}
                >
                  <span className="truncate">{label}</span>
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
