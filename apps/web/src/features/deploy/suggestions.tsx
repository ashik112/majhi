import type { DeploySuggestion } from "@majhi/shared";
import { Rocket, Triangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { kindLabel } from "./deploy-model";

/** What majhi found in the project: one click adds it when nothing is missing, otherwise the form opens. */
export function Suggestions({
  items,
  busy,
  error,
  onAdd,
  onSetUp,
  onHide,
}: {
  items: readonly DeploySuggestion[];
  busy: boolean;
  error: string | undefined;
  onAdd: (s: DeploySuggestion) => void;
  onSetUp: (s: DeploySuggestion) => void;
  onHide: (s: DeploySuggestion) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Found in the project"
      className="flex min-w-0 flex-col gap-1 border-t border-line pt-3"
    >
      <div className="flex min-h-7 items-center gap-2">
        <h3 className="text-base font-semibold text-fg">Found in the project</h3>
        <span className="font-mono text-sm text-fg-faint tabular-nums">{items.length}</span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((s) => (
          <li
            key={s.id}
            className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-1"
          >
            <div className="flex min-w-0 items-center gap-2 text-base font-medium text-fg">
              {s.kind === "vercel" ? (
                <Triangle aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
              ) : (
                <Rocket aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
              )}
              <span className="shrink-0">{kindLabel(s.kind)}</span>
              <span
                className="min-w-0 truncate font-mono text-sm text-fg-soft"
                title={s.workflow ?? s.project}
              >
                {s.workflow ?? s.project}
              </span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm text-fg-muted">
              <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={s.found}>
                {s.found}
              </span>
              <span className="min-w-0 text-pretty">{s.because}</span>
            </div>
            {s.needs !== undefined && <p className="text-sm text-fg-muted text-pretty">{s.needs}</p>}
            <div className="flex items-center gap-2">
              {s.target === undefined ? (
                <Button size="sm" variant="primary" onClick={() => onSetUp(s)}>
                  Set up
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => onAdd(s)}>
                  Add as {s.env}
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => onHide(s)}>
                Hide
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error !== undefined && (
        <p role="alert" className="text-sm text-red text-pretty">
          {error}
        </p>
      )}
    </section>
  );
}
