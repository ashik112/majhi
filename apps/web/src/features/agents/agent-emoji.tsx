import type { Role } from "@majhi/shared";
import { SmilePlus } from "lucide-react";
import { useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmojiPickerPanel } from "@/components/emoji-picker";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useEditAgent } from "@/lib/studio-queries";

/**
 * The agent's avatar as a button that opens the emoji picker. Picking saves at once through
 * `agents.edit`, which changes only the emoji in the agent's file.
 */
export function AgentEmojiButton({ id, role, emoji }: { id: string; role: Role; emoji: string | undefined }) {
  const edit = useEditAgent();
  const toast = useToast();
  return (
    <EmojiAvatarButton
      id={id}
      role={role}
      emoji={emoji}
      busy={edit.isPending}
      onChange={(value, close) =>
        edit.mutate(
          { id, set: { emoji: value } },
          {
            onSuccess: close,
            onError: (error) =>
              toast(value === null ? "Could not remove the emoji" : "Could not save the emoji", {
                detail: describeError(error),
                tone: "error",
              }),
          },
        )
      }
    />
  );
}

/**
 * An agent avatar that opens the emoji picker on click, with a small smile badge while it has no
 * emoji (and on hover once it has one). `onChange` gets the pick, or null for "Remove emoji", and
 * closes the picker through `close` once the pick is kept.
 */
export function EmojiAvatarButton({
  id,
  role,
  emoji,
  size = 32,
  busy = false,
  onChange,
}: {
  id: string;
  role: Role;
  emoji: string | undefined;
  size?: number;
  busy?: boolean;
  onChange: (emoji: string | null, close: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const pick = (value: string | null) => (value === (emoji ?? null) ? close() : onChange(value, close));
  const label = emoji ? `Change the emoji of @${id}` : `Pick an emoji for @${id}`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group relative shrink-0 cursor-pointer rounded-full"
      >
        <AgentAvatar
          id={id}
          role={role}
          emoji={emoji ?? null}
          size={size}
          decorative
          className={cn("transition-[filter] duration-150 group-hover:brightness-110", busy && "opacity-60")}
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full border border-line-control bg-glass-strong text-fg-muted",
            "transition-opacity duration-150 group-hover:text-fg",
            emoji && !open && "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        >
          <SmilePlus className="size-[11px]" />
        </span>
      </button>
      <EmojiPickerPanel
        open={open}
        onClose={close}
        trigger={trigger}
        label={`Emoji for @${id}`}
        current={emoji}
        busy={busy}
        onPick={pick}
        onRemove={() => pick(null)}
      />
    </>
  );
}
