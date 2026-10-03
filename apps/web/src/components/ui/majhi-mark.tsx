import { cn } from "@/lib/cn";

/**
 * majhi's mark: a human (the circle) and an agent (the rounded square) in the same boat. It also
 * reads as a smiling face. One colour, `currentColor`, on a transparent background.
 */
export function MajhiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="28 54 200 172" aria-hidden="true" className={cn("shrink-0", className)} fill="currentColor">
      <circle cx="84" cy="98" r="30" />
      <rect x="142" y="68" width="60" height="60" rx="14" />
      <path d="M28 140 H228 C224 192 182 222 128 222 C74 222 32 192 28 140 Z" />
    </svg>
  );
}
