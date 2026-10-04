import { type AgentFrontmatter, GLOBAL_CONNECTIONS, type OrgView } from "@majhi/shared";
import { DetailSection } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { scopeName } from "@/features/connections/scope-picker";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";

/**
 * The connections the agent gets: every one of its workspace and every Global one. A root agent gets
 * those of the task's workspace. Each switch saves at once and is the same switch as on the
 * connection's own page.
 */
export function AgentConnections({
  agent,
  orgs,
}: {
  agent: Pick<AgentFrontmatter, "id" | "scope">;
  orgs: readonly OrgView[];
}) {
  const connections = useConnections();
  const update = useConnectionCommand("connections.update");
  const toast = useToast();
  const root = agent.scope === "root";
  const reach = (connections.data ?? []).filter(
    (c) => root || c.org === agent.scope || c.org === GLOBAL_CONNECTIONS,
  );
  const toggle = (id: string, off: readonly string[], on: boolean) =>
    update.mutate(
      { id, agentsOff: on ? off.filter((a) => a !== agent.id) : [...off, agent.id] },
      {
        onError: (error) => toast(`Could not change ${id}`, { detail: describeError(error), tone: "error" }),
      },
    );
  return (
    <DetailSection
      title="Connections"
      note={
        root
          ? "In a task it gets the connections of the task's workspace, and can attach others. Each attach shows in the room."
          : `It gets every connection of ${scopeName(agent.scope, orgs)} and every Global one. Switch one off to keep it away.`
      }
    >
      {connections.isError ? (
        <p role="alert" className="text-sm text-red">
          Could not load connections: {describeError(connections.error)}
        </p>
      ) : reach.length === 0 && connections.data !== undefined ? (
        <p className="text-sm text-fg-muted text-pretty">
          No connections yet.{" "}
          <PageLink page="connections" className="text-fg underline-offset-2 hover:underline">
            Connect a service
          </PageLink>
          .
        </p>
      ) : (
        <ul aria-label="Connections" className="flex flex-col gap-0.5">
          {reach.map((c) => (
            <li key={c.id} className="flex min-w-0 items-center gap-3">
              <Switch
                label={c.name}
                checked={!c.agentsOff.includes(agent.id)}
                disabled={update.isPending}
                onChange={(on) => toggle(c.id, c.agentsOff, on)}
              />
              <PageLink
                page="connections"
                search={{ connection: c.id }}
                className="truncate text-sm text-fg-faint underline-offset-2 hover:text-fg hover:underline"
              >
                {scopeName(c.org, orgs)}
              </PageLink>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}
