import { TASK_TYPE_LABEL, TASK_TYPES, type TaskTyping } from "@majhi/shared";
import { ChevronDown } from "lucide-react";
import type { CSSProperties } from "react";
import { Menu } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useSetType } from "@/lib/task-queries";
import { TYPE_ICON, typeColor, typedBy, typeLabel, UNTYPED_ICON } from "./type-meta";

type Size = "sm" | "md";

const colorOf = (typing: TaskTyping | undefined) => ({ "--tc": typeColor(typing?.type) }) as CSSProperties;

/** The type as a small colored tile with its icon. A picture of the type: the word is in its title. */
export function TypeTile({
  typing,
  size = "md",
  className,
}: {
  typing: TaskTyping | undefined;
  size?: Size;
  className?: string;
}) {
  const Icon = typing === undefined ? UNTYPED_ICON : TYPE_ICON[typing.type];
  return (
    <span
      role="img"
      aria-label={typeLabel(typing)}
      title={`${typeLabel(typing)}, ${typedBy(typing)}`}
      style={colorOf(typing)}
      className={cn(
        "grid shrink-0 place-items-center text-(--tc)",
        "bg-[color-mix(in_srgb,var(--tc)_15%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--tc)_32%,transparent)]",
        size === "sm" ? "size-4 rounded-[5px]" : "size-5 rounded-[6px]",
        className,
      )}
    >
      <Icon aria-hidden="true" className={size === "sm" ? "size-2.5" : "size-3"} strokeWidth={1.8} />
    </span>
  );
}

/**
 * The type as an icon and its word, and one click to change it. The menu lists the eight types; the
 * owner's pick is stored at once and is never overwritten by inference.
 */
export function TypeChip({
  id,
  typing,
  size = "md",
}: {
  id: string;
  typing: TaskTyping | undefined;
  size?: Size;
}) {
  const setType = useSetType();
  const toast = useToast();
  const Icon = typing === undefined ? UNTYPED_ICON : TYPE_ICON[typing.type];
  return (
    <Menu
      label="Change the type"
      align="left"
      items={TASK_TYPES.map((type) => {
        const Item = TYPE_ICON[type];
        return {
          label: TASK_TYPE_LABEL[type],
          checked: typing?.type === type,
          icon: <Item className="size-3.5" style={{ color: typeColor(type) }} strokeWidth={1.8} />,
          onSelect: () => {
            if (typing?.type === type && typing.by === "owner") return;
            setType.mutate(
              { id, type },
              {
                onError: (error) =>
                  toast("Could not change the type", { detail: error.message, tone: "error" }),
              },
            );
          },
        };
      })}
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          {...props}
          title={`${typeLabel(typing)}, ${typedBy(typing)}. Click to change`}
          style={colorOf(typing)}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap text-fg",
            "border border-[color-mix(in_srgb,var(--tc)_34%,transparent)] bg-[color-mix(in_srgb,var(--tc)_10%,transparent)]",
            "hover:border-line-hover focus-visible:outline-2 focus-visible:outline-accent",
            size === "sm"
              ? "h-5 gap-1 rounded-md pr-1.5 pl-1 text-xs"
              : "h-6 gap-1.5 rounded-[7px] pr-2 pl-1.5 text-sm",
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("text-(--tc)", size === "sm" ? "size-2.5" : "size-3.5")}
            strokeWidth={1.8}
          />
          <span className="font-medium">{typeLabel(typing)}</span>
          <ChevronDown aria-hidden="true" className="size-3 text-fg-faint" />
        </button>
      )}
    />
  );
}
