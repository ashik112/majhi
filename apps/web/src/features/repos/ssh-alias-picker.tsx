import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { useSshHosts } from "@/lib/task-queries";

const NONE = "None: use the URL as it is";

/**
 * The SSH alias of a remote: a Host from the owner's ~/.ssh/config, each with its HostName and
 * key, or none. Another alias can still be typed.
 */
export function SshAliasPicker({
  value,
  onChange,
  suggested,
  fieldProps,
}: {
  value: string;
  onChange: (alias: string) => void;
  /** Aliases the repo's own remotes already use, listed even when the config lacks them. */
  suggested: readonly string[];
  fieldProps: { id: string; "aria-describedby": string | undefined };
}) {
  const hosts = useSshHosts();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();

  const known = hosts.data ?? [];
  const extra = [
    ...new Set([...suggested, value].filter((a) => a !== "" && !known.some((h) => h.alias === a))),
  ];
  const rows = [
    { alias: "", detail: undefined as string | undefined },
    ...known.map((h) => ({
      alias: h.alias,
      detail: [h.hostName, h.identityFile].filter(Boolean).join(" · ") || undefined,
    })),
    ...extra.map((alias) => ({ alias, detail: "Not in your SSH config" })),
  ];

  useEffect(() => {
    if (!open) return;
    // The list opens in the flow of the dialog, which scrolls to show all of it.
    panel.current?.scrollIntoView({ block: "nearest" });
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function pick(alias: string) {
    onChange(alias);
    setOpen(false);
    trigger.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      // Closes the list, not the dialog around it.
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    nodes[(next + nodes.length) % nodes.length]?.focus();
  }

  const current = known.find((h) => h.alias === value);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only relays keys from the list
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        {...fieldProps}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-line-control bg-field px-2.5 text-left text-base text-fg transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none"
      >
        <span className={cn("min-w-0 truncate", value === "" ? "text-fg-muted" : "font-mono")}>
          {value === "" ? NONE : value}
        </span>
        {current?.hostName && (
          <span className="min-w-0 truncate font-mono text-xs text-fg-faint">{current.hostName}</span>
        )}
        <ChevronDown aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div
          ref={panel}
          className="mt-1 flex flex-col rounded-md border border-line-bright bg-card p-1 shadow-pop"
        >
          <div
            id={listId}
            role="listbox"
            aria-label="SSH aliases"
            className="flex max-h-64 flex-col overflow-y-auto"
          >
            {rows.map((row) => (
              <div
                key={row.alias || "none"}
                role="option"
                tabIndex={-1}
                aria-selected={row.alias === value}
                onClick={() => pick(row.alias)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    pick(row.alias);
                  }
                }}
                className={cn(
                  "flex cursor-pointer flex-col rounded-sm px-2.5 py-1.5 hover:bg-raised focus-visible:bg-raised focus-visible:outline-none",
                  row.alias === value && "bg-selected",
                )}
              >
                <span
                  className={cn(
                    "truncate text-base",
                    row.alias === "" ? "text-fg-muted" : "font-mono text-fg",
                  )}
                >
                  {row.alias === "" ? NONE : row.alias}
                </span>
                {row.detail && <span className="truncate font-mono text-xs text-fg-faint">{row.detail}</span>}
              </div>
            ))}
            {hosts.isSuccess && known.length === 0 && (
              <p className="px-2.5 py-1.5 text-xs text-fg-faint">No Host entries in ~/.ssh/config.</p>
            )}
          </div>
          <div className="mt-1 border-t border-line px-1 pt-1.5 pb-0.5">
            <Input
              aria-label="Another SSH alias"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Enter picks the typed alias; it must not submit the dialog's form.
                event.preventDefault();
                if (typed.trim() !== "") pick(typed.trim());
              }}
              placeholder="Another alias, then Enter"
              className="h-8 font-mono text-sm"
            />
          </div>
        </div>
      )}
    </div>
  );
}
