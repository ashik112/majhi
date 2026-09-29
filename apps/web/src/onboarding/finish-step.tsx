import type { Task } from "@majhi/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { cmd } from "@/lib/api";
import { useBossChat } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";
import type { OnboardingStepProps } from "./steps";

/** The first thing the boss hears, sent when this step opens. */
export const FIRST_MESSAGE =
  "Hi. I just finished the first setup. Look at what exists and tell me in a few lines what you can set up for me next.";

/**
 * Step 4: finish with the boss. Opens the boss chat with a first message, so the owner sees the
 * boss answer and knows where to find it later (Cmd J).
 */
export function FinishStep({ isLast, onComplete, onSkip }: OnboardingStepProps) {
  const chat = useBossChat();
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-balance">Finish with the boss</h1>
        <p className="text-base text-fg-muted text-pretty">
          Say what you want next. The boss can create orgs, agents and projects for you. Each change waits for
          your approval, and every change can be undone. Open this chat any time with Cmd J.
        </p>
      </div>
      <div className="flex h-[420px] min-h-0 flex-col rounded-xl border border-line-strong bg-raised p-3">
        {chat.isPending && <p className="m-auto text-sm text-fg-faint">Opening the boss chat</p>}
        {chat.isError && <p className="m-auto text-sm text-red">{describeError(chat.error)}</p>}
        {chat.data && <FirstConversation key={chat.data.id} task={chat.data} />}
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={onComplete}>
          {isLast ? "Open majhi" : "Continue"}
        </Button>
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        )}
      </div>
    </>
  );
}

function FirstConversation({ task }: { task: Task }) {
  const room = useRoom(task.id);
  const started = useRef(false);
  const [problem, setProblem] = useState<string>();
  const { loaded, items } = room.state;
  const { dispatch } = room;

  // Once the room is loaded and nobody has spoken, say the first message.
  useEffect(() => {
    if (started.current || !loaded) return;
    started.current = true;
    if (items.some((item) => item.type === "owner")) return;
    cmd("room.send", { task: task.id, text: FIRST_MESSAGE, attachments: [], mode: "queue" }).then(
      ({ item }) => dispatch({ type: "local", item }),
      (error: unknown) => setProblem(describeError(error)),
    );
  }, [loaded, items, task.id, dispatch]);

  return (
    <>
      {problem && (
        <p role="alert" className="text-sm text-red text-pretty">
          {problem}
        </p>
      )}
      <RoomPane task={task} state={room.state} dispatch={room.dispatch} loadOlder={room.loadOlder} />
    </>
  );
}
