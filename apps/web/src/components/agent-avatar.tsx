import type { Role } from "@majhi/shared";
import { avatarTone, initialOf } from "@/features/tasks/model";
import { useAgentIndex } from "@/lib/agent-index";
import { cn } from "@/lib/cn";
import { Dot, type DotTone } from "./ui/status-dot";

/** Role colors of the design: Lead violet, Builder amber, Reviewer blue, Tester pink, Root green. */
export const ROLE_BG: Record<Role, string> = {
  Lead: "bg-violet",
  Builder: "bg-amber",
  Reviewer: "bg-blue",
  Tester: "bg-pink",
  Root: "bg-green",
};

/** The role colors as CSS values, for the tinted circle behind an emoji. */
const ROLE_COLOR: Record<Role, string> = {
  Lead: "var(--c-violet)",
  Builder: "var(--c-amber)",
  Reviewer: "var(--c-blue)",
  Tester: "var(--c-pink)",
  Root: "var(--c-green)",
};

/** The system emoji fonts, so an emoji never falls back to a monochrome glyph from IBM Plex. */
export const EMOJI_FONT =
  "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', sans-serif";

/**
 * The one agent avatar: the agent's emoji, or a round initial (the last word of the id) when it has
 * none, in the agent's role color, with an optional state dot on its corner. An emoji sits on a soft
 * wash of the role color with a ring of it, so the emoji's own colors read; the initial sits on the
 * solid color. Role and emoji come from the agents list unless they are passed (`emoji: null` shows
 * the initial). `working` adds a soft pulsing ring. `decorative` hides it from assistive tech when
 * the id is written beside it.
 */
export function AgentAvatar({
  id,
  role,
  emoji,
  working = false,
  size = 20,
  dot,
  ring = "border-card",
  decorative = false,
  className,
}: {
  id: string;
  role?: Role | undefined;
  /** Overrides the agent's own emoji, for previews. `null` shows the initial. */
  emoji?: string | null | undefined;
  working?: boolean;
  size?: number;
  dot?: DotTone | undefined;
  /** Border class of the dot, matching what the avatar sits on. */
  ring?: string;
  decorative?: boolean;
  className?: string;
}) {
  const known = useAgentIndex().get(id);
  const shown = role ?? known?.role;
  const glyph = emoji === undefined ? known?.emoji : (emoji ?? undefined);
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": working ? `${id}, working` : id, title: id } as const);
  const tint = shown ? ROLE_COLOR[shown] : "var(--c-fg-faint)";
  return (
    <span
      {...a11y}
      style={
        glyph
          ? {
              width: size,
              height: size,
              // Big enough to read on an 18px card avatar, small enough to stay inside the ring.
              fontSize: Math.round(size * (size <= 22 ? 0.72 : 0.62)),
              lineHeight: 1,
              fontFamily: EMOJI_FONT,
              background: `color-mix(in srgb, ${tint} 24%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 55%, transparent)`,
            }
          : { width: size, height: size, fontSize: size <= 22 ? 10 : Math.round(size * 0.39) }
      }
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        !glyph && "text-canvas",
        !glyph && (shown ? ROLE_BG[shown] : avatarTone(id)),
        className,
      )}
    >
      {glyph ?? initialOf(id)}
      {working && (
        <span
          aria-hidden="true"
          className="absolute -inset-[3px] animate-shimmer rounded-full border-2 border-lamp-working"
        />
      )}
      {dot && (
        <Dot
          tone={dot}
          size={size >= 34 ? 12 : 10}
          className={cn("absolute -right-0.5 -bottom-0.5 border-2", ring)}
        />
      )}
    </span>
  );
}

/**
 * The agent's emoji as inline text, for rows that write "@name" without an avatar. Nothing when the
 * agent has none, so those rows stay as they were. Hidden from assistive tech: the name follows it.
 */
export function AgentEmoji({ id, className }: { id: string; className?: string }) {
  const emoji = useAgentIndex().get(id)?.emoji;
  if (!emoji) return null;
  return (
    <span
      aria-hidden="true"
      style={{ fontFamily: EMOJI_FONT }}
      className={cn("shrink-0 leading-none", className)}
    >
      {emoji}
    </span>
  );
}
