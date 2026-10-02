import type { AutonomyStatus, RoomItem } from "@majhi/shared";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { Textarea } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { looksLikeSecret } from "@/features/boss/model";
import { Markdown } from "@/features/room/markdown";
import { useRoom } from "@/features/room/use-room";
import { useAutonomyCommand, useGuideAutonomy } from "@/lib/autonomy-queries";
import { describeError } from "@/lib/errors";
import { MOD_KEY } from "@/lib/format";
import { clockTime } from "./model";
import { CardHead } from "./sections";
import { TaskRef } from "./task-ref";

/** A standing instruction holds at most this many characters. */
const INSTRUCTION_MAX = 500;

/**
 * The chat box: Ask sends the text to the boss in its autonomy chat; Add as instruction also keeps
 * it as a standing instruction. The boss's latest replies show below it.
 */
export function GuideCard({ status, now }: { status: AutonomyStatus; now: number }) {
  const toast = useToast();
  const guide = useGuideAutonomy();
  const [text, setText] = useState("");
  const typed = text.trim();
  const secret = looksLikeSecret(typed);
  const blocked = typed === "" || secret || guide.isPending;

  const send = (keep: boolean) => {
    if (blocked || (keep && typed.length > INSTRUCTION_MAX)) return;
    guide.mutate(
      { text: typed, keep },
      {
        onSuccess: () => {
          setText("");
          toast(keep ? "Saved as a standing instruction" : "Sent to the boss");
        },
        onError: (error) => toast("Could not send it", { detail: describeError(error), tone: "error" }),
      },
    );
  };

  return (
    <Card aria-label="Guide the boss">
      <CardHead title="Guide the boss" />
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
            send(false);
          }
        }}
        className="resize-none font-sans"
      />
      {secret && (
        <p role="alert" className="text-sm text-red text-pretty">
          This looks like a secret. Keep secrets out of guidance: save it as a secret and name it instead.
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-faint">{MOD_KEY} Enter asks</span>
        <Button
          className="ml-auto"
          disabled={blocked || typed.length > INSTRUCTION_MAX}
          title={
            typed.length > INSTRUCTION_MAX
              ? `An instruction holds at most ${INSTRUCTION_MAX} characters`
              : undefined
          }
          onClick={() => send(true)}
        >
          Add as instruction
        </Button>
        <Button variant="primary" disabled={blocked} onClick={() => send(false)}>
          Ask
        </Button>
      </div>
      {status.boss?.chat && <BossReplies chat={status.boss.chat} boss={status.boss.id} now={now} />}
    </Card>
  );
}

type AgentItem = Extract<RoomItem, { type: "agent" }>;

/** The boss's last three replies in the autonomy chat, newest first. */
function BossReplies({ chat, boss, now }: { chat: string; boss: string; now: number }) {
  const room = useRoom(chat);
  const replies = room.state.items
    .filter((i): i is AgentItem => i.type === "agent" && i.agent === boss && i.text.trim() !== "")
    .slice(-3)
    .reverse();
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2.5">
      <span className="flex items-center gap-2">
        <SectionLabel>Latest replies</SectionLabel>
        <TaskRef task={chat} className="ml-auto" />
      </span>
      {!room.state.loaded ? (
        <RowsSkeleton rows={1} height={40} />
      ) : replies.length === 0 ? (
        <p className="text-sm text-fg-faint">No replies yet.</p>
      ) : (
        replies.map((r) => (
          <div key={r.id} className="flex min-w-0 flex-col gap-1">
            <time dateTime={r.at} className="tnum font-mono text-xs text-fg-faint">
              {clockTime(r.at, now)}
            </time>
            {/* No edge fade: a reply rarely overflows, and the fade would dim its last line. */}
            <div className="max-h-48 overflow-y-auto overscroll-contain text-base">
              <Markdown text={r.text} />
            </div>
          </div>
        ))
      )}
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
        <p className="text-sm text-fg-faint">
          None yet. Add as instruction keeps guidance the boss follows from then on.
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
