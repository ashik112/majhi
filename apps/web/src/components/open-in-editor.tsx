import { SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useEditorLabel, useOpenInEditor } from "@/lib/editor-queries";

/**
 * Opens a file, worktree or project folder in the owner's editor. `size="icon-sm"` shows only the
 * icon; any other size adds the text.
 */
export function OpenInEditor({
  path,
  line,
  name,
  size = "sm",
  variant = "secondary",
  className,
}: {
  /** Absolute path on the host. */
  path: string;
  line?: number;
  /** What the path is, for the accessible name of the icon button. */
  name?: string;
  size?: "sm" | "icon-sm";
  variant?: "secondary" | "ghost";
  className?: string;
}) {
  const open = useOpenInEditor();
  const toast = useToast();
  const editor = useEditorLabel();
  const label = `Open ${name ? `${name} ` : ""}in ${editor}`;
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      aria-label={size === "icon-sm" ? label : undefined}
      title={label}
      disabled={open.isPending}
      onClick={() =>
        open.mutate(line === undefined ? { path } : { path, line }, {
          onSuccess: (done) => toast(`Opened in ${editor}`, { detail: done.path }),
          onError: (e) => toast(`Could not open in ${editor}`, { detail: e.message, tone: "error" }),
        })
      }
    >
      <SquareArrowOutUpRight aria-hidden="true" />
      {size === "icon-sm" ? null : `Open in ${editor}`}
    </Button>
  );
}
