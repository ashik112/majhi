import type { Tone } from "@/features/accounts/model";
import { cn } from "@/lib/cn";

const TONE: Record<Tone, string> = {
  green: "bg-green",
  amber: "bg-amber",
  red: "bg-red",
  neutral: "bg-fg-faint",
};

/** A small colored dot. Color never carries meaning alone: pair it with text or pass `title`. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-[7px] shrink-0 rounded-full", TONE[tone], className)}
    />
  );
}

export const TONE_TEXT: Record<Tone, string> = {
  green: "text-green",
  amber: "text-amber",
  red: "text-red",
  neutral: "text-fg-muted",
};
