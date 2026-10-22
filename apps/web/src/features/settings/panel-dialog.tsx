import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { AppSearch } from "@/router";

/** A flag kept in the address (`?rules=true`), so a link can open the dialog it names. */
export function useSearchFlag(name: "rules" | "settings"): [boolean, (on: boolean) => void] {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const set = (on: boolean) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { [name]: _gone, ...rest } = prev;
        return on ? { ...rest, [name]: true } : rest;
      },
      replace: true,
    });
  return [search[name] === true, set];
}

/** An existing Settings panel shown over the page it belongs to (Memory's rules, the Wiki's settings). */
export function PanelDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal label={title} onClose={onClose} className="w-[min(780px,calc(100vw-32px))]">
      <div className="flex max-h-[calc(100dvh-32px)] min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-md font-semibold">{title}</h2>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
          {children}
        </div>
      </div>
    </Modal>
  );
}
