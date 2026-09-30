import { cn } from "@/lib/cn";

/**
 * The five task and agent states, one lamp color each, the same everywhere (board, rooms, sidebar).
 * Nothing else uses these colors. The color never carries the meaning alone: words always sit beside it.
 */
export type LampState = "working" | "needs" | "paused" | "done" | "idle";

/** Text in the lamp's color. Idle text uses the faint text color, since the idle lamp is too dim to read. */
export const LAMP_TEXT: Record<LampState, string> = {
  working: "text-lamp-working",
  needs: "text-lamp-needs",
  paused: "text-lamp-paused",
  done: "text-lamp-done",
  idle: "text-fg-faint",
};

export const LAMP_BG: Record<LampState, string> = {
  working: "bg-lamp-working",
  needs: "bg-lamp-needs",
  paused: "bg-lamp-paused",
  done: "bg-lamp-done",
  idle: "bg-lamp-idle",
};

const LAMP_COLOR: Record<LampState, string> = {
  working: "text-lamp-working",
  needs: "text-lamp-needs",
  paused: "text-lamp-paused",
  done: "text-lamp-done",
  idle: "text-lamp-idle",
};

/**
 * A round status lamp. Working breathes, needs-you and paused glow steady, done is a plain lit dot,
 * idle is an unlit ring.
 */
export function Lamp({
  state,
  size = 8,
  className,
}: {
  state: LampState;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        "inline-block shrink-0 rounded-full",
        LAMP_COLOR[state],
        state === "idle" ? "border-[1.5px] border-current" : "bg-current",
        state === "working" && "animate-lamp",
        (state === "needs" || state === "paused") &&
          "shadow-[0_0_0_3px_color-mix(in_oklab,currentColor_16%,transparent),0_0_9px_color-mix(in_oklab,currentColor_55%,transparent)]",
        className,
      )}
    />
  );
}
