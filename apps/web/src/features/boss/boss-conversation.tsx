import type { Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { RoomPane } from "@/features/room/room-pane";
import { useRoom } from "@/features/room/use-room";
import { useBossChat } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";

/** The room of one task, without the task screen around it. */
export function ChatRoom({ task }: { task: Task }) {
  const room = useRoom(task.id);
  return <RoomPane task={task} state={room.state} dispatch={room.dispatch} loadOlder={room.loadOlder} />;
}

/**
 * The conversation with the boss: the boss's chat task, opened (and created on first use) through
 * `boss.chat`. Used by the drawer, the Hub setup page and the last onboarding step.
 */
export function BossConversation({ empty }: { empty?: React.ReactNode }) {
  const chat = useBossChat();
  if (chat.isPending)
    return (
      <p role="status" className="m-auto text-sm text-fg-faint">
        Opening the boss chat
      </p>
    );
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
      <ChatRoom key={chat.data.id} task={chat.data} />
    </div>
  );
}
