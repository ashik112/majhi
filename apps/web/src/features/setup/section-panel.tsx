import { collapseHome, SECTION_TITLE, type Settings, type SetupSection } from "@majhi/shared";
import { type ReactNode, useState } from "react";
import { AppearanceControls } from "@/components/shell/appearance";
import { Button } from "@/components/ui/button";
import { DetailPane, DetailSection } from "@/components/ui/list-detail";
import { EditRootsDialog } from "@/features/roots/edit-roots-dialog";
import { useMountNow } from "@/features/roots/use-mount-now";
import { WikiSection } from "@/features/wiki/wiki-settings";
import { useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";
import { useConfig, useHostStatus, useRepos } from "@/lib/queries";
import { ApprovalsSection } from "./approvals-panel";
import { BackupsSection } from "./backups-panel";
import { ContainersSection } from "./containers-panel";
import { DecisionsSection } from "./decisions-panel";
import { EditorSection } from "./editor-panel";
import { HistorySection } from "./history-panel";
import { MemorySection } from "./memory-panel";
import { rootsCard, sshCard } from "./model";
import { NotificationsSection } from "./notifications-panel";
import { RulesPanel } from "./rules-panel";
import { SECTION_ABOUT } from "./sections";
import { ContextSection, TurnsSection } from "./settings-panel";
import { RootsSection, SshSection } from "./workspace-sections";

/** Runs `children` with the saved settings, or says why it cannot. */
export function WithSettings({ children }: { children: (data: Settings) => ReactNode }) {
  const settings = useSettings();
  if (settings.isPending) return <p className="pt-5 text-sm text-fg-faint">Loading</p>;
  if (settings.isError) return <p className="pt-5 text-sm text-red">{describeError(settings.error)}</p>;
  return children(settings.data);
}

function RootsPanel() {
  const config = useConfig();
  const repos = useRepos(true);
  const [editing, setEditing] = useState(false);
  const state = config.data;
  const home = state?.home ?? "";
  const mount = useMountNow(home);
  const configured = state?.status === "loaded" ? state.config.workspaces : [];
  const roots = rootsCard(
    repos.data?.roots,
    configured.map((r) => collapseHome(r, home)),
  );
  const needsMount = repos.data?.roots.some((r) => !r.mounted) ?? false;
  return (
    <>
      <RootsSection
        roots={repos.data?.roots}
        configured={configured}
        home={home}
        state={roots}
        actions={
          <>
            {needsMount && mount.canMount && (
              <Button size="sm" variant="primary" onClick={mount.mountNow} disabled={mount.pending}>
                {mount.pending ? "Mounting" : "Mount now"}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit folders
            </Button>
          </>
        }
      />
      {editing && <EditRootsDialog onClose={() => setEditing(false)} />}
      {mount.modal}
    </>
  );
}

function BackupsPanel() {
  return <BackupsSection home={useConfig().data?.home ?? ""} />;
}

function SshPanel() {
  const host = useHostStatus();
  return <SshSection host={host.data} state={sshCard(host.data)} />;
}

/** The body of one section, without its frame. */
export function SectionBody({ section }: { section: SetupSection }): ReactNode {
  switch (section) {
    case "roots":
      return <RootsPanel />;
    case "ssh":
      return <SshPanel />;
    case "decisions":
      return <DecisionsSection />;
    case "memory":
      return <WithSettings>{(data) => <MemorySection saved={data.memory} />}</WithSettings>;
    case "wiki":
      return <WikiSection />;
    case "context":
      return <WithSettings>{(data) => <ContextSection settings={data} />}</WithSettings>;
    case "turns":
      return <WithSettings>{(data) => <TurnsSection settings={data} />}</WithSettings>;
    case "approvals":
      return (
        <>
          <WithSettings>{(data) => <ApprovalsSection settings={data} />}</WithSettings>
          <RulesPanel />
        </>
      );
    case "notifications":
      return <WithSettings>{(data) => <NotificationsSection saved={data.notifications} />}</WithSettings>;
    case "editor":
      return <WithSettings>{(data) => <EditorSection saved={data.editor} />}</WithSettings>;
    case "containers":
      return <ContainersSection />;
    case "appearance":
      return (
        <DetailSection title="Theme, mode and density" className="border-t-0">
          <AppearanceControls className="max-w-[320px]" hint={false} />
        </DetailSection>
      );
    case "backups":
      return <BackupsPanel />;
    case "history":
      return <HistorySection />;
  }
}

/** One section of Hub setup as a glass pane with its title and what it is for. */
export function SetupSectionPanel({ section }: { section: SetupSection }) {
  return (
    <DetailPane
      label={SECTION_TITLE[section]}
      head={
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-md leading-6 font-semibold">{SECTION_TITLE[section]}</h2>
          <p className="truncate text-sm text-fg-muted">{SECTION_ABOUT[section]}</p>
        </div>
      }
    >
      <SectionBody section={section} />
    </DetailPane>
  );
}
