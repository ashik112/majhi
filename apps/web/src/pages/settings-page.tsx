import {
  PAGE_PATH,
  type PageName,
  SETTINGS_ENTRIES,
  type SettingsPart,
  settingsEntryPath,
} from "@majhi/shared";
import { Navigate, useRouterState } from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense } from "react";
import { DetailPane } from "@/components/ui/list-detail";
import { GitAccounts } from "@/features/orgs/git-accounts";
import { SetupSectionPanel } from "@/features/setup/section-panel";
import { useOrgs } from "@/lib/studio-queries";

/** The pages that are a part of a Settings entry, read when the entry opens. */
const PAGE_PART: Partial<Record<PageName, ComponentType>> = {
  orgs: lazy(() => import("@/pages/orgs-page").then((m) => ({ default: m.OrgsPage }))),
  projects: lazy(() => import("@/pages/projects-page").then((m) => ({ default: m.ProjectsPage }))),
  accounts: lazy(() => import("@/pages/accounts-page").then((m) => ({ default: m.AccountsPage }))),
  connections: lazy(() => import("@/pages/connections-page").then((m) => ({ default: m.ConnectionsPage }))),
  agents: lazy(() => import("@/pages/agents-page").then((m) => ({ default: m.AgentsPage }))),
  captain: lazy(() => import("@/pages/captain-page").then((m) => ({ default: m.CaptainPage }))),
  skills: lazy(() => import("@/pages/skills-page").then((m) => ({ default: m.SkillsPage }))),
  playbooks: lazy(() => import("@/pages/playbooks-page").then((m) => ({ default: m.PlaybooksPage }))),
  limits: lazy(() => import("@/pages/limits-page").then((m) => ({ default: m.LimitsPage }))),
};

/** Every workspace's git logins, each with the panel the workspace page used to hold. */
function GitLogins() {
  const orgs = useOrgs();
  return (
    <DetailPane label="Git logins">
      {(orgs.data ?? []).map((org) => (
        <GitAccounts key={org.id} org={org} />
      ))}
    </DetailPane>
  );
}

function Part({ part }: { part: SettingsPart }) {
  if (part.kind === "section") return <SetupSectionPanel section={part.section} />;
  if (part.kind === "git") return <GitLogins />;
  const Page = PAGE_PART[part.page];
  return Page === undefined ? null : <Page />;
}

/**
 * One Settings entry. An entry with one panel shows it as the page it was. An entry that holds several
 * shows today's panels one after another, each under its own heading, and the frame scrolls.
 */
export function SettingsPage() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const entry = SETTINGS_ENTRIES.find((e) => settingsEntryPath(e) === path);
  if (entry === undefined) return <Navigate to={PAGE_PATH.setup} replace />;
  const several = entry.parts.length > 1;
  return (
    <Suspense fallback={null}>
      {several ? (
        <div className="flex flex-col gap-3 pb-6">
          {entry.parts.map((part) => (
            <div
              key={`${part.kind}-${part.title}`}
              className={
                part.kind === "page" ? "flex h-[calc(100dvh-132px)] min-h-[560px] flex-col" : "flex flex-col"
              }
            >
              <Part part={part} />
            </div>
          ))}
        </div>
      ) : (
        entry.parts.map((part) => <Part key={`${part.kind}-${part.title}`} part={part} />)
      )}
    </Suspense>
  );
}
