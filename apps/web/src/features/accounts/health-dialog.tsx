import type { HealthCheck } from "@majhi/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { describeError } from "@/lib/errors";
import { HealthSteps } from "./health-steps";

/** Runs a health check when it opens and shows the steps. `run` must spend no tokens. */
export function HealthDialog({
  title,
  run,
  onClose,
}: {
  title: string;
  run: () => Promise<HealthCheck>;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    { kind: "running" } | { kind: "done"; health: HealthCheck } | { kind: "error"; message: string }
  >({
    kind: "running",
  });
  const started = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;

  const start = () => {
    setState({ kind: "running" });
    runRef.current().then(
      (health) => setState({ kind: "done", health }),
      (error) => setState({ kind: "error", message: describeError(error) }),
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per open; `start` only reads refs
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start();
  }, []);

  return (
    <Modal label={title} onClose={onClose} className="w-[480px]">
      <div className="flex flex-col gap-4 p-5">
        <h2 className="text-md font-semibold">{title}</h2>
        {state.kind === "running" && (
          <p role="status" className="text-base text-fg-muted">
            Checking
          </p>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-base text-red text-pretty">
            {state.message}
          </p>
        )}
        {state.kind === "done" && <HealthSteps health={state.health} />}
        <div className="flex justify-end gap-2">
          <Button onClick={start} disabled={state.kind === "running"}>
            Check again
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
