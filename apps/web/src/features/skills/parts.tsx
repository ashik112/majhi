import type { AgentEntry } from "@majhi/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { SectionLabel } from "@/components/ui/section-label";
import { Switch } from "@/components/ui/switch";

export interface AgentChoice {
  id: string;
  /** `root` or an org id. */
  scope: string;
}

/** The agents with a readable file: the ones a toggle can act on. */
export function agentChoices(entries: readonly AgentEntry[] | undefined): AgentChoice[] {
  return (entries ?? [])
    .flatMap((e) =>
      e.status === "ok" ? [{ id: e.agent.frontmatter.id, scope: e.agent.frontmatter.scope }] : [],
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One of the three parts of a tab: Install, Browse, Installed. */
export function Block({
  title,
  note,
  actions,
  children,
}: {
  title: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel aria-label={title} className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SectionLabel>{title}</SectionLabel>
          {note && <p className="text-sm text-fg-muted text-pretty">{note}</p>}
        </div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </Panel>
  );
}

/** The server's refusal or a failed read, in red under the control that caused it. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red text-pretty"
    >
      {children}
    </p>
  );
}

/** One switch per agent: on when the agent uses the item. */
export function AgentToggles({
  agents,
  on,
  pending,
  noun,
  onToggle,
}: {
  agents: readonly AgentChoice[];
  on: readonly string[];
  /** Agent ids whose change is on its way. */
  pending: ReadonlySet<string>;
  noun: string;
  onToggle: (agent: string, next: boolean) => void;
}) {
  if (agents.length === 0) {
    return <p className="text-sm text-fg-faint">No agent can use this yet.</p>;
  }
  return (
    <ul aria-label={`Agents using this ${noun}`} className="flex flex-wrap gap-x-5 gap-y-0.5">
      {agents.map((agent) => (
        <li key={agent.id}>
          <Switch
            label={`@${agent.id}`}
            checked={on.includes(agent.id)}
            disabled={pending.has(agent.id)}
            onChange={(next) => onToggle(agent.id, next)}
          />
        </li>
      ))}
    </ul>
  );
}

/** Tool or file names in a wrapping row of small mono badges. */
export function NameList({ names, label }: { names: readonly string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {names.map((name) => (
        <li key={name}>
          <Badge mono>{name}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** "acme/skills" as text, and as a link when it is a GitHub shorthand. */
export function SourceLink({ source }: { source: string }) {
  const href = /^[\w.-]+\/[\w.-]+$/.test(source)
    ? `https://github.com/${source}`
    : /^https?:\/\//.test(source)
      ? source
      : undefined;
  if (href === undefined) return <span className="font-mono break-all">{source}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono break-all text-fg underline-offset-2 hover:underline"
    >
      {source}
    </a>
  );
}
