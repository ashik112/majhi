import type { AgentEntry } from "@majhi/shared";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useFixCheck } from "@/lib/ops-queries";

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
          <h2 className="text-md font-semibold text-fg">{title}</h2>
          {note && <p className="text-sm text-fg-muted text-pretty">{note}</p>}
        </div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </Panel>
  );
}

/** The server's refusal or a failed read, in red under the control that caused it. */
/** The step majhi does itself when the agents' image lacks a tool: the same Rebuild majhi as the Needs you card. */
export function RebuildMajhi() {
  const fix = useFixCheck();
  const toast = useToast();
  return (
    <Button
      size="sm"
      disabled={fix.isPending}
      onClick={() =>
        fix.mutate("runner", {
          onSuccess: (out) =>
            toast(out.ok ? "Rebuilding majhi" : "Could not rebuild", {
              detail: out.detail,
              tone: out.ok ? "success" : "error",
            }),
          onError: (error) => toast("Could not rebuild", { detail: describeError(error), tone: "error" }),
        })
      }
    >
      Rebuild majhi
    </Button>
  );
}

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

/**
 * One switch per agent, behind a button that says how many use the item, so a long list of rows
 * stays short until the owner opens one.
 */
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
  const [open, setOpen] = useState(false);
  if (agents.length === 0) {
    return <p className="text-sm text-fg-faint">No agent can use this yet.</p>;
  }
  const count = agents.filter((a) => on.includes(a.id)).length;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {count === 0 ? "No agent uses it" : `${count} of ${agents.length} agents use it`}
      </button>
      {open && (
        <ul aria-label={`Agents using this ${noun}`} className="flex flex-wrap gap-x-5 gap-y-0.5 pl-5">
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
      )}
    </div>
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
