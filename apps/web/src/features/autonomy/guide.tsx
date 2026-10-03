import type { AutonomyStatus, RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { looksLikeSecret } from "@/features/boss/model";
import type { OwnerContext } from "@/features/room/owner-cards";
import { Timeline } from "@/features/room/timeline";
import { useRoom } from "@/features/room/use-room";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useGuideAutonomy } from "@/lib/autonomy-queries";
import { describeError } from "@/lib/errors";
import { MOD_KEY } from "@/lib/format";
import { useTask } from "@/lib/task-queries";

/** A standing instruction holds at most this many characters. */
const INSTRUCTION_MAX = 500;

/** A workspace thread's messages, the room's own timeline, without its composer. */
export function ChatLog({ chat }: { chat: string }) {
  const room = useRoom(chat);
  const task = useTask(chat).data;
  const toast = useToast();
  const answer = useMutation<{ item: RoomItem }, ApiRequestError, { item: string; option: string }>({
    mutationFn: (input) => cmd("room.permission", { task: chat, ...input }),
    onSuccess: ({ item }) => room.dispatch({ type: "local", item }),
    onError: (error) => toast("Could not answer", { detail: error.message, tone: "error" }),
  });
  const onPermission = useCallback(
    (item: string, option: string) => answer.mutate({ item, option }),
    [answer.mutate],
  );
  // Cards that put text in a composer have none here: the chat box below is the captain's guidance.
  const owner = useMemo<OwnerContext | undefined>(
    () => (task === undefined ? undefined : { task, compose: () => {} }),
    [task],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-1">
      <Timeline
        state={room.state}
        onLoadOlder={room.loadOlder}
        onPermission={onPermission}
        answering={answer.isPending ? answer.variables?.item : undefined}
        task={{ id: chat, folder: task?.folder ?? "" }}
        owner={owner}
        foldSteps
      />
    </div>
  );
}

/** Writes to the captain. Sent with "Keep as standing instruction", it is also kept as one. */
export function ChatBox({ status, lane }: { status: AutonomyStatus; lane: string | undefined }) {
  const toast = useToast();
  const guide = useGuideAutonomy();
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(false);
  const typed = text.trim();
  const secret = looksLikeSecret(typed);
  const tooLong = keep && typed.length > INSTRUCTION_MAX;
  const blocked =
    typed === "" || secret || tooLong || guide.isPending || status.boss === undefined || lane === undefined;

  const send = () => {
    if (blocked) return;
    guide.mutate(
      { text: typed, keep, ...(lane === undefined ? {} : { org: lane }) },
      {
        onSuccess: () => {
          setText("");
          setKeep(false);
          if (keep) toast("Sent, and kept as a standing instruction");
        },
        onError: (error) => toast("Could not send it", { detail: describeError(error), tone: "error" }),
      },
    );
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
      <Textarea
        aria-label="Message to the captain"
        rows={3}
        maxLength={2000}
        value={text}
        placeholder="Ask what it is doing, or tell it what to favour"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        className="resize-none font-sans"
      />
      {secret && (
        <p role="alert" className="text-sm text-red text-pretty">
          This looks like a secret. Save it as a secret and name it instead.
        </p>
      )}
      {tooLong && (
        <p role="alert" className="text-sm text-red text-pretty">
          A standing instruction holds at most {INSTRUCTION_MAX} characters.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Switch label="Keep as standing instruction" checked={keep} onChange={setKeep} />
        <Button
          variant="primary"
          className="ml-auto"
          disabled={blocked}
          title={`Send (${MOD_KEY} Enter)`}
          onClick={send}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
