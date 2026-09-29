import { RESTART_COMMAND } from "@majhi/shared";
import { CircleAlert, RotateCw, Unplug } from "lucide-react";
import { CommandLine } from "@/components/command-line";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import type { ApiRequestError } from "@/lib/api";

/** A request for the page's data failed: the server is down, or it answered with an error. */
export function ServerError({
  error,
  onRetry,
  retrying,
}: {
  error: ApiRequestError;
  onRetry: () => void;
  retrying: boolean;
}) {
  const retry = (
    <div>
      <Button variant="primary" onClick={onRetry} disabled={retrying}>
        <RotateCw aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
        {retrying ? "Retrying" : "Retry"}
      </Button>
    </div>
  );

  if (error.unreachable) {
    return (
      <Problem
        icon={<Unplug />}
        tone="red"
        title="majhi is not responding"
        body="The page loaded, but the server did not answer. If majhi is stopped, start it from the majhi folder, then retry."
      >
        <CommandLine command={RESTART_COMMAND} />
        {retry}
      </Problem>
    );
  }

  return (
    <Problem icon={<CircleAlert />} tone="red" title="majhi could not load this page" body={error.message}>
      {error.details.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-line-strong bg-sunken px-3 py-2.5 font-mono text-sm text-fg-soft">
          {error.details.map((detail) => (
            <li key={detail} className="break-words">
              {detail}
            </li>
          ))}
        </ul>
      )}
      {retry}
    </Problem>
  );
}
