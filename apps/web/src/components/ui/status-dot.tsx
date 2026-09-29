import { cn } from "@/lib/cn";

const DOT_COLOR = {
  green: "bg-green",
  amber: "bg-amber",
  red: "bg-red",
  coral: "bg-coral",
  violet: "bg-violet",
  neutral: "bg-fg-dim",
} as const;
export type DotTone = keyof typeof DOT_COLOR;

const TEXT_COLOR = {
  green: "text-green",
  amber: "text-amber",
  red: "text-red",
  coral: "text-coral",
  violet: "text-violet",
  neutral: "text-fg-muted",
} as const;
export const toneText = (tone: DotTone): string => TEXT_COLOR[tone];

/** A status dot, 8 px like the design. Color never carries meaning alone: it always sits next to words. */
export function Dot({ tone, size = 8, className }: { tone: DotTone; size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn("inline-block shrink-0 rounded-full", DOT_COLOR[tone], className)}
    />
  );
}
