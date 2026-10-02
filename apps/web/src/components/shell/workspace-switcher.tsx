import { Link } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Layers, Settings2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { OrgBadge } from "@/components/ui/org-badge";
import { type OrgRow, orgRows } from "@/features/shell/model";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { PAGE_PATH } from "@/lib/pages";
import { useOrgs } from "@/lib/studio-queries";
import { useTasks } from "@/lib/task-queries";

function Tile({ row }: { row: OrgRow }) {
  return row.id === undefined ? (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-line-control bg-raised text-fg-soft"
    >
      <Layers className="size-3" strokeWidth={2.25} />
    </span>
  ) : (
    <OrgBadge label={row.badge} color={row.color} size="sm" />
  );
}

function openTitle(row: OrgRow): string {
  return `${row.name}: ${row.open} open ${row.open === 1 ? "task" : "tasks"}`;
}

/**
 * The workspace the app shows, at the top of the sidebar: All, or one workspace, with its open task
 * count. Picking one filters the page the owner is on and stays while they move between pages.
 */
export function WorkspaceSwitcher() {
  const orgs = useOrgs().data;
  const tasks = useTasks().data;
  const { org, setOrg } = useOrgFilter();
  const rows = useMemo(() => orgRows(orgs ?? [], tasks ?? []), [orgs, tasks]);
  const current = rows.find((r) => r.id === org) ?? rows[0];
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const { panel, style, container } = useAnchoredPanel({
    open,
    close,
    trigger,
    matchWidth: true,
    maxHeight: 440,
  });

  useEffect(() => {
    if (!open) return;
    const items = panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]');
    const checked = panel.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
  }, [open, panel]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    nodes[(next + nodes.length) % nodes.length]?.focus();
  }

  if (current === undefined) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Workspace: ${current.name}. Change workspace`}
        title={openTitle(current)}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-md border border-line-strong bg-field pr-2 pl-2 text-left transition-colors duration-150 hover:border-line-hover hover:bg-raised",
          open && "border-line-control bg-selected",
        )}
      >
        <Tile row={current} />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{current.name}</span>
        <span className="tnum shrink-0 font-mono text-sm text-fg-faint">{current.open}</span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-faint" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            id={id}
            role="menu"
            aria-label="Workspaces"
            style={style}
            onKeyDown={onKeyDown}
            className={cn("z-50 flex max-w-[300px] flex-col overflow-y-auto rounded-lg p-1", GLASS_STRONG)}
          >
            {rows.map((row) => {
              const checked = row.id === current.id;
              return (
                <button
                  key={row.id ?? "all"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  title={openTitle(row)}
                  onClick={() => {
                    setOrg(row.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex h-8 min-w-0 shrink-0 cursor-pointer items-center gap-2.5 rounded-sm px-2 text-left text-base hover:bg-raised focus-visible:bg-raised focus-visible:outline-none",
                    checked ? "font-medium text-fg" : "text-fg-soft",
                  )}
                >
                  <Tile row={row} />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="tnum shrink-0 font-mono text-sm text-fg-faint">{row.open}</span>
                  <span aria-hidden="true" className="flex w-3.5 shrink-0 justify-center text-accent-text">
                    {checked && <Check className="size-3.5" strokeWidth={2.5} />}
                  </span>
                </button>
              );
            })}
            <hr className="mx-1 my-1 h-px shrink-0 border-0 bg-line" />
            <Link
              to={PAGE_PATH.orgs}
              role="menuitem"
              onClick={close}
              className="flex h-8 shrink-0 items-center gap-2.5 rounded-sm px-2 text-base text-fg-muted hover:bg-raised hover:text-fg focus-visible:bg-raised focus-visible:outline-none"
            >
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
                <Settings2 className="size-3.5" />
              </span>
              Manage workspaces
            </Link>
          </div>,
          container,
        )}
    </>
  );
}
