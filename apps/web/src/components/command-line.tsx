import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useCopy } from "@/lib/use-copy";

/**
 * One line of mono text the owner copies: a shell command (with a `$` prompt) or a file path.
 */
export function CommandLine({
  command,
  prompt = true,
  className,
}: {
  command: string;
  /** Show the `$` prompt. Off for file paths. */
  prompt?: boolean;
  className?: string;
}) {
  const copy = useCopy();
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-2.5 rounded-md border border-line-strong bg-sunken pr-1 pl-3 font-mono text-base",
        className,
      )}
    >
      {prompt && (
        <span aria-hidden="true" className="select-none text-fg-faint">
          $
        </span>
      )}
      <code className="min-w-0 flex-1 truncate text-fg" title={command}>
        {command}
      </code>
      <Button variant="ghost" size="sm" onClick={() => void copy(command)} aria-label={`Copy ${command}`}>
        <Copy aria-hidden="true" />
        Copy
      </Button>
    </div>
  );
}

/** A command inside a sentence, with a small copy button. */
export function InlineCommand({ command }: { command: string }) {
  const copy = useCopy();
  return (
    <span className="inline-flex h-6 items-center rounded-sm border border-line-strong bg-sunken pl-2 align-middle font-mono text-sm text-fg">
      <code>{command}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-0.5 size-[22px] rounded-l-none rounded-r-[5px] [&_svg]:size-3"
        aria-label={`Copy ${command}`}
        title="Copy"
        onClick={() => void copy(command)}
      >
        <Copy aria-hidden="true" />
      </Button>
    </span>
  );
}
