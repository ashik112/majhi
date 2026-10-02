import { Check, Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useCopy } from "@/lib/use-copy";

/** A copy button that turns into a check for a moment once the text is on the clipboard. */
export function CopyButton({
  value,
  label,
  className,
  size = "sm",
}: {
  value: string;
  /** What is copied, read out by screen readers: "Copy the code". */
  label: string;
  className?: string;
  size?: ButtonProps["size"];
}) {
  const copy = useCopy();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size={size}
      className={className}
      aria-label={label}
      onClick={() => {
        void copy(value).then(() => setCopied(true));
      }}
    >
      {copied ? <Check aria-hidden="true" className="text-green" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A labeled value to paste into another site's form, with its copy button. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 rounded-md border border-line bg-field px-3 py-1.5">
      <span className="w-[150px] shrink-0 text-sm text-fg-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-base text-fg" title={value}>
        {value}
      </span>
      <CopyButton value={value} label={`Copy ${label}`} className="-mr-1.5" />
    </div>
  );
}

/** A link to another site, styled as a button. Opens in a new tab: the owner signs in there. */
export function ExternalButton({
  href,
  children,
  variant = "secondary",
  size = "md",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLink aria-hidden="true" />
      </a>
    </Button>
  );
}

/** A small "live" pulse for something majhi is waiting on, always beside its words. */
export function Waiting({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span role="status" className={cn("flex items-center gap-2.5 text-base text-fg-soft", className)}>
      <span aria-hidden="true" className="relative flex size-2.5 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-40 motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
      </span>
      {children}
    </span>
  );
}

/** "14:32" until a time, for a code that expires. */
export function countdown(until: string, now: number): string {
  const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A checkbox drawn to match the glass: a native input for keyboard and screen readers, a box with
 * a check over it. `label` names it when the visible text sits elsewhere in the row.
 */
export function Tick({
  checked,
  disabled,
  label,
  onChange,
  className,
  id,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  id?: string;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-[18px] shrink-0", className)}>
      <input
        type="checkbox"
        id={id}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none flex size-full items-center justify-center rounded-[5px] border transition-colors duration-150",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
          checked ? "border-accent bg-accent text-accent-ink" : "border-line-bright bg-field",
          disabled && "opacity-45",
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
    </span>
  );
}
