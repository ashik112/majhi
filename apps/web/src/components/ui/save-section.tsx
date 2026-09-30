import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { DetailSection } from "./list-detail";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string; details: readonly string[] };

/**
 * A detail section that edits in place: Cancel and Save show only while it has changes, then a quiet
 * "Saved". Each section keeps its own draft, so saving one never carries another's half-made change.
 */
export function SaveSection({
  title,
  note,
  dirty,
  state,
  onSave,
  onDiscard,
  className,
  children,
}: {
  title: string;
  note?: ReactNode;
  dirty: boolean;
  state: SaveState;
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
  children: ReactNode;
}) {
  const saving = state.kind === "saving";
  return (
    <DetailSection
      title={title}
      {...(note ? { note } : {})}
      {...(className ? { className } : {})}
      actions={
        <>
          <span role="status" aria-live="polite" className="flex items-center gap-1 text-sm text-fg-faint">
            {state.kind === "saved" && !dirty && (
              <>
                <Check aria-hidden="true" className="size-3 text-green" />
                Saved
              </>
            )}
          </span>
          {(dirty || saving) && (
            <>
              <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={saving}
                onClick={onSave}
                aria-label={`Save ${title}`}
              >
                {saving ? "Saving" : "Save"}
              </Button>
            </>
          )}
        </>
      }
    >
      {children}
      {state.kind === "error" && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-red">
          <p className="text-pretty">Could not save: {state.message}</p>
          {state.details.map((d) => (
            <p key={d} className="font-mono">
              {d}
            </p>
          ))}
        </div>
      )}
    </DetailSection>
  );
}
