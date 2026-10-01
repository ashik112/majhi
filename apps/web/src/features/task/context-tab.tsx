import type { AgentLive, Task } from "@majhi/shared";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskReceiptView } from "@/features/usage/receipt-view";
import { describeError } from "@/lib/errors";
import { useAgents } from "@/lib/studio-queries";
import { useTaskReceipt } from "@/lib/usage-queries";
import { ContextMeter } from "./agent-row";
import { contextMeter } from "./model";

/** How an attachment reaches the team, in a few words. */
function attachmentUse(a: Task["attachments"][number]): string {
  if (a.kind === "link")
    return a.error !== undefined ? `Not fetched: ${a.error}` : "Fetched and summarized once";
  if (a.kind === "image") return "Sent with the first message";
  return "Named by path in the brief";
}

/**
 * The Context tab (SPEC 3.1, 5.13): what the team was given, where its tokens went, the skills in
 * play and how full each agent's context is.
 */
export function ContextTab({ task, agents }: { task: Task; agents: readonly AgentLive[] }) {
  const receipt = useTaskReceipt(task.id);
  const entries = useAgents();
  const team = task.team;
  const skills = (entries.data ?? []).flatMap((e) =>
    e.status === "ok" && team.includes(e.agent.frontmatter.id)
      ? e.agent.frontmatter.skills.map((skill) => ({ skill, agent: e.agent.frontmatter.id }))
      : [],
  );
  return (
    <section
      aria-label="Context of this task"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto pr-1 pb-6 scroll-fade"
    >
      <div className="flex flex-col gap-2">
        <SectionLabel>Context used</SectionLabel>
        <ul aria-label="Context of each agent" className="m-0 flex list-none flex-col gap-2 p-0">
          {team.map((id) => {
            const meter = contextMeter(agents.find((a) => a.agent === id)?.usage);
            return (
              <li key={id} className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-3 text-base">
                <span className="truncate font-mono">@{id}</span>
                {meter ? (
                  <ContextMeter share={meter.share} label={meter.label} agent={id} />
                ) : (
                  <span className="text-fg-faint">No reading yet</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>Token receipt</SectionLabel>
        {receipt.isError && <p className="m-0 text-sm text-red">{describeError(receipt.error)}</p>}
        {receipt.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
        {receipt.data && <TaskReceiptView receipt={receipt.data} />}
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>Attachments</SectionLabel>
        {task.attachments.length === 0 ? (
          <p className="m-0 text-base text-fg-muted">None.</p>
        ) : (
          <ul aria-label="Attachments given to the team" className="m-0 flex list-none flex-col gap-1 p-0">
            {task.attachments.map((a) => (
              <li key={a.id} className="flex items-baseline gap-2 text-base">
                <span className="min-w-0 truncate">{a.url ?? a.name}</span>
                <span className="shrink-0 text-sm text-fg-faint">{attachmentUse(a)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>Skills in play</SectionLabel>
        {skills.length === 0 ? (
          <p className="m-0 text-base text-fg-muted">
            None. Only a skill's name and description load until an agent uses it.
          </p>
        ) : (
          <ul aria-label="Skills of the team" className="m-0 flex list-none flex-col gap-1 p-0">
            {skills.map((s) => (
              <li key={`${s.agent}-${s.skill}`} className="flex items-baseline gap-2 text-base">
                <span>{s.skill}</span>
                <span className="font-mono text-sm text-fg-faint">@{s.agent}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
