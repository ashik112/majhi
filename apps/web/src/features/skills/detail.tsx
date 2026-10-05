import {
  type ConnectionView,
  type ConnectStatus,
  GLOBAL_CONNECTIONS,
  type OrgView,
  type Skill,
  type SkillPreview,
} from "@majhi/shared";
import { RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { SectionLabel } from "@/components/ui/section-label";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { scopeAudience, scopeName, WorkspaceMark } from "@/features/connections/scope-picker";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useSkillsCommand } from "@/lib/skills-queries";
import { groupAgents, type Item } from "./catalog";
import { type AgentChoice, ErrorLine, NameList, SourceLink } from "./parts";

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 border-b border-line py-3.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <SectionLabel>{title}</SectionLabel>
        {aside && <span className="ml-auto text-xs text-fg-faint">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function groupName(scope: string, orgs: readonly OrgView[]): string {
  return scope === "root" ? "Root agents" : scopeName(scope, orgs);
}

/** One switch per agent, workspace by workspace. */
function AgentGroups({
  agents,
  on,
  pending,
  orgs,
  noun,
  onToggle,
}: {
  agents: readonly AgentChoice[];
  on: readonly string[];
  pending: ReadonlySet<string>;
  orgs: readonly OrgView[];
  noun: string;
  onToggle: (agent: string, next: boolean) => void;
}) {
  if (agents.length === 0) return <p className="text-sm text-fg-faint">No agent can use this yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      {groupAgents(agents).map((group) => (
        <div key={group.scope} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 pb-1 text-xs text-fg-soft">
            {group.scope === "root" ? null : <WorkspaceMark org={group.scope} orgs={orgs} size="sm" />}
            <span className="font-medium">{groupName(group.scope, orgs)}</span>
            <span className="tnum font-mono text-fg-faint">
              {group.agents.filter((a) => on.includes(a.id)).length} of {group.agents.length}
            </span>
          </div>
          <ul aria-label={`Agents of ${groupName(group.scope, orgs)} using this ${noun}`}>
            {group.agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2.5">
                <AgentAvatar id={agent.id} size={18} decorative />
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-soft">@{agent.id}</span>
                <Switch
                  label={`@${agent.id}`}
                  hideLabel
                  checked={on.includes(agent.id)}
                  disabled={pending.has(agent.id)}
                  onChange={(next) => onToggle(agent.id, next)}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function useTogglePending() {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const run = (agent: string, start: (settle: () => void) => void) => {
    setPending((prev) => new Set(prev).add(agent));
    start(() =>
      setPending((prev) => {
        const copy = new Set(prev);
        copy.delete(agent);
        return copy;
      }),
    );
  };
  return { pending, run };
}

export function SkillDetail({
  skill,
  item,
  agents,
  orgs,
  onClose,
  onUpdatePreview,
  onUpdating,
}: {
  skill: Skill;
  item: Item;
  agents: readonly AgentChoice[];
  orgs: readonly OrgView[];
  onClose: () => void;
  onUpdatePreview: (p: SkillPreview) => void;
  onUpdating: (name: string, state: { updating: boolean; failed?: string }) => void;
}) {
  const enable = useSkillsCommand("skills.enable");
  const disable = useSkillsCommand("skills.disable");
  const enableAll = useSkillsCommand("skills.enableAll");
  const update = useSkillsCommand("skills.update");
  const remove = useSkillsCommand("skills.remove");
  const toast = useToast();
  const { pending, run } = useTogglePending();
  const [removing, setRemoving] = useState(false);

  const toggle = (agent: string, next: boolean) =>
    run(agent, (settle) =>
      (next ? enable : disable).mutate(
        { name: skill.name, agent },
        {
          onError: (e) =>
            toast(`Could not change ${skill.name} for @${agent}`, {
              detail: describeError(e),
              tone: "error",
            }),
          onSettled: settle,
        },
      ),
    );
  const check = () => {
    onUpdating(skill.name, { updating: true });
    update.mutate(
      { name: skill.name },
      {
        onSuccess: (r) => {
          onUpdating(skill.name, { updating: false });
          if (r.status === "preview") onUpdatePreview(r);
          else toast(`${skill.name} is already the newest copy.`);
        },
        onError: (e) => onUpdating(skill.name, { updating: false, failed: describeError(e) }),
      },
    );
  };
  const version = skill.commit ? skill.commit.slice(0, 7) : skill.hash.slice(0, 7);
  const allOn = agents.length > 0 && skill.agents.length === agents.length;

  return (
    <Sheet
      title={skill.name}
      subtitle={`Skill, ${scopeName(GLOBAL_CONNECTIONS, orgs)}`}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={check} disabled={update.isPending}>
            <RefreshCw aria-hidden="true" />
            {update.isPending ? "Checking" : "Update"}
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRemoving(true)}>
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-2 pb-3 text-sm">
        <Lamp state={item.lamp} size={7} />
        <span className={item.bad ? "text-lamp-needs" : "text-fg-muted"}>{item.status}</span>
        {!allOn && agents.length > 0 && (
          <Button
            size="sm"
            variant="primary"
            className="ml-auto"
            disabled={enableAll.isPending}
            onClick={() =>
              enableAll.mutate(
                { name: skill.name },
                {
                  onError: (e) =>
                    toast(`Could not enable ${skill.name}`, { detail: describeError(e), tone: "error" }),
                },
              )
            }
          >
            Enable for all agents
          </Button>
        )}
      </div>
      {item.bad && (
        <ErrorLine>
          {item.status}. Check that the source is reachable and try again; the installed copy keeps working.
        </ErrorLine>
      )}
      <Section title="About">
        <p className="text-base text-fg-soft text-pretty">{skill.description}</p>
      </Section>
      <Section title="Source" aside={`Version ${version}`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-faint">Installed from</dt>
          <dd className="min-w-0">
            <SourceLink source={skill.source} />
          </dd>
          <dt className="text-fg-faint">Kind</dt>
          <dd className="text-fg-soft">{skill.sourceType}</dd>
          {skill.ref && (
            <>
              <dt className="text-fg-faint">Ref</dt>
              <dd className="font-mono text-fg-soft">{skill.ref}</dd>
            </>
          )}
          <dt className="text-fg-faint">Installed</dt>
          <dd className="text-fg-soft">{new Date(skill.installedAt).toLocaleDateString()}</dd>
        </dl>
      </Section>
      <Section title="Files" aside={plural(skill.files.length, "file")}>
        <NameList label={`Files of ${skill.name}`} names={skill.files.map((f) => f.path)} />
      </Section>
      <Section
        title="Agents"
        aside={`On for ${skill.agents.length} of ${agents.length}${skill.defaultOn ? ", new agents get it" : ""}`}
      >
        <AgentGroups
          agents={agents}
          on={skill.agents}
          pending={pending}
          orgs={orgs}
          noun="skill"
          onToggle={toggle}
        />
      </Section>
      {removing && (
        <ConfirmDialog
          title={`Remove ${skill.name}?`}
          body={
            skill.agents.length === 0
              ? "No agent uses it. The files are deleted from ~/.majhi/skills."
              : `It is deleted from ~/.majhi/skills, and ${plural(skill.agents.length, "agent")} lose it.`
          }
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => {
            remove.reset();
            setRemoving(false);
          }}
          onConfirm={() => remove.mutate({ name: skill.name }, { onSuccess: onClose })}
        />
      )}
    </Sheet>
  );
}

export function McpDetail({
  server,
  status,
  item,
  agents,
  orgs,
  onClose,
}: {
  server: ConnectionView;
  status: ConnectStatus | undefined;
  item: Item;
  agents: readonly AgentChoice[];
  orgs: readonly OrgView[];
  onClose: () => void;
}) {
  const enable = useSkillsCommand("mcp.enable");
  const disable = useSkillsCommand("mcp.disable");
  const test = useConnectionCommand("connections.test");
  const remove = useConnectionCommand("connections.remove");
  const toast = useToast();
  const { pending, run } = useTogglePending();
  const [removing, setRemoving] = useState(false);
  const reachable = agents.filter(
    (a) => server.org === GLOBAL_CONNECTIONS || a.scope === server.org || a.scope === "root",
  );
  const tools = server.lastTest?.tools ?? [];

  const toggle = (agent: string, next: boolean) =>
    run(agent, (settle) =>
      (next ? enable : disable).mutate(
        { connection: server.id, agent },
        {
          onError: (e) =>
            toast(`Could not change ${server.name} for @${agent}`, {
              detail: describeError(e),
              tone: "error",
            }),
          onSettled: settle,
        },
      ),
    );
  const problems = [
    ...server.problems,
    ...(status !== undefined && status.state !== "connected" ? [status.reason] : []),
    ...(server.lastTest?.ok === false ? [server.lastTest.detail] : []),
  ];

  return (
    <Sheet
      title={server.name}
      subtitle={`MCP server, ${scopeName(server.org, orgs)}`}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={test.isPending} onClick={() => test.mutate({ id: server.id })}>
            {test.isPending ? "Testing" : "Test"}
          </Button>
          <PageLink
            page="connections"
            search={{ connection: server.id }}
            className="text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Open connection settings
          </PageLink>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRemoving(true)}>
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-2 pb-3 text-sm">
        <Lamp state={item.lamp} size={7} />
        <span className={item.bad ? "text-lamp-needs" : "text-fg-muted"}>{item.status}</span>
        {status !== undefined && status.state !== "connected" && (
          <Button size="sm" variant="primary" className="ml-auto" asChild>
            <PageLink page="connections" search={{ connection: server.id }}>
              Sign in
            </PageLink>
          </Button>
        )}
      </div>
      {problems.length > 0 && (
        <ErrorLine>
          {problems.map((p) => (
            <span key={p} className="block">
              {p}
            </span>
          ))}
        </ErrorLine>
      )}
      {server.lastTest?.ok === false && server.problems.length === 0 && (
        <p className="pt-2 text-sm text-fg-muted text-pretty">
          Fix: check the address or command in connection settings and that the server is reachable, then
          Test again.
        </p>
      )}
      <Section title="About">
        <p className="text-base text-fg-soft text-pretty">{item.description}</p>
        <p className="text-sm text-fg-faint">{scopeAudience(server.org, orgs)}</p>
      </Section>
      <Section title="Tools" aside={tools.length > 0 ? plural(tools.length, "tool") : undefined}>
        {tools.length > 0 ? (
          <NameList label={`Tools of ${server.name}`} names={tools} />
        ) : (
          <p className="text-sm text-fg-faint">Run a test to list the tools this server offers.</p>
        )}
        {server.lastTest?.warnings.map((w) => (
          <p key={w} className="text-sm text-amber text-pretty">
            {w}
          </p>
        ))}
      </Section>
      <Section title="Agents" aside={`On for ${server.agents.length} of ${reachable.length}`}>
        <AgentGroups
          agents={reachable}
          on={server.agents}
          pending={pending}
          orgs={orgs}
          noun="server"
          onToggle={toggle}
        />
      </Section>
      {removing && (
        <ConfirmDialog
          title={`Remove ${server.name}?`}
          body="Its files and the secrets nothing else uses are deleted, and agents lose it."
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error ? describeError(remove.error) : undefined}
          onCancel={() => {
            remove.reset();
            setRemoving(false);
          }}
          onConfirm={() => remove.mutate({ id: server.id }, { onSuccess: onClose })}
        />
      )}
    </Sheet>
  );
}
