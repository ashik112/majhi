import { Link } from "@tanstack/react-router";
import { AgentEmoji } from "@/components/agent-avatar";
import { useAgentIndex } from "@/lib/agent-index";
import type { AppSearch } from "@/router";

/** An agent mention (`@builder`) that opens the agent drawer (`?peek=`). `@owner` stays text. */
export function AgentRef({ id }: { id: string }) {
  const info = useAgentIndex().get(id);
  if (id === "owner" || info === undefined) return <span className="md-mention cursor-default">@{id}</span>;
  return (
    <Link
      to="."
      search={(prev: AppSearch) => ({ ...prev, peek: id })}
      title={`@${id}: ${info.role} on ${info.account}`}
      className="md-mention"
    >
      <AgentEmoji id={id} className="mr-1" />@{id}
    </Link>
  );
}
