import type { HealthCheck } from "@majhi/shared";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { stepLabel } from "./model";

/** The steps of a health check with what each found. Shown for accounts and agents alike. */
export function HealthSteps({ health, className }: { health: HealthCheck; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className={cn("text-base font-medium", health.ok ? "text-green" : "text-red")}>
        {health.ok ? "Health check passed" : "Health check failed"}
        {health.durationMs > 0 && (
          <span className="font-mono text-sm font-normal text-fg-faint">
            {" · "}
            {formatDuration(health.durationMs)}
          </span>
        )}
      </p>
      <ul aria-label="Health check steps" className="flex flex-col gap-1">
        {health.steps.map((step) => (
          <li key={step.name} className="flex items-start gap-2 text-base">
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                step.ok ? "bg-green-wash text-green" : "bg-red-wash text-red",
              )}
            >
              {step.ok ? (
                <Check className="size-3" strokeWidth={2.5} />
              ) : (
                <X className="size-3" strokeWidth={2.5} />
              )}
            </span>
            <span className="min-w-0">
              <span className="text-fg-soft">
                {stepLabel(step.name)}
                <span className="sr-only">{step.ok ? ", passed" : ", failed"}</span>
              </span>
              <span className="block text-sm break-words text-fg-faint">{step.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
