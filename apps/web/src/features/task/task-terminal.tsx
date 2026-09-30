import type { Task } from "@majhi/shared";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TerminalEvent } from "@/features/terminal/terminal-model";
import { useOpenTaskTerminal } from "@/lib/task-queries";

// xterm is about 300 kB, so it loads only when the Terminal tab first opens.
const TerminalView = lazy(() =>
  import("@/features/terminal/terminal-view").then((m) => ({ default: m.TerminalView })),
);

/**
 * The Terminal tab: a shell in the task folder. Opening it asks for the task's shell, which is the
 * same one while it runs, so leaving the tab and coming back shows the output again.
 */
export function TaskTerminal({ task }: { task: Task }) {
  const open = useOpenTaskTerminal();
  const [terminalId, setTerminalId] = useState<string>();
  const [exitCode, setExitCode] = useState<number>();
  const { mutate } = open;

  const begin = useCallback(() => {
    setExitCode(undefined);
    mutate(task.id, { onSuccess: (opened) => setTerminalId(opened.terminalId) });
  }, [mutate, task.id]);
  useEffect(begin, [begin]);

  const onEvent = useCallback((event: TerminalEvent) => {
    if (event.kind === "exit") setExitCode(event.code);
  }, []);

  if (open.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-base text-fg-soft">{open.error.message}</p>
        <Button onClick={begin}>Try again</Button>
      </div>
    );
  }
  if (terminalId === undefined) return <p className="text-sm text-fg-faint">Opening the terminal</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Suspense fallback={<p className="text-sm text-fg-faint">Opening the terminal</p>}>
        <TerminalView
          key={terminalId}
          terminalId={terminalId}
          onEvent={onEvent}
          label="Task terminal"
          className="min-h-0 flex-1"
        />
      </Suspense>
      {exitCode !== undefined && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-fg-soft">Shell exited (code {exitCode})</p>
          <Button onClick={begin}>New shell</Button>
        </div>
      )}
    </div>
  );
}
