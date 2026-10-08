import { ATTACHMENT_ACCEPT, type AutonomyStatus, type RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentChips, DropHint } from "@/components/ui/attachment-chips";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useBoss } from "@/features/boss/boss-context";
import { looksLikeSecret } from "@/features/boss/model";
import { composerKey } from "@/features/room/model";
import { ModelPicker } from "@/features/room/model-picker";
import type { OwnerContext } from "@/features/room/owner-cards";
import { Timeline } from "@/features/room/timeline";
import { useRoom } from "@/features/room/use-room";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useGuideAutonomy } from "@/lib/autonomy-queries";
import { describeError } from "@/lib/errors";
import { useTask } from "@/lib/task-queries";
import { attachmentIds, filesFromClipboard, useAttachments, useFileDrop } from "@/lib/use-attachments";

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

/**
 * Writes to the captain. Enter sends, Shift Enter adds a line; files and images attach by button,
 * paste or drop, and the model is picked like in a room. Sent with "Keep as standing instruction",
 * the text is also kept as one.
 */
export function ChatBox({
  status,
  lane,
  chat,
}: {
  status: AutonomyStatus;
  lane: string | undefined;
  /** The lane's chat, when it exists: the model picker changes that chat's captain. */
  chat?: string | undefined;
}) {
  const toast = useToast();
  const guide = useGuideAutonomy();
  const task = useTask(chat).data;
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();
  const { dragging, dropProps } = useFileDrop(attachments.add);
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(false);
  const { draft, takeDraft } = useBoss();
  useEffect(() => {
    if (draft === undefined) return;
    setText(draft);
    takeDraft();
  }, [draft, takeDraft]);
  const typed = text.trim();
  const secret = looksLikeSecret(typed);
  const tooLong = keep && typed.length > INSTRUCTION_MAX;
  const hasContent = typed !== "" || attachmentIds(attachments.items).length > 0;
  const blocked =
    !hasContent ||
    attachments.uploading ||
    secret ||
    tooLong ||
    (keep && typed === "") ||
    guide.isPending ||
    status.boss === undefined ||
    lane === undefined;

  const send = () => {
    if (blocked) return;
    const sentFiles = attachments.items;
    guide.mutate(
      {
        text: typed,
        keep,
        attachments: attachmentIds(sentFiles),
        ...(lane === undefined ? {} : { org: lane }),
      },
      {
        onSuccess: () => {
          setText("");
          setKeep(false);
          attachments.clear();
          if (keep) toast("Sent, and kept as a standing instruction");
        },
        onError: (error) => toast("Could not send it", { detail: describeError(error), tone: "error" }),
      },
    );
  };

  return (
    <div {...dropProps} className="relative flex shrink-0 flex-col gap-2 border-t border-line p-3">
      {dragging && <DropHint />}
      <AttachmentChips items={attachments.items} onRemove={attachments.remove} />
      <div className="flex items-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Attach a file or image"
          title="Attach a file or image"
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip aria-hidden="true" />
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            attachments.add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Textarea
          aria-label="Message to the captain"
          rows={2}
          maxLength={2000}
          value={text}
          placeholder="Ask what it is doing, or tell it what to favour"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            const action = composerKey(e.nativeEvent, { popupOpen: false, busy: false, hasContent });
            if (action === "send" || action === "interrupt") {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const pasted = filesFromClipboard(e.clipboardData);
            if (pasted.length === 0) return;
            e.preventDefault();
            attachments.add(pasted);
          }}
          className="min-w-0 flex-1 resize-none font-sans"
        />
      </div>
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Switch label="Keep as standing instruction" checked={keep} onChange={setKeep} />
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {task && status.boss && <ModelPicker task={task} agent={status.boss.id} />}
          <Button
            variant="primary"
            className="shrink-0"
            disabled={blocked}
            title="Send (Enter)"
            onClick={send}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
