import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  BookMarked,
  Brain,
  Code,
  Container,
  Cpu,
  DatabaseBackup,
  FlaskConical,
  FolderGit2,
  FolderTree,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Palette,
  Plug,
  Repeat,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { SECTION_TITLE, type SetupSection } from "@/features/setup/sections";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { PAGE_PATH, type PageName } from "@/lib/pages";

/** True inside the Settings frame: Hub setup then shows its section without its own list. */
export const InSettingsFrame = createContext(false);
export const useInSettingsFrame = () => useContext(InSettingsFrame);

type Item = (
  | { kind: "page"; page: PageName; label: string }
  | { kind: "section"; section: SetupSection; label?: string }
) & { icon: LucideIcon };

/**
 * The one Settings list: groups of rows with an icon each, the picked one on the right. Pages keep
 * their own address (/connections, /limits); Hub setup's sections are `/setup?section=`.
 */
const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "General",
    items: [
      { kind: "section", section: "overview", icon: LayoutDashboard },
      { kind: "section", section: "appearance", icon: Palette },
      { kind: "section", section: "notifications", icon: Bell },
      { kind: "section", section: "editor", icon: Code },
    ],
  },
  {
    label: "Access",
    items: [
      { kind: "page", page: "connections", label: "Connections", icon: Plug },
      { kind: "page", page: "projects", label: "Projects and links", icon: FolderGit2 },
      { kind: "section", section: "roots", icon: FolderTree },
      { kind: "section", section: "ssh", icon: KeyRound },
    ],
  },
  {
    label: "Agents",
    items: [
      { kind: "page", page: "skills", label: "Skills", icon: Sparkles },
      { kind: "page", page: "memory", label: "Memory", icon: Brain },
      { kind: "section", section: "memory", label: "Memory rules", icon: BookMarked },
      { kind: "section", section: "teams", icon: Users },
      { kind: "section", section: "turns", icon: Repeat },
      { kind: "section", section: "context", icon: Gauge },
    ],
  },
  {
    label: "Control",
    items: [
      { kind: "page", page: "limits", label: "Limits", icon: Wallet },
      { kind: "section", section: "approvals", icon: ShieldCheck },
      { kind: "section", section: "decisions", icon: Cpu },
    ],
  },
  {
    label: "System",
    items: [
      { kind: "section", section: "containers", icon: Container },
      { kind: "section", section: "e2e", icon: FlaskConical },
      { kind: "section", section: "backups", icon: DatabaseBackup },
      { kind: "section", section: "history", icon: History },
      { kind: "page", page: "audit", label: "Audit log", icon: ScrollText },
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
  "flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-[14px] transition-colors duration-150 hover:bg-raised hover:text-fg";

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
          "flex w-[208px] shrink-0 flex-col gap-5 min-[1280px]:w-[228px] overflow-y-auto overscroll-contain rounded-2xl px-2 py-3 scroll-fade",
          GLASS,
        )}
      >
        <h1 className="px-2.5 text-md font-semibold text-fg">Settings</h1>
        {GROUPS.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-px">
            <h2 className="px-2.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase">
              {group.label}
            </h2>
            {group.items.map((item) => {
              const label = item.kind === "page" ? item.label : (item.label ?? SECTION_TITLE[item.section]);
              const active = current(item);
              const className = cn(ROW, active ? cn(ROW_SELECTED, "font-medium") : "text-fg-muted");
              const Icon = item.icon;
              const body = (
                <>
                  <Icon
                    aria-hidden="true"
                    className={cn("size-4 shrink-0", active ? "text-fg" : "text-fg-faint")}
                  />
                  <span className="truncate">{label}</span>
                </>
              );
              return item.kind === "page" ? (
                <Link
                  key={item.page}
                  to={PAGE_PATH[item.page]}
                  search={{}}
                  aria-current={active ? "page" : undefined}
                  className={className}
                >
                  {body}
                </Link>
              ) : (
                <Link
                  key={item.section}
                  to={PAGE_PATH.setup}
                  search={item.section === "overview" ? {} : { section: item.section }}
                  aria-current={active ? "page" : undefined}
                  className={className}
                >
                  {body}
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
