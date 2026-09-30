import type { RoomSearchHit } from "@majhi/shared";
import { cn } from "@/lib/cn";

const WHO: Record<RoomSearchHit["type"], string> = {
  owner: "you",
  agent: "",
  handoff: "handoff",
  system: "system",
  tool: "tool",
};

/** Who said it or what ran: "you", an agent id, or "builder · tool". */
export function hitSource(hit: RoomSearchHit): string {
  const kind = WHO[hit.type];
  if (hit.agent === undefined) return kind;
  return kind === "" ? hit.agent : `${hit.agent} · ${kind}`;
}

/** One match: the task, who wrote it, and the words around the hit with the hit marked. */
export function HitRow({ hit, active }: { hit: RoomSearchHit; active?: boolean }) {
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-fg-muted">{hit.task}</span>
        <span className={cn("min-w-0 truncate text-base", active && "text-fg")}>{hit.taskTitle}</span>
        <span className="ml-auto shrink-0 text-xs text-fg-faint">{hitSource(hit)}</span>
      </span>
      <span className="line-clamp-2 text-sm break-words text-fg-soft">
        {hit.snippet.map((part, i) =>
          part.hit ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a snippet never reorder
            <mark key={i} className="rounded-xs bg-accent/25 text-fg">
              {part.text}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a snippet never reorder
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
    </span>
  );
}
