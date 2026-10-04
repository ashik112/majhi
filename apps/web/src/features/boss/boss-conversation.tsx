import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { useBossChat } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

/** The room of one task, without the task screen around it. */
export function ChatRoom({ task, takeTyped = false }: { task: Task; takeTyped?: boolean }) {
  const room = useRoom(task.id);
  const [seed] = useState(() => {
    if (!takeTyped) return undefined;
    const typed = typedWhileOpening;
    typedWhileOpening = "";
    return typed;
  });
  return (
    <RoomPane
      task={task}
      state={room.state}
      dispatch={room.dispatch}
      loadOlder={room.loadOlder}
      foldSteps
      initialDraft={seed}
    />
  );
}

/** What the owner typed while the captain chat was opening: the real box takes it over. */
let typedWhileOpening = "";

/** A box that holds keystrokes while the chat opens, so none reach the page behind it. */
function OpeningBox() {
  const [text, setText] = useState(typedWhileOpening);
  return (
    <div className="mt-auto flex flex-col gap-2">
      <p role="status" className="m-auto py-6 text-sm text-fg-faint">
        Opening the captain chat
      </p>
      <textarea
        aria-label="Message the captain"
        rows={2}
        value={text}
        placeholder="Opening. What you type stays here"
        onChange={(e) => {
          typedWhileOpening = e.target.value;
          setText(e.target.value);
        }}
        className="min-h-[52px] w-full resize-none rounded-xl border border-line bg-raised/40 px-3 py-2 text-body text-fg outline-none placeholder:text-fg-faint"
      />
    </div>
  );
}

/**
 * The conversation with the captain: the captain's chat task, opened (and created on first use) through
 * `boss.chat`. Used by the drawer, the Hub setup page and the last onboarding step.
 */
export function BossConversation({ empty }: { empty?: React.ReactNode }) {
  const chat = useBossChat();
  if (chat.isPending) return <OpeningBox />;
  if (chat.isError) {
    return (
      <div className="m-auto flex max-w-[320px] flex-col items-center gap-2 text-center">
        <p className="text-base text-fg-muted text-pretty">{describeError(chat.error)}</p>
        <Link to="/agents" className="text-sm text-blue hover:underline">
          Open Agents
        </Link>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {empty}
      <ChatRoom key={chat.data.id} task={chat.data} takeTyped />
    </div>
  );
}
