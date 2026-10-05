import {
  PAGE_PATH,
  SETTINGS_GROUPS,
  type SettingsItem,
  type SettingsPage,
  type SetupSection,
  settingsItemLabel,
} from "@majhi/shared";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  BookMarked,
  Brain,
  Code,
  Container,
  Cpu,
  DatabaseBackup,
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
  Users,
  Wallet,
} from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";

/** True inside the Settings frame: Hub setup then shows its section without its own list. */
export const InSettingsFrame = createContext(false);
export const useInSettingsFrame = () => useContext(InSettingsFrame);

/** Each Settings row's icon. The rows, their order and their names are SETTINGS_GROUPS in @majhi/shared. */
const SECTION_ICON: Record<SetupSection, LucideIcon> = {
  overview: LayoutDashboard,
  appearance: Palette,
  notifications: Bell,
  editor: Code,
  roots: FolderTree,
  ssh: KeyRound,
  memory: BookMarked,
  teams: Users,
  turns: Repeat,
  context: Gauge,
  approvals: ShieldCheck,
  decisions: Cpu,
  containers: Container,
  backups: DatabaseBackup,
  history: History,
};
const PAGE_ICON: Record<SettingsPage, LucideIcon> = {
  connections: Plug,
  projects: FolderGit2,
  memory: Brain,
  limits: Wallet,
  audit: ScrollText,
};
const iconOf = (item: SettingsItem): LucideIcon =>
  item.kind === "page" ? PAGE_ICON[item.page] : SECTION_ICON[item.section];

/** The pages that open inside the Settings frame. */
export const SETTINGS_PATHS: ReadonlySet<string> = new Set([
  ...SETTINGS_GROUPS.flatMap((g) => g.items.flatMap((i) => (i.kind === "page" ? [PAGE_PATH[i.page]] : []))),
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
  const current = (item: SettingsItem): boolean =>
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
        {SETTINGS_GROUPS.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-px">
            <h2 className="px-2.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase">
              {group.label}
            </h2>
            {group.items.map((item) => {
              const label = settingsItemLabel(item);
              const active = current(item);
              const className = cn(ROW, active ? cn(ROW_SELECTED, "font-medium") : "text-fg-muted");
              const Icon = iconOf(item);
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
