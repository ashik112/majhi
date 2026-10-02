import type { AutonomyStatus, RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Lamp } from "@/components/ui/lamp";
import { Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { looksLikeSecret } from "@/features/boss/model";
import type { OwnerContext } from "@/features/room/owner-cards";
import { Timeline } from "@/features/room/timeline";
import { useRoom } from "@/features/room/use-room";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useAutonomyCommand, useGuideAutonomy } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { MOD_KEY } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useTask } from "@/lib/task-queries";
import { clockTime } from "./model";
import { CardHead } from "./sections";
import { TaskRef } from "./task-ref";

/** A standing instruction holds at most this many characters. */
const INSTRUCTION_MAX = 500;

/**
 * The boss's one autonomy chat, on the right of the page: the conversation as the room shows it,
 * scrolling inside the panel, and a box to write to the boss. Sending goes through
 * `autonomy.guide`; "Keep as standing instruction" also saves it, so every wake-up lists it.
 */
export function ChatPane({ status, className }: { status: AutonomyStatus; className?: string }) {
  const boss = status.boss;
  const chat = boss?.chat;
  return (
    <aside
      aria-label="Boss chat"
      className={cn("flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      <div className="shrink-0 border-b border-line px-4 py-2.5">
        <div className="flex min-h-7 items-center gap-2">
          <h2 className="text-base font-semibold text-fg">Boss chat</h2>
          {chat && <TaskRef task={chat} />}
          {boss && (
            <span className="ml-auto flex min-w-0 items-center gap-1.5 text-sm">
              <Lamp state={boss.working ? "working" : "idle"} size={7} />
              <span className="font-mono text-fg-muted">@{boss.id}</span>
              <span className={boss.working ? "text-lamp-working" : "text-fg-faint"}>
                {boss.working ? "working" : "idle"}
              </span>
            </span>
          )}
        </div>
        <p className="text-xs text-fg-faint text-pretty">
          {chat === undefined
            ? "The boss gets one chat on the first start and keeps it for every run after."
            : status.mode === "off"
              ? "One chat for every run: majhi wakes the boss here each time. While off, you may remove it; the next start makes a new one."
              : "One chat for every run: majhi wakes the boss here each time. It cannot be removed until autonomous mode is off."}
        </p>
      </div>
      {chat ? (
        <ChatLog chat={chat} />
      ) : (
        <p className="m-auto max-w-[240px] text-center text-sm text-fg-faint text-pretty">
          {boss ? "No chat yet. Turn autonomous mode on, or write below." : "There is no boss yet."}
        </p>
      )}
      <ChatBox status={status} />
    </aside>
  );
}

/** The autonomy chat's messages, the room's own timeline, without its composer. */
function ChatLog({ chat }: { chat: string }) {
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
  // Cards that put text in a composer have none here: the chat box below is the boss's guidance.
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
      />
    </div>
  );
}

/** Writes to the boss. Sent with "Keep as standing instruction", it is also kept as one. */
function ChatBox({ status }: { status: AutonomyStatus }) {
  const toast = useToast();
  const guide = useGuideAutonomy();
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(false);
  const typed = text.trim();
  const secret = looksLikeSecret(typed);
  const tooLong = keep && typed.length > INSTRUCTION_MAX;
  const blocked = typed === "" || secret || tooLong || guide.isPending || status.boss === undefined;

  const send = () => {
    if (blocked) return;
    guide.mutate(
      { text: typed, keep },
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
        aria-label="Message to the boss"
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

/** The owner's standing instructions, which every wake-up lists for the boss, each with remove. */
export function InstructionsCard({ status, now }: { status: AutonomyStatus; now: number }) {
  const toast = useToast();
  const forget = useAutonomyCommand("autonomy.forget");
  const list = status.settings.instructions;
  return (
    <Card aria-label="Standing instructions">
      <CardHead title="Standing instructions" count={list.length} />
      {list.length === 0 ? (
        <p className="text-sm text-fg-faint text-pretty">
          None yet. Turn on Keep as standing instruction in the boss chat to add one.
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.map((i) => (
            <li
              key={i.id}
              className="flex min-w-0 items-start gap-2 border-t border-line py-2 first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base text-fg-soft text-pretty">{i.text}</span>
                <time dateTime={i.at} className="tnum text-xs text-fg-faint">
                  {clockTime(i.at, now)}
                </time>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Remove this instruction"
                title="Remove"
                disabled={forget.isPending}
                onClick={() =>
                  forget.mutate(
                    { input: { id: i.id }, reason: "Owner removed a standing instruction" },
                    {
                      onError: (error) =>
                        toast("Could not remove it", { detail: describeError(error), tone: "error" }),
                    },
                  )
                }
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
