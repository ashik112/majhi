import { CornerDownRight, Lock, MoveRight } from "lucide-react";
import { Lamp } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import type { LiveState } from "./entry-text";
import { idList, type Relation } from "./home-model";

const CHIP =
  "inline-flex h-[22px] max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-xs whitespace-nowrap text-fg-muted";

/** The other task and what it is doing now: its lamp and a word. A task the board does not draw has neither. */
function Live({ id, live }: { id: string; live: ReadonlyMap<string, LiveState> }) {
  const state = live.get(id);
  return (
    <>
      <span className="font-mono text-fg-soft">{id}</span>
      {state !== undefined && (
        <>
          <Lamp state={state.lamp} size={6} />
          <span className="min-w-0 truncate">{state.word}</span>
        </>
      )}
    </>
  );
}

/**
 * How a task connects to others, as small dashed chips: what it waits on, what waits on it, and the
 * task it follows up. `only` limits them to "waits": a card shows that one, the tree all three.
 */
export function RelationChips({
  rel,
  live,
  only,
  className,
}: {
  rel: Relation | undefined;
  live: ReadonlyMap<string, LiveState>;
  only?: "waits";
  className?: string;
}) {
  if (rel === undefined) return null;
  const waits = rel.waitsOn.length > 0;
  const blocks = only === undefined && rel.blocks.length > 0;
  const follows = only === undefined && rel.followUpOf !== undefined;
  if (!waits && !blocks && !follows) return null;
  const first = rel.waitsOn[0];
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {waits && first !== undefined && (
        <span
          title={`Waits on ${rel.waitsOn.join(", ")}`}
          className={cn(CHIP, "border-dashed border-line-control")}
        >
          <CornerDownRight aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
          Waits on
          {rel.waitsOn.length === 1 ? (
            <Live id={first} live={live} />
          ) : (
            <span className="font-mono text-fg-soft">{idList(rel.waitsOn)}</span>
          )}
        </span>
      )}
      {follows && rel.followUpOf !== undefined && (
        <span
          title={`Follow-up of ${rel.followUpOf}`}
          className={cn(CHIP, "border-dashed border-line-control")}
        >
          <MoveRight aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
          Follow-up of
          <Live id={rel.followUpOf} live={live} />
        </span>
      )}
      {blocks && (
        <span
          title={`${rel.blocks.join(", ")} waits on this`}
          className={cn(CHIP, "border-line-strong bg-raised")}
        >
          <Lock aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
          Blocks
          <span className="font-mono text-fg-soft">{idList(rel.blocks)}</span>
        </span>
      )}
    </span>
  );
}
