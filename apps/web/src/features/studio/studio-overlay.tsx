import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { STUDIO_TABS, type StudioTab } from "./model";

/** The Studio dialog: a header with the two tabs and a close button, and the tab's content below. */
export function StudioOverlay({ tab, children }: { tab: StudioTab; children: ReactNode }) {
  const navigate = useNavigate();
  const close = () => void navigate({ to: "/" });

  function onTabKeyDown(event: KeyboardEvent) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = STUDIO_TABS.findIndex((t) => t.id === tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = STUDIO_TABS[(index + step + STUDIO_TABS.length) % STUDIO_TABS.length];
    if (next) void navigate({ to: "/studio/$tab", params: { tab: next.id }, search: {} });
  }

  return (
    <Modal
      label="Studio"
      onClose={close}
      className="h-[min(800px,calc(100dvh-32px))] w-[min(1320px,calc(100vw-32px))] flex-col open:flex"
    >
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line-strong pr-3 pl-5">
        <h1 className="text-md font-semibold">Studio</h1>
        <div
          role="tablist"
          aria-label="Studio sections"
          onKeyDown={onTabKeyDown}
          className="flex h-full gap-1"
        >
          {STUDIO_TABS.map((t) => (
            <Link
              key={t.id}
              to="/studio/$tab"
              params={{ tab: t.id }}
              search={{}}
              role="tab"
              id={`studio-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="studio-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={cn(
                "flex h-full items-center border-b-2 px-3.5 text-base transition-colors",
                tab === t.id ? "border-amber text-fg" : "border-transparent text-fg-muted hover:text-fg",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <span className="ml-auto hidden font-mono text-xs text-fg-faint md:block">
          Everything saves to ~/.majhi as plain files
        </span>
        <Button variant="ghost" size="icon" aria-label="Close Studio" onClick={close}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div
        id="studio-panel"
        role="tabpanel"
        aria-labelledby={`studio-tab-${tab}`}
        className="flex min-h-0 flex-1"
      >
        {children}
      </div>
    </Modal>
  );
}
