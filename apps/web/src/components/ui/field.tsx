import { type ReactNode, useId } from "react";
import { cn } from "@/lib/cn";

/**
 * A label, a control and an optional hint or problem. The control is a render function so it
 * gets the ids that tie label, hint and error to it.
 */
export function Field({
  label,
  hint,
  error,
  warning,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  warning?: string | undefined;
  className?: string;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? warning ?? hint;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm text-fg-faint">
        {label}
      </label>
      {children({
        id,
        "aria-describedby": note ? noteId : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {note && (
        <p
          id={noteId}
          className={cn(
            "break-words text-sm text-pretty",
            error ? "text-red" : warning ? "text-amber" : "text-fg-faint",
          )}
        >
          {note}
        </p>
      )}
    </div>
  );
}
