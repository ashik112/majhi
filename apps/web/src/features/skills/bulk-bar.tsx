import type { OrgView, SkillTarget } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { WorkspaceMark } from "@/features/connections/scope-picker";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useSkillsCommand } from "@/lib/skills-queries";
import { groupAgents } from "./catalog";
import { groupName } from "./group-name";
import type { AgentChoice } from "./parts";

interface Change {
  target: SkillTarget;
  on: boolean;
  /** Who it reaches, in words: "every agent" or "Acme". */
  who: string;
}

/**
 * Bulk on and off for the skills ticked on the page, or for every skill shown when none is ticked:
 * for every agent, or for the agents of one workspace (agents made later in it follow). One command
 * per click, so the server writes one change however many skills there are.
 */
export function BulkBar({
  names,
  ticked,
  filtered,
  agents,
  orgs,
  onClear,
}: {
  names: readonly string[];
  ticked: number;
  filtered: boolean;
  agents: readonly AgentChoice[];
  orgs: readonly OrgView[];
  onClear: () => void;
}) {
  const command = useSkillsCommand("skills.setMany");
  const toast = useToast();
  const [asking, setAsking] = useState<Change>();
  const groups = groupAgents(agents);
  const what = ticked > 0 ? `${ticked} selected` : `${names.length} ${filtered ? "matching" : "shown"}`;

  const apply = (change: Change) => {
    command.mutate(
      { skills: [...names], target: change.target, on: change.on },
      {
        onSuccess: () => {
          setAsking(undefined);
          toast(`${plural(names.length, "skill")} turned ${change.on ? "on" : "off"} for ${change.who}`);
        },
        onError: (e) => toast("Could not change the skills", { detail: describeError(e), tone: "error" }),
      },
    );
  };
  const ask = (change: Change) => {
    // Turning several off reaches many agents at once: say so first.
    if (!change.on && names.length > 1) setAsking(change);
    else apply(change);
  };

  const chip = (key: string, label: string, target: SkillTarget, who: string, mark?: string) => (
    <li
      key={key}
      className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-field py-0.5 pr-0.5 pl-2 text-sm"
    >
      {mark !== undefined && <WorkspaceMark org={mark} orgs={orgs} size="sm" />}
      <span className="max-w-[140px] truncate text-fg-soft" title={who}>
        {label}
      </span>
      <Button
        size="sm"
        disabled={command.isPending || names.length === 0}
        aria-label={`Enable all skills for ${who}`}
        onClick={() => ask({ target, on: true, who })}
      >
        On
      </Button>
      <Button
        size="sm"
        disabled={command.isPending || names.length === 0}
        aria-label={`Disable all for ${who}`}
        onClick={() => ask({ target, on: false, who })}
      >
        Off
      </Button>
    </li>
  );

  return (
    <section
      aria-label="Turn skills on or off in bulk"
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm"
    >
      <span className="tnum font-mono text-fg-muted">{what}</span>
      {ticked > 0 && (
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      )}
      <ul aria-label="Apply to" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
        {chip("all", "Every agent", { kind: "all" }, "every agent")}
        {groups.map((g) => {
          const label = groupName(g.scope, orgs);
          return chip(
            `ws:${g.scope}`,
            label,
            { kind: "workspace", org: g.scope },
            label,
            g.scope === "root" ? undefined : g.scope,
          );
        })}
      </ul>
      {asking && (
        <ConfirmDialog
          title={`Turn ${plural(names.length, "skill")} off for ${asking.who}?`}
          body="Their next turn runs without them. You can turn them back on the same way."
          confirmLabel="Turn off"
          busy={command.isPending}
          error={command.error ? describeError(command.error) : undefined}
          onCancel={() => {
            command.reset();
            setAsking(undefined);
          }}
          onConfirm={() => apply(asking)}
        />
      )}
    </section>
  );
}
