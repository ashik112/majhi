import { isClientRoom } from "@majhi/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatRoom } from "@/features/boss/boss-conversation";
import { Conversation } from "@/features/captain/conversation";
import { ClientRoom } from "@/features/clients/client-room";
import { useTask } from "@/lib/task-queries";

/**
 * The conversation under the chips: the owner's captain, a client's chat, or the room of a task, a
 * captain thread or an agent chat. Its own chunk: the room's code is read when a chat first opens.
 */
export default function ChatBody({ id }: { id: string }) {
  if (id === "captain") {
    return (
      <div className="cs-chat-body" style={{ padding: 0 }}>
        <Conversation />
      </div>
    );
  }
  return <TaskRoom key={id} id={id} />;
}

function TaskRoom({ id }: { id: string }) {
  const task = useTask(id);
  if (task.data === undefined) {
    return (
      <div className="cs-chat-body" role="status" aria-busy="true" aria-label="Opening the chat">
        <Skeleton className="h-16 w-2/3 rounded-lg" />
      </div>
    );
  }
  return (
    <div className="cs-chat-body">
      {isClientRoom(task.data) ? <ClientRoom taskId={task.data.id} /> : <ChatRoom task={task.data} />}
    </div>
  );
}
